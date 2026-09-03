-- ============================================================
-- 唯讀。未來 12 個月大概收得到多少、押金什麼時候要退多少。
--
-- 2026-09-03 使用者：「我接下來每月現金可以收多少 / 請從收款那邊抓 /
--   然後押金退還會是什麼時候要多少 / 讓我了解金流需求」
--
-- 【錢從哪裡抓的】
--
--   長租租金    `orders` source in (longterm, company, office)、paid = false
--               ★ 這就是契約頁「收租」在收的那些月租單，
--                 由 gen_contract_orders 依契約租期產生
--   短租住宿    `orders` source in (airbnb, agoda, private, partner)、paid = false
--   一次性／加費 `orders` source in (oneoff, airbnb_cancelled)、paid = false
--   押金收取    `deposits` received_on is null（還沒收進來的）
--   押金退還    `deposits` received_on 有、returned_on 沒有（收了還沒退的）→ **流出**
--
-- ============================================================
-- 【★★★ 收款的月份不是租的月份 —— 安幸是預繳制】
--
-- 7 月的租金 6 月收。所以每一張月租單要歸到**應繳日**那個月，
-- 不是 checkin 那個月。算法照 `src/lib/due-date.ts`：
--
--     第 i 期應繳日 = （第 i 期的第一個月 − 1 個月）的「幾號」
--     「幾號」＝ pay_day，沒設就取首繳日的日數
--
-- ★★ 季繳／半年繳／年繳是**整期一次收**。三個月的月租單共用同一個應繳日，
--   所以那一個月會看到一大筆，而後面兩個月是 0 —— 那是對的，不是漏算。
--
-- ★ 算不出應繳日的（沒有 pay_day 也沒有首繳日）**不會被丟掉**，
--   單獨列在表 4。那些錢是真的，只是時間不知道。
--
-- ============================================================
-- 【★★★ 這份不是預測，是「已經在系統裡的」】
--
--   會少算：還沒訂的短租、還沒簽的新約、續約之後的月份
--   會多算：會退租的、收不到的、有折讓還沒登記的
--
-- 短租那一段特別要小心 —— 未來三個月的 Airbnb 訂單現在大概只訂了一半，
-- 所以短租那一欄**離現在越遠越低**，那是資料的形狀不是生意變差。
--
-- 【怎麼跑】整份貼進 Supabase SQL Editor，五張表都看。
-- ============================================================


-- ══════════════════════════════════════════════════════════
-- 表 0：母體 —— 先確認有東西可查
-- ★ 母體是 0 的話下面每一張都是空表，而空表看起來跟「都收完了」
--   一模一樣（2026-09-03 才踩過一次）。
-- ══════════════════════════════════════════════════════════
select v.ord, v."檢查", v."結果", v."判定" from (

  select 1, '生效中的契約',
         (select count(*)::text from public.contracts
           where active and end_date >= current_date),
         case when (select count(*) from public.contracts
                     where active and end_date >= current_date) = 0
              then '⚠ 一張都沒有 —— 下面的長租那一欄不算數'
              else '✅' end

  union all
  select 2, '未收的長租月租單（含逾期）',
         (select count(*)::text || ' 筆・$'
                 || coalesce(sum(amount), 0)::text
            from public.orders
           where source in ('longterm','company','office') and not paid),
         case when (select count(*) from public.orders
                     where source in ('longterm','company','office') and not paid) = 0
              then '⚠ 一筆都沒有 —— 表 1 的長租欄會整欄 0'
              else '✅' end

  union all
  select 3, '收了還沒退的押金',
         (select count(*)::text || ' 筆・$' || coalesce(sum(amount), 0)::text
            from public.deposits
           where received_on is not null and returned_on is null),
         case when (select count(*) from public.deposits
                     where received_on is not null and returned_on is null) = 0
              then '⚠ 一筆都沒有 —— 表 2、表 3 會是空的'
              else '✅ 這是總負債，不是這 12 個月要退的' end

  union all
  -- ★★ 這一列是「這份報表信不信得過」的關鍵。算不出應繳日的越多，
  --   表 1 的長租欄就越不完整
  select 4, '★★ 算不出應繳日的契約（沒 pay_day 也沒首繳日）',
         (select count(*)::text from public.contracts
           where active and end_date >= current_date
             and coalesce(nullif(pay_day, 0), 0) not between 1 and 31
             and first_payment_date is null),
         case when (select count(*) from public.contracts
                     where active and end_date >= current_date
                       and coalesce(nullif(pay_day, 0), 0) not between 1 and 31
                       and first_payment_date is null) = 0
              then '✅ 每一張都排得進月份'
              else '⚠ 這幾張的錢在表 4，沒有算進表 1' end

) v(ord, "檢查", "結果", "判定") order by v.ord;


-- ══════════════════════════════════════════════════════════
-- 表 1：逐月現金流（未來 12 個月）
-- ══════════════════════════════════════════════════════════
with
-- ── 未來 12 個月的月初 ───────────────────────────────────────
mon as (
  select generate_series(
           date_trunc('month', current_date),
           date_trunc('month', current_date) + interval '11 months',
           interval '1 month')::date as m
),

-- ── 長租：每一張未收的月租單推它的應繳日 ────────────────────
lt as (
  select o.id, o.amount, o.checkin, c.id as contract_id,
         c.cadence,
         -- ★ 幾號繳：pay_day 優先，沒有就取首繳日的日數（resolvePayDay）
         coalesce(
           case when c.pay_day between 1 and 31 then c.pay_day end,
           extract(day from c.first_payment_date)::int
         ) as pay_day,
         c.start_date,
         case c.cadence when 'quarterly' then 3 when 'halfyear' then 6
                        when 'yearly' then 12 else 1 end as step
    from public.orders o
    join public.contracts c on c.id = o.contract_id
   where o.source in ('longterm','company','office')
     and not o.paid
),
lt2 as (
  select lt.*,
         -- 這張月租單落在第幾期（0 起算）
         floor((
           (extract(year from lt.checkin)::int * 12 + extract(month from lt.checkin)::int)
         - (extract(year from lt.start_date)::int * 12 + extract(month from lt.start_date)::int)
         )::numeric / lt.step)::int as idx
    from lt
),
lt3 as (
  select lt2.*,
         -- 應繳月 ＝ 該期第一個月 − 1 個月（預繳制）
         (date_trunc('month', lt2.start_date)
          + (lt2.idx * lt2.step - 1) * interval '1 month')::date as due_month
    from lt2
   where lt2.idx >= 0
),
lt4 as (
  select lt3.*,
         case when lt3.pay_day is null then null else
           -- ★ 31 號遇到 2 月要夾到當月最後一天，不能溢位到下個月
           (lt3.due_month + (least(
              lt3.pay_day,
              extract(day from (lt3.due_month + interval '1 month - 1 day'))::int
            ) - 1) * interval '1 day')::date
         end as due_date
    from lt3
),

-- ── 短租與一次性：用 checkin 當收款時點 ──────────────────────
-- ★ 平台實際撥款時間各不相同（Airbnb 入住後才撥）。
--   用 checkin 是**最保守可推**的時點，看的時候心裡要記得會晚幾天
st as (
  select date_trunc('month', checkin)::date as m,
         sum(case when source in ('airbnb','agoda','private','partner')
                  then amount else 0 end) as short_amt,
         sum(case when source in ('oneoff','airbnb_cancelled')
                  then amount else 0 end) as fee_amt
    from public.orders
   where not paid
     and source in ('airbnb','agoda','private','partner','oneoff','airbnb_cancelled')
     and checkin >= date_trunc('month', current_date)
   group by 1
),

-- ── 押金收取：還沒收進來的 ──────────────────────────────────
-- ★ 時點取契約起租日／訂單入住日 —— 押金是進場前收的
dep_in as (
  select date_trunc('month',
           coalesce(c.start_date, o.checkin, d.created_at::date))::date as m,
         sum(d.amount) as amt
    from public.deposits d
    left join public.contracts c on c.id = d.contract_id
    left join public.orders    o on o.id = d.order_id
   where d.received_on is null
     and not d.orphaned
     and coalesce(c.start_date, o.checkin, d.created_at::date)
         >= date_trunc('month', current_date)
   group by 1
),

-- ── 押金退還：收了還沒退的 ──────────────────────────────────
/*
 * ★★★ 退款日三段退回：
 *     1. planned_refund_on  已經排了匯款日 —— 最準
 *     2. 契約 end_date      約滿退 —— 推算的
 *     3. 訂單 checkout      短租退房退 —— 推算的
 *   都沒有的就排不進月份，列在表 3 讓人看。
 *
 * ★★ auto_renew 的契約 end_date 會一直往後 —— 用它推出來的退款日
 *   每次續約都會改。那不是這份報表的錯，但看的時候要知道。
 */
dep_out as (
  select date_trunc('month',
           coalesce(d.planned_refund_on, c.end_date, o.checkout))::date as m,
         sum(d.amount) as amt
    from public.deposits d
    left join public.contracts c on c.id = d.contract_id
    left join public.orders    o on o.id = d.order_id
   where d.received_on is not null and d.returned_on is null
     and not d.orphaned
     and coalesce(d.planned_refund_on, c.end_date, o.checkout)
         >= date_trunc('month', current_date)
   group by 1
),

rent as (
  select date_trunc('month', due_date)::date as m, sum(amount) as amt
    from lt4
   where due_date >= date_trunc('month', current_date)
   group by 1
),

joined as (
  select mon.m,
         coalesce(rent.amt, 0)       as 長租租金,
         coalesce(st.short_amt, 0)   as 短租住宿,
         coalesce(st.fee_amt, 0)     as 一次性加費,
         coalesce(dep_in.amt, 0)     as 押金收取,
         coalesce(dep_out.amt, 0)    as 押金退還
    from mon
    left join rent    on rent.m    = mon.m
    left join st      on st.m      = mon.m
    left join dep_in  on dep_in.m  = mon.m
    left join dep_out on dep_out.m = mon.m
)
select to_char(m, 'YYYY/MM')                       as 月份,
       長租租金,
       短租住宿,
       一次性加費,
       押金收取,
       -- ★ 負號印出來。放在「收」那一欄旁邊的正數會被加進去看
       (0 - 押金退還)                               as 押金退還,
       (長租租金 + 短租住宿 + 一次性加費 + 押金收取 - 押金退還) as 淨現金,
       sum(長租租金 + 短租住宿 + 一次性加費 + 押金收取 - 押金退還)
         over (order by m)                          as 累計
  from joined
 order by m;


-- ══════════════════════════════════════════════════════════
-- 表 2：押金退還明細 —— 誰、多少、什麼時候、日期是實填還是推算
-- ★★★ 「推算」那些是**用契約迄日猜的**，不是有人排過的匯款日。
--   續約就會往後移，退租就會提前 —— 拿去排現金要知道這件事。
-- ══════════════════════════════════════════════════════════
select to_char(coalesce(d.planned_refund_on, c.end_date, o.checkout), 'YYYY/MM') as 預計月份,
       coalesce(d.planned_refund_on, c.end_date, o.checkout) as 預計退款日,
       case when d.planned_refund_on is not null then '✅ 已排匯款日'
            when c.end_date is not null then
              case when c.auto_renew then '⚠ 用契約迄日推的（會自動續約，日期會往後）'
                   else '⚠ 用契約迄日推的' end
            when o.checkout is not null then '⚠ 用退房日推的'
            else '❌ 排不出日期' end                        as 日期怎麼來的,
       d.amount                                            as 金額,
       coalesce(d.guest_name, c.tenant_name, o.guest_name, '—') as 房客,
       coalesce(es.name, '—')                              as 物業,
       coalesce(d.room, c.room, '—')                       as 房源,
       d.refund_status                                     as 退款狀態,
       d.received_on                                       as 當初收款日
  from public.deposits d
  left join public.contracts c  on c.id = d.contract_id
  left join public.orders    o  on o.id = d.order_id
  left join public.estates   es on es.id = d.estate_id
 where d.received_on is not null and d.returned_on is null
   and not d.orphaned
 order by coalesce(d.planned_refund_on, c.end_date, o.checkout) nulls last, d.amount desc;


-- ══════════════════════════════════════════════════════════
-- 表 3：排不進月份的 —— 錢是真的，時間不知道
-- ★★★ 這張表不能空著不看。這些金額**沒有**出現在表 1，
--   只看表 1 就會漏掉它們。
-- ══════════════════════════════════════════════════════════
select v.ord, v."項目", v."筆數", v."金額", v."要做什麼" from (

  -- 逾期未收：過去的月租單還沒收。錢會進來，但不知道哪個月
  -- ★ 這裡**不 join contracts** —— join 了的話沒接到契約的那些會被丟掉，
  --   而那正是第 3 列要抓的東西。同一個母體用兩種問法就會互相矛盾
  select 1, '逾期未收的長租租金（應繳日已過）',
         (select count(*)::text from public.orders o
           where o.source in ('longterm','company','office') and not o.paid
             and o.checkin < date_trunc('month', current_date)),
         '$' || coalesce((select sum(o.amount)::text from public.orders o
                          where o.source in ('longterm','company','office') and not o.paid
                            and o.checkin < date_trunc('month', current_date)), '0'),
         '★ 這些沒有算進表 1。要嘛去催，要嘛是誤標成未收'

  union all
  select 2, '★★ 算不出應繳日的月租單（契約沒 pay_day 也沒首繳日）',
         (select count(*)::text from public.orders o
            join public.contracts c on c.id = o.contract_id
           where o.source in ('longterm','company','office') and not o.paid
             and (c.pay_day is null or c.pay_day not between 1 and 31)
             and c.first_payment_date is null),
         '$' || coalesce((select sum(o.amount)::text from public.orders o
                           join public.contracts c on c.id = o.contract_id
                          where o.source in ('longterm','company','office') and not o.paid
                            and (c.pay_day is null or c.pay_day not between 1 and 31)
                            and c.first_payment_date is null), '0'),
         '★★★ 這是表 1 少掉的那一截。去契約補「幾號繳」就會自己歸位'

  union all
  select 3, '未收但沒接到契約的月租單',
         (select count(*)::text from public.orders
           where source in ('longterm','company','office')
             and not paid and contract_id is null),
         '$' || coalesce((select sum(amount)::text from public.orders
                           where source in ('longterm','company','office')
                             and not paid and contract_id is null), '0'),
         '★ 沒有契約就推不出應繳日，也不在表 1 裡'

  union all
  select 4, '收了還沒退、但排不出退款日的押金',
         (select count(*)::text from public.deposits d
            left join public.contracts c on c.id = d.contract_id
            left join public.orders    o on o.id = d.order_id
           where d.received_on is not null and d.returned_on is null
             and not d.orphaned
             and coalesce(d.planned_refund_on, c.end_date, o.checkout) is null),
         '$' || coalesce((select sum(d.amount)::text from public.deposits d
                           left join public.contracts c on c.id = d.contract_id
                           left join public.orders    o on o.id = d.order_id
                          where d.received_on is not null and d.returned_on is null
                            and not d.orphaned
                            and coalesce(d.planned_refund_on, c.end_date, o.checkout) is null), '0'),
         '★ 這筆負債遲早要付。沒有日期就沒辦法排現金'

  union all
  select 5, '退款日已經過了但還沒退的押金',
         (select count(*)::text from public.deposits d
            left join public.contracts c on c.id = d.contract_id
            left join public.orders    o on o.id = d.order_id
           where d.received_on is not null and d.returned_on is null
             and not d.orphaned
             and coalesce(d.planned_refund_on, c.end_date, o.checkout) < current_date),
         '$' || coalesce((select sum(d.amount)::text from public.deposits d
                           left join public.contracts c on c.id = d.contract_id
                           left join public.orders    o on o.id = d.order_id
                          where d.received_on is not null and d.returned_on is null
                            and not d.orphaned
                            and coalesce(d.planned_refund_on, c.end_date, o.checkout) < current_date), '0'),
         '★★ 隨時可能要付。不在表 1 裡，但它是**現在**的義務'

) v(ord, "項目", "筆數", "金額", "要做什麼") order by v.ord;


-- ══════════════════════════════════════════════════════════
-- 表 4：長租逐月明細 —— 表 1 那一欄是誰湊出來的
-- ★ 表 1 某個月特別高或特別低時看這張。季繳／年繳那幾張
--   會讓某一個月一次跳很多，這裡看得到是哪一份約。
-- ══════════════════════════════════════════════════════════
with lt as (
  select o.id, o.amount, o.checkin, o.property_raw,
         c.tenant_name, c.display_name, c.cadence, c.start_date,
         coalesce(
           case when c.pay_day between 1 and 31 then c.pay_day end,
           extract(day from c.first_payment_date)::int) as pay_day,
         case c.cadence when 'quarterly' then 3 when 'halfyear' then 6
                        when 'yearly' then 12 else 1 end as step
    from public.orders o
    join public.contracts c on c.id = o.contract_id
   where o.source in ('longterm','company','office') and not o.paid
),
lt2 as (
  select lt.*, floor((
           (extract(year from lt.checkin)::int * 12 + extract(month from lt.checkin)::int)
         - (extract(year from lt.start_date)::int * 12 + extract(month from lt.start_date)::int)
         )::numeric / lt.step)::int as idx
    from lt
),
lt3 as (
  select lt2.*,
         (date_trunc('month', lt2.start_date)
          + (lt2.idx * lt2.step - 1) * interval '1 month')::date as due_month
    from lt2 where lt2.idx >= 0
),
lt4 as (
  select lt3.*,
         case when lt3.pay_day is null then null else
           (lt3.due_month + (least(lt3.pay_day,
              extract(day from (lt3.due_month + interval '1 month - 1 day'))::int
            ) - 1) * interval '1 day')::date end as due_date
    from lt3
)
select to_char(due_date, 'YYYY/MM')                    as 應繳月,
       min(due_date)                                   as 應繳日,
       coalesce(display_name, property_raw, tenant_name, '（未命名）') as 房客,
       case cadence when 'monthly' then '月繳' when 'quarterly' then '季繳'
                    when 'halfyear' then '半年繳' when 'yearly' then '年繳'
                    else cadence end                   as 繳別,
       count(*)                                        as 幾個月的租,
       sum(amount)                                     as 這期要收
  from lt4
 where due_date >= date_trunc('month', current_date)
   and due_date <  date_trunc('month', current_date) + interval '12 months'
 group by to_char(due_date, 'YYYY/MM'), display_name, property_raw, tenant_name, cadence
 order by 1, 6 desc;
