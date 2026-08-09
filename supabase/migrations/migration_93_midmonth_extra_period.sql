-- migration_93：月中起租的契約多產了一個月的月租單
--
-- ============================================================
-- 【問題】
--
-- gen_contract_orders 按「日曆月」產單，迴圈錨在起租月的 1 號：
--
--     ms := date_trunc('month', ct.start_date)::date;   -- 2026-06-01
--     while ms < ct.end_date loop ...                    -- 2027-06-01 < 2027-06-05 → 還成立
--
-- 租期 2026/6/6 ~ 2027/6/5 剛好 12 個月，但它碰到 **13 個日曆月**
-- （2026/6 一路到 2027/6），於是產了 13 張月租單。
--
-- 最後那張是 2027/6/1~6/5 的零頭，而那 5 天本來就含在前一期
-- （2027/5/6 ~ 2027/6/5）裡面 —— **同一段時間被算了兩次**。
--
--
-- ============================================================
-- 【後果 —— 不只是分期難看】
--
--   1. **多收一個月的租金**。年繳 $17,640（=12×1,470）的約會產出 $19,110
--   2. **營收多認列一個月**（訂單一產生，觸發器就把它拆進 revenue_recognitions）
--   3. 年繳/季繳的收租視窗會多出一個只有一個月的「第 2 期」
--      —— 使用者就是這樣發現的
--
-- 執行前的實測：**36 張契約受影響，虛增營收 $3,521,149**，
-- 而多餘那一期**一張都沒有收款**（所以可以安全清掉）。
--
--
-- ============================================================
-- 【怎麼判斷是零頭月】
--
--     月中起租  ⇔  end_date 的「日」 < start_date 的「日」
--
-- 6/6 起租、6/5 到期 → 5 < 6 → 是月中起租，最後那個日曆月是零頭。
-- 1 號起租的契約（到期日通常是月底）永遠不成立，完全不受影響。
--
-- 這個條件同時用在兩個地方：產單時跳過、清理時刪掉。
-- 兩邊用同一個條件是刻意的 —— 分開寫的話，總有一天一邊改了另一邊沒改，
-- 而症狀是「刪掉又長回來」那種找不到原因的迴圈。


-- ============================================================
-- 1. 先備份要刪的列
--
-- 刪除會連帶 CASCADE 掉 revenue_recognitions（migration_81）。
-- 判斷錯的話營收就少一塊而且救不回來 —— 所以先留一份。
-- ============================================================

drop table if exists public.deleted_stub_orders_93;
create table public.deleted_stub_orders_93 as
select o.*, now() as backed_up_at
from public.orders o
join public.contracts c on c.id = o.contract_id
where o.imported_via = 'contract'
  and o.paid = false                                          -- 已收款的一律不碰
  and c.start_date is not null and c.end_date is not null
  and extract(day from c.end_date) < extract(day from c.start_date)   -- 月中起租
  and o.checkin = date_trunc('month', c.end_date)::date;             -- 最後那個零頭月

comment on table public.deleted_stub_orders_93 is
  'migration_93 刪掉的「月中起租零頭月」月租單。確認營收無誤之後可以 drop。';


-- ============================================================
-- 2. 修函式
--
-- 逐字保留 migration_81 的版本，只動兩個地方（下面都標了 ★）。
-- 重寫整支的話會把 81 的「先去重再改名」邏輯弄丟 ——
-- 那段是花了一整支 migration 才做對的。
-- ============================================================

create or replace function public.gen_contract_orders(ct public.contracts)
 returns void language plpgsql
as $function$
declare
  ms date; me date; ymtxt text; kbase text; src text;
  stub_ms date;   -- ★ 月中起租的零頭月（沒有就是 null）
begin
  if ct.start_date is null or ct.end_date is null then return; end if;

  /*
   * ★ 零頭月：月中起租時，最後那個日曆月只剩幾天，
   * 而那幾天已經含在前一期裡。它不是一期租金。
   */
  stub_ms := case
    when extract(day from ct.end_date) < extract(day from ct.start_date)
      then date_trunc('month', ct.end_date)::date
    else null
  end;

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
   */

  -- 1. 同一個月多列 → 收斂成一列。
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

  -- 2. 剩下的舊鍵改名。paid / paid_at / 發票全部跟著走。
  update orders o
     set order_key = kbase || right(o.order_key, 6)
   where o.contract_id = ct.id
     and o.imported_via = 'contract'
     and left(o.order_key, length(kbase)) is distinct from kbase;

  -- 超出租期、未收款的照舊清掉
  -- ★ 多加一條：零頭月也要清掉，否則改一次租期它又會留在那裡
  delete from orders
   where contract_id = ct.id
     and imported_via = 'contract'
     and paid = false
     and (checkin < date_trunc('month', ct.start_date)::date
          or checkin >= ct.end_date
          or (stub_ms is not null and checkin = stub_ms));

  if not ct.active or ct.monthly_rent is null or ct.monthly_rent <= 0 then return; end if;

  ms := date_trunc('month', ct.start_date)::date;
  while ms < ct.end_date loop
    -- ★ 走到零頭月就停。它不是一期租金,那幾天含在前一期裡。
    exit when stub_ms is not null and ms = stub_ms;

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
-- 3. 清掉既有的零頭月
--
-- 只刪未收款的。已收款代表錢真的進來了 —— 那可能是房客多付了要退，
-- 也可能是租期日期打錯，兩種都要人看過才能決定，不是程式該自己處理的。
-- ============================================================

do $$
declare
  n_del int;
  rev0 numeric; rev1 numeric;
  n_paid int;
begin
  select coalesce(sum(month_amount), 0) into rev0 from public.revenue_recognitions;

  -- 先看有沒有「已收款的零頭月」—— 有的話要講出來,那些不會被刪
  select count(*) into n_paid
    from public.orders o join public.contracts c on c.id = o.contract_id
   where o.imported_via = 'contract' and o.paid
     and extract(day from c.end_date) < extract(day from c.start_date)
     and o.checkin = date_trunc('month', c.end_date)::date;
  if n_paid > 0 then
    raise warning '⚠ 有 % 張零頭月**已經收款**,這支不會動它們。請人工確認是房客多付還是租期打錯。', n_paid;
  end if;

  delete from public.orders o
   using public.contracts c
   where c.id = o.contract_id
     and o.imported_via = 'contract'
     and o.paid = false
     and c.start_date is not null and c.end_date is not null
     and extract(day from c.end_date) < extract(day from c.start_date)
     and o.checkin = date_trunc('month', c.end_date)::date;
  get diagnostics n_del = row_count;

  select coalesce(sum(month_amount), 0) into rev1 from public.revenue_recognitions;

  raise notice 'ℹ 刪掉 % 張零頭月月租單', n_del;
  raise notice 'ℹ 營收認列 % → %（減少 %）', rev0, rev1, rev0 - rev1;
  raise notice 'ℹ 那些減少的是**本來就不該存在的營收** —— 同一段時間被算了兩次';

  if n_del = 0 then
    raise notice '（沒有可刪的零頭月。可能已經跑過,或本來就沒有月中起租的契約）';
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
  -- 函式真的改到了嗎
  t := pg_get_functiondef('public.gen_contract_orders(public.contracts)'::regprocedure);
  if position('stub_ms' in t) > 0 then raise notice '✅ gen_contract_orders 已加入零頭月判斷';
  else raise warning '❌ 函式沒有改到'; return; end if;

  -- migration_81 的邏輯不能被弄丟 —— 這支重寫了整個函式
  if position('left(x.order_key' in t) > 0 and position('order by (left(' in t) > 0 then
    raise notice '✅ migration_81 的「先去重再改名」邏輯仍在';
  else raise warning '❌ migration_81 的邏輯被弄丟了!舊鍵改名會壞掉'; end if;

  -- 還有沒有殘留的零頭月
  select count(*) into n
    from public.orders o join public.contracts c on c.id = o.contract_id
   where o.imported_via = 'contract'
     and c.start_date is not null and c.end_date is not null
     and extract(day from c.end_date) < extract(day from c.start_date)
     and o.checkin = date_trunc('month', c.end_date)::date;
  if n = 0 then raise notice '✅ 沒有殘留的零頭月';
  else raise warning 'ℹ 還有 % 張零頭月（應該都是已收款、刻意保留的）', n; end if;

  -- 每張契約的月租單數 = 應有期數
  select count(*) into n from (
    select c.id
      from public.contracts c
      join public.orders o on o.contract_id = c.id and o.imported_via = 'contract'
     where c.start_date is not null and c.end_date is not null
     group by c.id, c.start_date, c.end_date
    having count(o.id) >
      ((extract(year from c.end_date)::int * 12 + extract(month from c.end_date)::int)
       - (extract(year from c.start_date)::int * 12 + extract(month from c.start_date)::int))
  ) x;
  if n = 0 then raise notice '✅ 所有契約的月租單數都等於應有期數';
  else raise warning 'ℹ 還有 % 張契約的月租單數偏多（已收款的不會被清）', n; end if;

  select count(*) into n from public.deleted_stub_orders_93;
  raise notice 'ℹ 備份表 deleted_stub_orders_93 存了 % 列,確認營收無誤後可以 drop', n;

exception when others then
  raise warning '驗證區出錯（上面的變更不受影響）:%', sqlerrm;
end $$;


-- ── 產單邏輯的實測 ─────────────────────────────────
--
-- 只讀系統目錄驗證不到「函式真的會跳過零頭月」。
-- 這裡不動真的契約 —— 用一個假的 contracts 值直接算出「會產幾個月」,
-- 把每一種租期形狀都走一次。

do $$
declare
  bad int := 0;
  -- 給定起訖,算出新邏輯會產幾個月
  function_result int;
begin
  -- 用跟函式裡一模一樣的算式,逐一比對
  -- 6/6 ~ 隔年 6/5 = 12 個月（使用者回報的那張）
  select count(*) into function_result from generate_series(
    date_trunc('month', date '2026-06-06'), date '2027-06-05', interval '1 month') g
   where g < date '2027-06-05'
     and not (extract(day from date '2027-06-05') < extract(day from date '2026-06-06')
              and g = date_trunc('month', date '2027-06-05'));
  if function_result <> 12 then bad := bad + 1;
    raise warning '❌ 6/6~6/5 應該是 12 個月,算出 %', function_result; end if;

  -- 1 號起租、月底到期 = 12 個月（原本就正確,不能被改壞）
  select count(*) into function_result from generate_series(
    date_trunc('month', date '2026-06-01'), date '2027-05-31', interval '1 month') g
   where g < date '2027-05-31'
     and not (extract(day from date '2027-05-31') < extract(day from date '2026-06-01')
              and g = date_trunc('month', date '2027-05-31'));
  if function_result <> 12 then bad := bad + 1;
    raise warning '❌ 6/1~5/31 應該是 12 個月,算出 %', function_result; end if;

  -- 月中起租的半年約 6/15 ~ 12/14 = 6 個月
  select count(*) into function_result from generate_series(
    date_trunc('month', date '2026-06-15'), date '2026-12-14', interval '1 month') g
   where g < date '2026-12-14'
     and not (extract(day from date '2026-12-14') < extract(day from date '2026-06-15')
              and g = date_trunc('month', date '2026-12-14'));
  if function_result <> 6 then bad := bad + 1;
    raise warning '❌ 6/15~12/14 應該是 6 個月,算出 %', function_result; end if;

  if bad = 0 then raise notice '✅ 三種租期形狀的月數都正確（含 1 號起租的不受影響）';
  end if;
exception when others then
  raise warning '產單邏輯實測出錯:%', sqlerrm;
end $$;


-- ── 影響範圍 ───────────────────────────────────────
select c.room as 房源, c.tenant_name as 租戶, c.cadence as 繳別,
       c.start_date as 租期起, c.end_date as 租期迄,
       count(o.id) as 月租單數,
       to_char(sum(o.amount), 'FM999,999,999') as 合計
from public.contracts c
join public.orders o on o.contract_id = c.id and o.imported_via = 'contract'
where c.start_date is not null and c.end_date is not null
  and extract(day from c.end_date) < extract(day from c.start_date)
group by c.id, c.room, c.tenant_name, c.cadence, c.start_date, c.end_date
order by c.start_date desc
limit 40;


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    raise notice '%', (select public.record_migration('93_midmonth_extra_period'));
  else
    raise notice '尚未建立 schema_migrations（migration_70），這支沒有被記錄';
  end if;
end $$;
