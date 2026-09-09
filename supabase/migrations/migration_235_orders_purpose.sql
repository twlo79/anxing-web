/*
 * migration_235 —— 收入也有「用途」，安幸辦公室不再是假物業
 * ============================================================
 * 2026-09-09。承 `claude/收支模型檢視-2026-09-08.md` 的淺版。
 *
 * ============================================================
 * 【★★★ 問題：收入側少了一個軸】
 *
 * 支出用**兩個欄位**講「這筆錢屬於誰」:
 *     purpose_type  estate / office / other_biz
 *     estate_id     哪一個物業
 *
 * 收入只有 `estate_id`，沒有 purpose_type。於是「不是向房客收的錢」
 * 每出現一種就挪用一次 `source`:
 *     第一次 → office（辦公室出租）
 *     第二次 → company（公司登記）
 *     第三次 → 房務收入。而它**是一次性收入**，做成 source 等於說它不是
 *
 * 我 migration_228 的解法是建一個名叫「安幸辦公室」的**假物業**，
 * 後果是:用途下拉出現兩個同名選項、營收「依物業」多出一個不是物業的物業、
 * 而 234 把它停用之後又變成「一個掛著停用卻每月收 69 筆錢的物業」。
 *
 * ★★★ 現在是修它最便宜的時刻:**還沒有任何一筆資料指著那個假物業**
 *   （八月的產生收支還沒按過）。晚一步就要搬 69 筆訂單。
 *
 * ============================================================
 * 【★★ `source='office'` 跟 `purpose_type='office'` 是兩個東西】
 *
 *   source='office'        辦公室**出租** —— 安幸把辦公室租給別人的租金
 *   purpose_type='office'  安幸辦公室    —— 安幸自己（總部）
 *
 * 名字撞在一起是既有的事實，這支不改名（改名要動十幾個地方）。
 * 但底下每一處判斷都寫清楚在講哪一個。
 *
 * ============================================================
 * 【★★★ 回填只動 office / company，其餘一律 estate】
 *
 * `inEstateBlock` 現在是 `!isOffice && !isCompany` ——
 * 也就是說 `source='other'` 那些**現在是算在依物業裡的**。
 * 把它們一起改成 other_biz 的話報表數字會變，而那是另一個決定。
 *
 * ★ 這支的目標是「換一條路判斷，數字一毛不變」。
 *   自檢第 ③ 條就是拿改前改後的物業小計對。
 *
 * 【怎麼跑】整份貼進 Supabase SQL Editor，看最後那張自檢表。
 */

begin;

-- ── ① 訂單加用途 ──────────────────────────────────
alter table public.orders
  add column if not exists purpose_type text not null default 'estate';

alter table public.orders drop constraint if exists orders_purpose_chk;
alter table public.orders add constraint orders_purpose_chk
  check (purpose_type in ('estate', 'office', 'other_biz'));

/*
 * 回填。**只有這兩種 source** —— 它們本來就不掛物業房源，
 * 營收報表也早就把它們排除在依物業之外。
 */
update public.orders
   set purpose_type = 'office'
 where source in ('office', 'company')
   and purpose_type <> 'office';

-- ── ② 認列表也要有，畫面讀的是它 ──────────────────
alter table public.revenue_recognitions
  add column if not exists purpose_type text;

-- ── ③ gen_recognitions 帶過去 ─────────────────────
/*
 * ★★ 整份重寫，跟 migration_230 那一份**一字不差**，只多帶 purpose_type。
 *   第 10 行那條「長租且掛在契約上的直接 return」不能掉 ——
 *   掉了長租認列會被產生兩次，營收翻倍。自檢第 ② 條釘它。
 */
create or replace function public.gen_recognitions(o orders)
 returns void
 language plpgsql
 security definer
as $function$
declare
  ms date; me date; n int; ename text; pname text;
  last_ms date; acc numeric := 0; amt numeric;
begin
  -- 長租且掛在契約上的:認列由 gen_contract_recognitions 依契約產生
  -- ★★★ 這一條不能刪 —— 刪掉的話長租的認列會被產生兩次，營收翻倍
  if o.source = 'longterm' and o.contract_id is not null then return; end if;

  select e.name into ename from estates e where e.id = o.estate_id;
  select p.name into pname from properties p where p.id = o.property_id;
  pname := coalesce(pname, o.property_raw);

  if o.source in ('oneoff', 'airbnb_cancelled') then
    if o.checkin is null or o.amount is null then return; end if;
    ms := date_trunc('month', o.checkin)::date;
    insert into revenue_recognitions(order_id, ym, period_start, period_end, source, estate_id, property_id,
      estate_name, property_raw, guest_name, checkin, checkout, total_amount, total_nights, month_nights, month_amount, fee_type,
      item_name, purpose_type)   -- ★ migration_235 新增 purpose_type
    values (o.id, to_char(o.checkin,'YYYYMM'), ms, (ms + interval '1 month')::date, 'oneoff', o.estate_id, o.property_id,
      ename, pname, o.guest_name, o.checkin, o.checkout, o.amount, coalesce(o.nights,0), 0, o.amount, coalesce(o.fee_type,'取消費'),
      o.item_name, o.purpose_type);
    return;
  end if;

  if o.checkin is null or o.checkout is null or o.nights is null or o.nights <= 0 then return; end if;
  last_ms := date_trunc('month', o.checkout - 1)::date;
  ms := date_trunc('month', o.checkin)::date;
  while ms < o.checkout loop
    me := (ms + interval '1 month')::date;
    n := greatest(0, least(o.checkout, me) - greatest(o.checkin, ms));
    if n > 0 then
      if ms = last_ms then amt := o.amount - acc;
      else amt := trunc(o.amount * n / o.nights); acc := acc + amt; end if;
      insert into revenue_recognitions(order_id, ym, period_start, period_end, source, estate_id, property_id,
        estate_name, property_raw, guest_name, checkin, checkout, total_amount, total_nights, month_nights, month_amount, fee_type,
        item_name, purpose_type)
      values (o.id, to_char(ms,'YYYYMM'), greatest(o.checkin, ms), least(o.checkout, me),
        case when o.source = 'partner' then 'airbnb' else o.source end,
        o.estate_id, o.property_id,
        ename, pname, o.guest_name, o.checkin, o.checkout, o.amount, o.nights, n, amt, null,
        null, o.purpose_type);   -- ★ 項目長租沒有；用途照帶
    end if;
    ms := me;
  end loop;
end $function$;

-- ── ④ 回填既有的認列列 ────────────────────────────
/*
 * ★ 不重跑 rebuild_recognitions() —— 那支會整張刪掉重建，
 *   而契約認列那一批是 gen_contract_recognitions 寫的，重建之後不會回來
 *   （migration_230 同一個理由）。
 */
update public.revenue_recognitions r
   set purpose_type = o.purpose_type
  from public.orders o
 where o.id = r.order_id
   and r.purpose_type is distinct from o.purpose_type;

-- 契約產生的那些沒有對應 orders 列的，補成 estate（它們就是物業租金）
update public.revenue_recognitions
   set purpose_type = 'estate'
 where purpose_type is null;

-- ── ⑤ 假物業與假房源：真的刪掉 ────────────────────
/*
 * ★★★ 刪之前先確認**沒有東西指著它**。有的話整支中止 ——
 *   刪出孤兒比留著假物業糟得多。
 */
do $do$
declare
  v_est uuid; v_prop uuid; n_ord int; n_exp int; n_pr int;
begin
  select id into v_est from public.estates where name = '安幸辦公室';
  if v_est is null then
    raise notice '找不到假物業，可能已經刪過 —— 跳過';
    return;
  end if;
  select id into v_prop from public.properties
   where name = '安幸辦公室' and estate_id = v_est;

  select count(*) into n_ord from public.orders
   where estate_id = v_est or property_id = v_prop;
  select count(*) into n_exp from public.expenses
   where estate_id = v_est or property_id = v_prop;
  select count(*) into n_pr from public.purchase_request_items
   where estate_id = v_est;

  if n_ord + n_exp + n_pr > 0 then
    raise exception '還有東西指著假物業（訂單 % 筆、支出 % 筆、請款項目 % 筆）—— 整支中止，不製造孤兒',
      n_ord, n_exp, n_pr;
  end if;

  if v_prop is not null then delete from public.properties where id = v_prop; end if;
  delete from public.estates where id = v_est;
  raise notice '假物業與假房源已刪除';
end $do$;

do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('235_orders_purpose');
  end if;
end $do$;

commit;


-- ══════════════════════════════════════════════════════════
-- 自檢　★ 字串比對一律 ilike
-- ══════════════════════════════════════════════════════════
select v.ord, v."檢查", v."結果", v."判定" from (

  select 1, '① orders.purpose_type 的分布',
         coalesce((select string_agg(purpose_type || '×' || n::text, '　' order by purpose_type)
                     from (select purpose_type, count(*) n from public.orders
                            group by purpose_type) g), '（沒有訂單）'),
         case when (select count(*) from public.orders where purpose_type is null) = 0
              then '✅ 每一筆都有用途' else '❌ 有 null' end

  union all
  select 2, '②★★★ 長租契約那條 early return 還在',
         case when (select prosrc from pg_proc where proname = 'gen_recognitions')
                   ilike '%o.contract_id is not null then return%' then '在' else '不見了' end,
         case when (select prosrc from pg_proc where proname = 'gen_recognitions')
                   ilike '%o.contract_id is not null then return%'
              then '✅ 過' else '❌ 抄漏了 —— 長租營收會翻倍，立刻回滾' end

  union all
  /*
   * ★★★ 這支的目標是「換一條路判斷，數字一毛不變」。
   *   舊路:source 不是 office/company
   *   新路:purpose_type = 'estate'
   *   兩邊算出來的筆數必須一模一樣。
   */
  select 3, '③★★★ 新舊兩種判斷法算出來的「依物業」筆數要一樣',
         (select '舊法 ' || count(*) filter (where source not in ('office','company'))::text
                 || ' 筆　新法 ' || count(*) filter (where purpose_type = 'estate')::text || ' 筆'
            from public.revenue_recognitions),
         case when (select count(*) filter (where source not in ('office','company'))
                         = count(*) filter (where purpose_type = 'estate')
                      from public.revenue_recognitions)
              then '✅ 一樣 —— 報表數字不會變'
              else '❌ 不一樣 —— 換路會改到營收數字，先查清楚再推前端' end

  union all
  select 4, '④ 認列表的用途分布',
         coalesce((select string_agg(coalesce(purpose_type,'(null)') || '×' || n::text, '　' order by 1)
                     from (select purpose_type, count(*) n from public.revenue_recognitions
                            group by purpose_type) g), '（沒有認列）'),
         case when (select count(*) from public.revenue_recognitions where purpose_type is null) = 0
              then '✅ 沒有 null' else '❌ 有 null —— 那幾筆會從所有分段裡消失' end

  union all
  select 5, '⑤★★★ 假物業與假房源都不見了',
         (select '物業 ' || (select count(*) from public.estates where name = '安幸辦公室')::text
                 || ' 筆　房源 ' || (select count(*) from public.properties where name = '安幸辦公室')::text || ' 筆'),
         case when (select count(*) from public.estates where name = '安幸辦公室') = 0
               and (select count(*) from public.properties where name = '安幸辦公室') = 0
              then '✅ 刪乾淨了'
              else '❌ 還在 —— 上面那段 do 區塊中止了，看 notice 說什麼' end

  union all
  select 6, '⑥ 現在啟用的物業（用途下拉會長這樣）',
         coalesce((select string_agg(name, '、' order by sort, name)
                     from public.estates where active), '（沒有）'),
         '👀 裡面不該有「安幸辦公室」'

  union all
  select 7, '⑦ 這一支有沒有被記錄',
         coalesce((select max(name) from public.schema_migrations
                    where name = '235_orders_purpose'), '（沒記到）'),
         case when exists (select 1 from public.schema_migrations
                            where name = '235_orders_purpose')
              then '✅' else '❌ record_migration 沒寫進去' end

) v(ord, "檢查", "結果", "判定") order by v.ord;
