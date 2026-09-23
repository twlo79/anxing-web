/* ══════════════════════════════════════════════════════════════════════
 * migration_298  月租單金額從「每期金額」拆，餘數放每期最後一個月            2026-09-23
 *
 * 【為什麼】年繳契約的第 1 期應收跟契約差 ±4 元（8A3 多 4、8A5 少 4）
 *
 *   存契約時   monthly_rent = round(amount_per_period ÷ 12)      ← 餘數丟掉
 *   產月租單   一個月一張，金額 = monthly_rent                    ← 拿丟掉餘數的去乘
 *   收款頁     第 1 期應收 = 12 張相加 = monthly_rent × 12         ← 對不回契約
 *
 *   CLAUDE.md 那條坑：推導值（monthly_rent）存成欄位，然後另一條路把它當真相讀。
 *   線上 6 張年繳契約如此（10A3、14A2、7A3、8A3、8A5、9A3），差 ±3～4 元。
 *
 * 【這支做什麼】重新定義 gen_contract_orders()：
 *   · 整支從 migration_135 逐字抄，只改金額那幾行（本體 md5 f4955411… 抄自 archive）
 *   · 前 step−1 個月 = round(per ÷ step)（＝現在存的月租，既有月份金額**不動**）
 *   · 每期最後一個月 = per − 前面合計（吸收餘數）
 *   · 月繳完全不受影響（step = 1）
 *   · 然後對所有非月繳的啟用契約重跑一次 —— 已收的月租單照舊不碰（函式本來就這樣）
 *
 * 【★★ 先確認線上那支就是 135】自檢第 2 列比對函式本體的三個記號。
 *   不是的話，代表有一支沒進 repo 的 migration 改過它 —— 停下來，不要跑。
 *   （這支本身用 create or replace，跑了就會蓋掉。）
 *
 * 【不動的】已收的月租單、月繳契約、前端（表單提示另外改）。
 *
 * ★★ 自檢在 commit 後面 —— 看不到那張表就是整支回滾了。
 * ══════════════════════════════════════════════════════════ */

begin;

-- 守衛：線上的函式要長得像 135（有這三個記號），不然停
do $$
declare t text;
begin
  -- 空白壓成一格再比對 —— 135 那行是對齊過的多個空白，pg_get_functiondef 會原樣吐回來
  select regexp_replace(pg_get_functiondef('public.gen_contract_orders(public.contracts)'::regprocedure), '\s+', ' ', 'g') into t;
  if position('contract_order_conflicts' in t) = 0
     or position('starts := starts || p_start' in t) = 0
     or position('full_n' in t) = 0 then
    raise exception '線上的 gen_contract_orders 不是 migration_135 那一版 —— 停下來，先查是哪一支改過它';
  end if;
end $$;

create or replace function public.gen_contract_orders(ct contracts)
returns void language plpgsql as $fn$
declare
  p_start date; p_end date; full_end date;
  n int; full_n int;
  lease_end date;                    -- 排他的租期結束 = end_date + 1
  total numeric := 0; acc numeric := 0; amt numeric;
  periods int := 0; idx int := 0;
  starts date[] := '{}';
  ymtxt text; k text;
  v_id uuid; v_paid boolean;
  /* ── migration_298：每期金額拆到各月，餘數放每期最後一個月 ── */
  step int;            -- 一期幾個月：月繳 1、季繳 3、半年 6、年繳 12
  per  numeric;        -- 契約寫的每期金額（真相）
  base numeric;        -- 這一個月的整月金額（未按天數比例之前）
  mi   int := 0;       -- 第幾個月（從 0 起），mi % step = 在這一期裡的位置
begin
  /*
   * 房號空白的契約一律跳過 —— 那些是**辦公室登記 / 公司登記**
   * （使用者確認，2026-08-16），本來就不屬於某一間房。
   * 它們走 `LTC_{契約id}_`，由前端契約頁產生（見 lib/ltKey.keyBase）。
   *
   * 原本只擋 `ct.room is null`，擋不掉空字串 —— 於是這支會組出
   * `LT__202510` 去插，撞上另一套產生器已經開好的單。
   * 兩套產生器對同一份契約動手，就是那個 23505 的由來。
   */
  if ct.room is null or btrim(ct.room) = '' then return; end if;
  if ct.start_date is null or ct.end_date is null then return; end if;

  if not ct.active or ct.monthly_rent is null or ct.monthly_rent <= 0 then
    delete from orders
     where contract_id = ct.id and imported_via = 'contract' and paid = false;
    return;
  end if;

  lease_end := (ct.end_date + 1)::date;   -- end_date 是含當日

  /*
   * ★★★ 月租單的金額要從「契約寫的每期金額」拆，不是拿四捨五入過的月租去乘（migration_298）。
   *
   *   存契約時 monthly_rent = round(amount_per_period ÷ step) —— 餘數在這裡丟掉了。
   *   年繳 1,867,576 → 月租 155,631 → 12 張加起來 1,867,572，**每一期少 4 元**，
   *   而房客照契約付 1,867,576。反過來的契約則每期多掛 4 元未收。線上 6 張契約如此。
   *
   *   規則：前 step−1 個月 = round(per ÷ step)（跟現在存的月租一樣，既有月份金額不動），
   *         每期最後一個月 = per − 前面的合計（吸收餘數，最多 ±(step−1) 元）。
   *   月繳 step = 1 → 每個月就是 per 本身，跟以前完全一樣。
   *
   * ★ amount_per_period 空著的舊契約退回用 monthly_rent × step —— 行為跟 135 一樣。
   */
  step := case ct.cadence when 'quarterly' then 3 when 'halfyear' then 6 when 'yearly' then 12 else 1 end;
  per  := coalesce(nullif(ct.amount_per_period, 0), ct.monthly_rent::numeric * step);

  -- ── 第一趟：期間與總額 ──
  p_start := ct.start_date;
  while p_start < lease_end loop
    full_end := (p_start + interval '1 month')::date;
    p_end    := least(full_end, lease_end);
    n        := p_end - p_start;
    full_n   := full_end - p_start;
    if n > 0 then
      base := case when (mi % step) = step - 1
                   then per - round(per / step) * (step - 1)    -- 這一期最後一個月：吸收餘數
                   else round(per / step) end;
      -- 足月就整額;不足月按天數比例（只有最後一期可能不足月）
      total    := total + (case when n = full_n then base else base * n / full_n end);
      periods  := periods + 1;
      starts   := starts || p_start;
    end if;
    mi := mi + 1;
    p_start := full_end;
  end loop;
  total := round(total);
  mi := 0;   -- 第二趟要用同一個月序

  /*
   * 清掉不在目標期間的自動單（未收款的才刪）。
   * 同時處理:租期改短多出來的、起日移動之後讓位的、
   * 以及「月中起租多一期」那個老 bug 留下的尾巴。
   */
  delete from orders
   where contract_id = ct.id and imported_via = 'contract' and paid = false
     and not (checkin = any(starts));

  -- ── 第二趟：寫入 ──
  p_start := ct.start_date;
  while p_start < lease_end loop
    full_end := (p_start + interval '1 month')::date;
    p_end    := least(full_end, lease_end);
    n        := p_end - p_start;
    full_n   := full_end - p_start;
    if n > 0 then
      idx := idx + 1;
      base := case when (mi % step) = step - 1
                   then per - round(per / step) * (step - 1)
                   else round(per / step) end;
      if idx = periods then
        amt := total - acc;                        -- 租期最後一個月：整份租約的餘數
      else
        amt := trunc(case when n = full_n then base else base * n / full_n end);
        acc := acc + amt;
      end if;

      -- 鍵用 checkin 的年月組。週期期間各自落在不同的日曆月，鍵不會重複
      ymtxt := to_char(p_start, 'YYYYMM');
      k     := 'LT_' || ct.room || '_' || ymtxt;

      /*
       * 同一個月如果有重複的自動單（歷史遺留），先清掉多的只留一張。
       * 留的優先順序:已收款的優先 —— 那張上面掛著收款紀錄與發票。
       */
      delete from orders o
       where o.contract_id = ct.id and o.imported_via = 'contract' and not o.paid
         and o.checkin >= date_trunc('month', p_start)::date
         and o.checkin <  (date_trunc('month', p_start) + interval '1 month')::date
         and o.id <> (select x.id from orders x
                       where x.contract_id = ct.id and x.imported_via = 'contract'
                         and x.checkin >= date_trunc('month', p_start)::date
                         and x.checkin <  (date_trunc('month', p_start) + interval '1 month')::date
                       order by x.paid desc, x.checkin limit 1);

      /*
       * 用**日曆月**找對應的那一列，不用精確 checkin ——
       * checkin 正在從 07-01 移到 07-16，拿移動後的值去找移動前的列永遠找不到。
       */
      select o.id, o.paid into v_id, v_paid
        from orders o
       where o.contract_id = ct.id and o.imported_via = 'contract'
         and o.checkin >= date_trunc('month', p_start)::date
         and o.checkin <  (date_trunc('month', p_start) + interval '1 month')::date
       limit 1;

      if v_id is not null then
        /*
         * 有這一期。
         *
         * **checkin / checkout / nights 一定要一起更新** ——
         * 認列是 gen_recognitions 照 checkin/checkout 拆的,
         * 只改金額不改期間的話認列還是落在錯的月份。
         *
         * `not v_paid` 是刻意的:已收款的單這支永遠不碰。
         * 那些要改的話走 migration_136 —— 而**金額不會變**,
         * 所以那一步比原本的計畫安全得多。
         */
        if not v_paid then
          delete from orders o
           where o.order_key = k and o.imported_via = 'contract'
             and not o.paid and o.id <> v_id;

          if exists (select 1 from orders o where o.order_key = k and o.id <> v_id) then
            -- 鍵被一張刪不掉的單佔著 → 保留原鍵，只改期間與金額。
            -- 鍵不漂亮但資料是對的;硬要改名就是整支炸掉
            update orders
               set amount = amt, guest_name = ct.tenant_name, estate_id = ct.estate_id,
                   property_raw = ct.room, checkin = p_start, checkout = p_end, nights = n
             where id = v_id;
          else
            update orders
               set order_key = k, amount = amt, guest_name = ct.tenant_name,
                   estate_id = ct.estate_id, property_raw = ct.room,
                   checkin = p_start, checkout = p_end, nights = n
             where id = v_id;
          end if;
        end if;

      else
        delete from orders o
         where o.order_key = k and o.imported_via = 'contract' and not o.paid;

        if exists (select 1 from orders o where o.order_key = k) then
          insert into public.contract_order_conflicts
            (contract_id, room, ym, want_start, want_end, want_amount, blocked_by_key, seen_at)
          values (ct.id, ct.room, ymtxt, p_start, p_end, amt, k, clock_timestamp())
          on conflict (contract_id, ym) do update
            set want_start = excluded.want_start, want_end = excluded.want_end,
                want_amount = excluded.want_amount, seen_at = excluded.seen_at;
        else
          insert into orders (order_key, source, estate_id, property_raw, guest_name,
            checkin, checkout, nights, amount, deposit, note, imported_via, contract_id, paid)
          values (k, 'longterm', ct.estate_id, ct.room, ct.tenant_name,
            p_start, p_end, n, amt, 0, '契約應收', 'contract', ct.id, false);
        end if;
      end if;
    end if;
    mi := mi + 1;
    p_start := full_end;
  end loop;
end $fn$;


-- 對所有非月繳的啟用契約重跑（已收的不碰）
do $$
declare c public.contracts; n int := 0;
begin
  for c in select * from public.contracts where active and cadence <> 'monthly' loop
    perform public.gen_contract_orders(c); n := n + 1;
  end loop;
  raise notice '重跑 % 張非月繳契約', n;
end $$;

do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('298_contract_period_remainder');
  end if;
end $do$;

commit;

-- 自檢（在 commit 後面 —— 看不到就是整支回滾了）
with step as (
  select c.*, case c.cadence when 'quarterly' then 3 when 'halfyear' then 6 when 'yearly' then 12 else 1 end as n
    from public.contracts c
   where c.active and c.amount_per_period is not null and c.cadence <> 'monthly'
     and c.room is not null and btrim(c.room) <> ''
),
-- 每張契約：未收的月租單，照 step 一期一期加總，跟每期金額比
chk as (
  select s.id, s.n, s.amount_per_period,
         (select count(*) from public.orders o where o.contract_id = s.id and o.imported_via = 'contract' and not o.paid) as unpaid_n,
         (select coalesce(sum(o.amount), 0) from public.orders o
           where o.contract_id = s.id and o.imported_via = 'contract' and not o.paid) as unpaid_sum
    from step s
)
select 1 as 序, '這支跑過了沒' as 檢查,
       (select count(*)::text from public.schema_migrations where name = '298_contract_period_remainder') as 結果,
       case when exists (select 1 from public.schema_migrations where name = '298_contract_period_remainder') then '✅' else '❌' end as 判定
union all select 2, '函式本體有沒有換成新版（含 migration_298 記號）',
       case when position('migration_298' in pg_get_functiondef('public.gen_contract_orders(public.contracts)'::regprocedure)) > 0 then '有' else '沒有' end,
       case when position('migration_298' in pg_get_functiondef('public.gen_contract_orders(public.contracts)'::regprocedure)) > 0 then '✅' else '❌' end
union all select 3, '★ 未收月租單的張數是不是每期月數的整數倍（整期整期地未收）',
       (select count(*)::text from chk c where c.unpaid_n % c.n <> 0),
       case when (select count(*) from chk c where c.unpaid_n % c.n <> 0) = 0
            then '✅ 每張的未收都是完整的期' else '⚠ 有契約未收張數不是整期 —— 第 4 列的比對對那幾張不成立' end
union all select 4, '★★★ 未收合計 ＝ 每期金額 × 未收期數（餘數回來了沒）',
       (select count(*)::text from chk c
         where c.unpaid_n > 0 and c.unpaid_sum <> c.amount_per_period * (c.unpaid_n / c.n)),
       case when (select count(*) from chk c
                   where c.unpaid_n > 0 and c.unpaid_sum <> c.amount_per_period * (c.unpaid_n / c.n)) = 0
            then '✅ 每一張非月繳契約的未收都對回契約金額' else '❌ 還有對不上的，貼結果給我' end
union all select 5, '已收的月租單一張都沒被動到（金額合計跟跑之前一樣 —— 跑之前先記下來）',
       (select coalesce(sum(o.amount), 0)::text from public.orders o
         where o.imported_via = 'contract' and o.paid),
       'ℹ 跟跑之前的數字比；函式對已收的單本來就 return，這一列是保險'
union all select 6, '母體：非月繳啟用契約張數',
       (select count(*)::text from step),
       case when (select count(*) from step) = 0 then '⚠ 一張都沒有，上面等於沒檢查到' else '✅' end
union all select 7, 'ℹ 已收的期還差契約幾元（這支不動已收的；要不要補另外決定）',
       (select coalesce(string_agg(s.room || ' ' || (p.paid_sum - s.amount_per_period * (p.paid_n / s.n))::text, '、' order by s.room), '（沒有）')
          from step s
          join lateral (select count(*) paid_n, coalesce(sum(o.amount),0) paid_sum from public.orders o
                         where o.contract_id = s.id and o.imported_via = 'contract' and o.paid) p on true
         where p.paid_n > 0 and p.paid_n % s.n = 0
           and p.paid_sum <> s.amount_per_period * (p.paid_n / s.n)),
       'ℹ 正數＝多掛、負數＝少掛；跟改之前的收款頁一樣'
order by 1;
