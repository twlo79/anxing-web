-- migration_93：月中起租的契約多產了月租單
--
-- ============================================================
-- 【問題】
--
-- gen_contract_orders 按「日曆月」產單，迴圈條件是
--
--     ms := date_trunc('month', ct.start_date)::date;   -- 起租月的 1 號
--     while ms < ct.end_date loop ...
--
-- 但租約是**月中到月中**的，日曆月跟租期不會一一對應：
--
--     租期 2026/6/23 ~ 2026/9/23（季繳，每期 $5,040 = 3 × $1,680）
--       碰到的日曆月：2026/6、7、8、9  →  4 個
--       真正的租期數：                    3 個
--
--     租期 2026/6/6 ~ 2027/6/5（年繳，$17,640 = 12 × $1,470）
--       碰到的日曆月：13 個
--       真正的租期數：12 個
--
--
-- ============================================================
-- 【後果 —— 不只是分期難看】
--
--   1. **多收一個月的租金**
--   2. **營收多認列一個月**（訂單一產生，觸發器就拆進 revenue_recognitions）
--   3. 年繳/季繳的收租視窗會多出一個一個月的期別
--      —— 使用者就是這樣發現的
--
--
-- ============================================================
-- 【正確的算法】
--
--     期數 = 月份差 + (迄日的「日」> 起日的「日」? 1 : 0)
--
-- 四種租期形狀都要對：
--
--     6/23 → 9/23        月差 3   23 > 23 否   → 3   季繳剛好一期
--     6/6  → 隔年 6/5    月差 12  5  > 6  否   → 12  年繳剛好一期
--     9/11 → 隔年 9/10   月差 12  10 > 11 否   → 12
--     6/1  → 隔年 5/31   月差 11  31 > 1  是   → 12  1 號起租，原本就對
--
-- **這個公式跟前端 src/lib/due-date.ts 的 rentMonthCount() 逐字相同**，
-- 那邊有 8 個測試釘住上面四種形狀。兩邊不一致的話，
-- 畫面說 3 期、資料庫產 4 期，而且沒有人查得出來是哪一邊錯。
--
-- 【繳別不影響這個公式】
-- 月繳/季繳/半年繳/年繳只決定「幾個月算一期」（前端的 STEP），
-- 不影響「總共幾個月」。所以這支只要算對月數，四種繳別就都對了。


-- ============================================================
-- 1. 先備份要刪的列
--
-- 刪除會連帶 CASCADE 掉 revenue_recognitions（migration_81）。
-- 判斷錯的話營收就少一塊而且救不回來 —— 所以先留一份。
-- ============================================================

drop table if exists public.deleted_stub_orders_93;
create table public.deleted_stub_orders_93 as
select o.*, c.start_date, c.end_date, c.cadence, now() as backed_up_at
from public.orders o
join public.contracts c on c.id = o.contract_id
where o.imported_via = 'contract'
  and o.paid = false                                   -- 已收款的一律不碰
  and c.start_date is not null and c.end_date is not null
  -- 超出「起租月 + 應有月數」的都是多的
  and o.checkin >= (date_trunc('month', c.start_date) + (
        greatest(0,
          (extract(year from c.end_date)::int * 12 + extract(month from c.end_date)::int)
        - (extract(year from c.start_date)::int * 12 + extract(month from c.start_date)::int)
        + case when extract(day from c.end_date) > extract(day from c.start_date) then 1 else 0 end
        ) || ' month')::interval)::date;

comment on table public.deleted_stub_orders_93 is
  'migration_93 刪掉的「超出租期」月租單（月中起租多產的那些）。確認營收無誤之後可以 drop。';


-- ============================================================
-- 2. 修函式
--
-- 逐字保留 migration_81 的版本，只動三個地方（都標了 ★）。
-- 重寫整支的話會把 81 的「先去重再改名」邏輯弄丟 ——
-- 那段是花了一整支 migration 才做對的。
-- ============================================================

create or replace function public.gen_contract_orders(ct public.contracts)
 returns void language plpgsql
as $function$
declare
  ms date; me date; ymtxt text; kbase text; src text;
  n_months int;    -- ★ 這份租約真正有幾個月租期
  stop_ms date;    -- ★ 第一個「不屬於租期」的月份
begin
  if ct.start_date is null or ct.end_date is null then return; end if;

  /*
   * ★ 期數 = 月份差 + (迄日的「日」> 起日的「日」? 1 : 0)
   *
   * 不能數日曆月 —— 6/23~9/23 碰到 4 個日曆月但只有 3 期。
   * 這段跟前端 lib/due-date 的 rentMonthCount() 逐字相同。
   */
  n_months := (extract(year from ct.end_date)::int * 12 + extract(month from ct.end_date)::int)
            - (extract(year from ct.start_date)::int * 12 + extract(month from ct.start_date)::int)
            + case when extract(day from ct.end_date) > extract(day from ct.start_date)
                   then 1 else 0 end;
  if n_months < 0 then n_months := 0; end if;

  stop_ms := (date_trunc('month', ct.start_date) + (n_months || ' month')::interval)::date;

  kbase := case
    when coalesce(ct.room, '') <> '' then 'LT_' || ct.room || '_'
    else 'LTC_' || ct.id || '_'
  end;

  src := case ct.type
    when 'office'  then 'office'
    when 'company' then 'company'
    else 'longterm'
  end;

  /*
   * ── 鍵過期的列 ──（migration_81，原封不動）
   *
   * 用 left(order_key, length(kbase)) 比對而不是 LIKE ——
   * LIKE 的 _ 與 % 是萬用字元，房號裡出現那些字就會比錯。
   * lib/ltKey.ts 記著這件事：曾經因此把 2F-1/2F-2/2F-3 的收款記錄整批清空。
   */

  -- 1. 同一個月多列 → 收斂成一列。
  --    留鍵正確的（未來重產維護的是它），其次留已收款的。
  delete from orders o
   where o.contract_id = ct.id
     and o.imported_via = 'contract'
     and o.id <> (
       select x.id from orders x
        where x.contract_id = ct.id
          and x.imported_via = 'contract'
          and x.checkin = o.checkin
        order by (left(x.order_key, length(kbase)) = kbase) desc, x.paid desc, x.id
        limit 1);

  -- 2. 剩下的舊鍵改名。paid / paid_at / 發票全部跟著走，不會有任何損失。
  update orders o
     set order_key = kbase || right(o.order_key, 6)
   where o.contract_id = ct.id
     and o.imported_via = 'contract'
     and left(o.order_key, length(kbase)) is distinct from kbase;

  /*
   * 超出租期、未收款的清掉。
   * ★ 界線從 `checkin >= ct.end_date` 改成 `checkin >= stop_ms`。
   *   前者拿「到期日」當界線，月中到期時零頭月的 1 號還在到期日之前，
   *   於是被留下來 —— 那正是這支要修的 bug。
   */
  delete from orders
   where contract_id = ct.id
     and imported_via = 'contract'
     and paid = false
     and (checkin < date_trunc('month', ct.start_date)::date
          or checkin >= stop_ms);

  if not ct.active or ct.monthly_rent is null or ct.monthly_rent <= 0 then return; end if;

  ms := date_trunc('month', ct.start_date)::date;
  -- ★ 條件從 `ms < ct.end_date` 改成 `ms < stop_ms`：產剛好 n_months 個月
  while ms < stop_ms loop
    me := (ms + interval '1 month')::date;
    ymtxt := to_char(ms, 'YYYYMM');
    insert into orders (order_key, source, estate_id, property_raw, guest_name,
      checkin, checkout, nights, amount, deposit, note, imported_via, contract_id, paid)
    values (kbase || ymtxt, src, ct.estate_id, ct.room, ct.tenant_name,
      ms, me, (me - ms), ct.monthly_rent, 0, '契約應收', 'contract', ct.id, false)
    on conflict (order_key) do update
      set source = excluded.source,
          guest_name = excluded.guest_name,
          estate_id = excluded.estate_id,
          property_raw = excluded.property_raw,
          amount = case when orders.paid then orders.amount else excluded.amount end,
          contract_id = excluded.contract_id
      where orders.imported_via = 'contract';
    ms := me;
  end loop;
end $function$;


-- ============================================================
-- 3. 清掉既有的多餘月份
--
-- 只刪未收款的。已收款代表錢真的進來了 —— 那可能是房客多付了要退，
-- 也可能是租期日期打錯，兩種都要人看過才能決定。
-- ============================================================

do $$
declare
  n_del int; n_paid int;
  rev0 numeric; rev1 numeric;
begin
  select coalesce(sum(month_amount), 0) into rev0 from public.revenue_recognitions;

  select count(*) into n_paid
    from public.orders o join public.contracts c on c.id = o.contract_id
   where o.imported_via = 'contract' and o.paid
     and c.start_date is not null and c.end_date is not null
     and o.checkin >= (date_trunc('month', c.start_date) + (greatest(0,
           (extract(year from c.end_date)::int * 12 + extract(month from c.end_date)::int)
         - (extract(year from c.start_date)::int * 12 + extract(month from c.start_date)::int)
         + case when extract(day from c.end_date) > extract(day from c.start_date) then 1 else 0 end
         ) || ' month')::interval)::date;
  if n_paid > 0 then
    raise warning '⚠ 有 % 張超出租期的月租單**已經收款**,這支不會動它們。請人工確認是房客多付還是租期打錯。', n_paid;
  end if;

  delete from public.orders o
   using public.contracts c
   where c.id = o.contract_id
     and o.imported_via = 'contract'
     and o.paid = false
     and c.start_date is not null and c.end_date is not null
     and o.checkin >= (date_trunc('month', c.start_date) + (greatest(0,
           (extract(year from c.end_date)::int * 12 + extract(month from c.end_date)::int)
         - (extract(year from c.start_date)::int * 12 + extract(month from c.start_date)::int)
         + case when extract(day from c.end_date) > extract(day from c.start_date) then 1 else 0 end
         ) || ' month')::interval)::date;
  get diagnostics n_del = row_count;

  select coalesce(sum(month_amount), 0) into rev1 from public.revenue_recognitions;

  raise notice 'ℹ 刪掉 % 張超出租期的月租單', n_del;
  raise notice 'ℹ 營收認列 % → %（減少 %）', rev0, rev1, rev0 - rev1;
  raise notice 'ℹ 減少的是**本來就不該存在的營收** —— 同一段時間被算了兩次';
  if n_del = 0 then
    raise notice '（沒有可刪的。可能已經跑過,或本來就沒有月中起租的契約）';
  end if;
end $$;


-- ============================================================
-- 驗證
--
-- 包在 exception 裡：驗證失敗只發警告，不要把上面的變更整包回滾掉。
-- ============================================================

do $$
declare n int; t text;
begin
  t := pg_get_functiondef('public.gen_contract_orders(public.contracts)'::regprocedure);
  if position('n_months' in t) > 0 and position('stop_ms' in t) > 0 then
    raise notice '✅ gen_contract_orders 已改用「租期月數」而不是日曆月';
  else raise warning '❌ 函式沒有改到'; return; end if;

  -- migration_81 的邏輯不能被弄丟 —— 這支重寫了整個函式
  if position('left(x.order_key' in t) > 0 and position('order by (left(' in t) > 0 then
    raise notice '✅ migration_81 的「先去重再改名」邏輯仍在';
  else raise warning '❌ migration_81 的邏輯被弄丟了!舊鍵改名會壞掉'; end if;

  -- 每張契約的月租單數都不該超過應有月數
  select count(*) into n from (
    select c.id
      from public.contracts c
      join public.orders o on o.contract_id = c.id and o.imported_via = 'contract'
     where c.start_date is not null and c.end_date is not null
     group by c.id, c.start_date, c.end_date
    having count(o.id) > greatest(0,
      (extract(year from c.end_date)::int * 12 + extract(month from c.end_date)::int)
    - (extract(year from c.start_date)::int * 12 + extract(month from c.start_date)::int)
    + case when extract(day from c.end_date) > extract(day from c.start_date) then 1 else 0 end)
  ) x;
  if n = 0 then raise notice '✅ 所有契約的月租單數都等於應有月數';
  else raise warning 'ℹ 還有 % 張契約偏多（應該都是已收款、刻意保留的）', n; end if;

  select count(*) into n from public.deleted_stub_orders_93;
  raise notice 'ℹ 備份表 deleted_stub_orders_93 存了 % 列,確認營收無誤後可以 drop', n;

exception when others then
  raise warning '驗證區出錯（上面的變更不受影響）:%', sqlerrm;
end $$;


-- ── 公式的逐條實測（四種繳別都涵蓋）─────────────────
--
-- 繳別本身不影響月數,只影響「幾個月算一期」。
-- 所以這裡驗月數,並順便算出各繳別會切成幾期。

do $$
declare bad int := 0; r record;
begin
  -- plpgsql 的 DO 區塊裡不能定義函式,所以算式用 lateral 展開,
  -- 但內容跟 gen_contract_orders 裡那段逐字相同。
  for r in
    select v.label, v.expect, calc.m from (values
      (date '2026-06-23', date '2026-09-23', 3,  '季繳一期:6/23~9/23'),
      (date '2026-06-06', date '2027-06-05', 12, '年繳一期:6/6~隔年6/5'),
      (date '2025-09-11', date '2026-09-10', 12, '年繳一期:9/11~隔年9/10'),
      (date '2026-06-01', date '2027-05-31', 12, '1號起租月底到期'),
      (date '2026-06-01', date '2027-06-01', 12, '1號起租隔年1號到期'),
      (date '2026-06-15', date '2026-12-15', 6,  '半年繳一期:6/15~12/15'),
      (date '2026-06-23', date '2026-07-23', 1,  '月繳一期:6/23~7/23'),
      (date '2026-01-31', date '2027-01-31', 12, '31號起租')
    ) v(s, e, expect, label)
    cross join lateral (
      select greatest(0,
        (extract(year from v.e)::int * 12 + extract(month from v.e)::int)
      - (extract(year from v.s)::int * 12 + extract(month from v.s)::int)
      + case when extract(day from v.e) > extract(day from v.s) then 1 else 0 end) as m
    ) calc
    where calc.m <> v.expect
  loop
    bad := bad + 1;
    raise warning '❌ %：應該是 % 個月,算出 %', r.label, r.expect, r.m;
  end loop;

  if bad = 0 then
    raise notice '✅ 八種租期形狀的月數全部正確（月繳/季繳/半年繳/年繳都涵蓋）';
  else raise warning '❌ 有 % 種算錯', bad; end if;
exception when others then
  raise warning '公式實測出錯:%', sqlerrm;
end $$;


-- ── 各繳別會切成幾期（給人核對用）───────────────────
select
  c.room as 房源, c.tenant_name as 租戶, c.cadence as 繳別,
  c.start_date as 租期起, c.end_date as 租期迄,
  greatest(0,
    (extract(year from c.end_date)::int * 12 + extract(month from c.end_date)::int)
  - (extract(year from c.start_date)::int * 12 + extract(month from c.start_date)::int)
  + case when extract(day from c.end_date) > extract(day from c.start_date) then 1 else 0 end)
    as 應有月數,
  count(o.id) as 實際月租單數,
  ceil(greatest(0,
    (extract(year from c.end_date)::int * 12 + extract(month from c.end_date)::int)
  - (extract(year from c.start_date)::int * 12 + extract(month from c.start_date)::int)
  + case when extract(day from c.end_date) > extract(day from c.start_date) then 1 else 0 end)::numeric
  / case c.cadence when 'yearly' then 12 when 'halfyear' then 6
                   when 'quarterly' then 3 else 1 end) as 應有期數
from public.contracts c
join public.orders o on o.contract_id = c.id and o.imported_via = 'contract'
where c.start_date is not null and c.end_date is not null
group by c.id, c.room, c.tenant_name, c.cadence, c.start_date, c.end_date
order by c.cadence, c.start_date desc
limit 60;


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    raise notice '%', (select public.record_migration('93_midmonth_extra_period'));
  else
    raise notice '尚未建立 schema_migrations（migration_70），這支沒有被記錄';
  end if;
end $$;
