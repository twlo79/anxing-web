-- migration_136：重算所有契約月租單（**含已收款的**）
--
-- ============================================================
-- 【先看 migration_135 的對照表再跑這一支】
--
-- 這一支會改到**已經收過錢**的月租單。改完之後那張單上的金額
-- 跟你當初實際收到的錢可能對不上 —— 差額要另外處理（退款或抵下期），
-- 而系統不會提醒你，因為它不知道有這回事。
--
-- 使用者選的是「全部重算」（2026-08-16）。這一支照做，
-- 但**把每一張被改動的已收款單列出來**,並且先把原值存進備份表。
--
--
-- ============================================================
-- 【為什麼要備份表而不是靠 git】
--
-- migration 是手貼進 SQL Editor 的,沒有 down migration。
-- 改錯了要還原,唯一的依據就是「改之前長什麼樣」——
-- 而那個資訊在執行的那一刻就消失了。
--
-- `orders_backup_136` 留著。**不要刪**,至少留到下一次結算對完帳。
--
--
-- ============================================================
-- 【為什麼要暫時解掉 paid 的保護】
--
-- `gen_contract_orders` 的 upsert 帶著
--
--     where orders.imported_via = 'contract' and orders.paid = false
--
-- 那是刻意的保護:平常存契約時絕對不該動到已收款的單。
--
-- 這裡用一個**交易內的旗標**暫時放行,而不是改函式 ——
-- 改函式的話那道保護就永久沒了,而它在日常操作中每天都在生效。
-- 旗標只在這個交易裡有效,跑完就恢復。

-- ── 備份 ───────────────────────────────────────────
drop table if exists public.orders_backup_136;
create table public.orders_backup_136 as
select o.*, clock_timestamp() as backed_up_at
  from public.orders o
 where o.imported_via = 'contract' and o.contract_id is not null;

comment on table public.orders_backup_136 is
  'migration_136 重算月租單之前的原值。**不要刪** —— '
  '沒有 down migration,改錯了只能靠這張表還原。至少留到下次結算對完帳。';


-- ── 暫時放行已收款的單 ─────────────────────────────
/*
 * 加一個 before update 的觸發器來繞過 upsert 的 where 是行不通的
 * （where 擋在 upsert 本身，根本不會產生 update）。
 * 所以改成:直接在這裡重算,不走 gen_contract_orders 的 upsert 路徑。
 *
 * 邏輯必須跟 migration_135 的函式**完全一致** ——
 * 兩份算法各寫一次是最容易長歪的地方,所以這裡只更新
 * checkin/checkout/nights/amount,期數的增減仍然交給函式處理。
 */
do $$
declare
  ct public.contracts;
  ms date; me date; p_start date; p_end date; lease_end date; last_ms date;
  n int; dim int; total numeric; acc numeric; amt numeric; ymtxt text;
  touched int := 0; touched_paid int := 0;
begin
  drop table if exists _chg136;
  create temp table _chg136 (
    room text, ym text, paid boolean,
    old_in date, old_out date, old_amt numeric,
    new_in date, new_out date, new_amt numeric
  );

  for ct in
    select * from public.contracts
     where start_date is not null and end_date is not null
       and monthly_rent is not null and monthly_rent > 0 and active
  loop
    lease_end := (ct.end_date + 1)::date;
    total := 0; acc := 0; last_ms := null;

    -- 第一趟：總額
    ms := date_trunc('month', ct.start_date)::date;
    while ms < lease_end loop
      me := (ms + interval '1 month')::date;
      p_start := greatest(ms, ct.start_date);
      p_end   := least(me, lease_end);
      n := p_end - p_start;
      if n > 0 then
        dim := me - ms;
        total := total + ct.monthly_rent::numeric * n / dim;
        last_ms := ms;
      end if;
      ms := me;
    end loop;
    total := round(total);

    -- 第二趟：更新既有的單（含已收款）
    ms := date_trunc('month', ct.start_date)::date;
    while ms < lease_end loop
      me := (ms + interval '1 month')::date;
      p_start := greatest(ms, ct.start_date);
      p_end   := least(me, lease_end);
      n := p_end - p_start;
      if n > 0 then
        dim := me - ms;
        if ms = last_ms then amt := total - acc;
        else amt := trunc(ct.monthly_rent::numeric * n / dim); acc := acc + amt; end if;
        ymtxt := to_char(ms, 'YYYYMM');

        -- 先記下會變成什麼，再改。改完就查不到舊值了
        insert into _chg136
        select ct.room, ymtxt, o.paid, o.checkin, o.checkout, o.amount, p_start, p_end, amt
          from public.orders o
         where o.order_key = 'LT_' || ct.room || '_' || ymtxt
           and o.imported_via = 'contract'
           and (o.checkin <> p_start or o.checkout <> p_end or o.amount <> amt);

        update public.orders o
           set checkin = p_start, checkout = p_end, nights = n, amount = amt
         where o.order_key = 'LT_' || ct.room || '_' || ymtxt
           and o.imported_via = 'contract'
           and (o.checkin <> p_start or o.checkout <> p_end or o.amount <> amt);
      end if;
      ms := me;
    end loop;

    -- 期數的增減（多產的那一期要刪掉）交給函式
    perform public.gen_contract_orders(ct);
  end loop;

  select count(*), count(*) filter (where paid) into touched, touched_paid from _chg136;
  raise notice '重算 % 張,其中已收款 %', touched, touched_paid;
end $$;


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('136_rebuild_contract_orders');
  end if;
end $$;


-- ============================================================
-- 驗證
-- ============================================================
do $$
declare n int; m numeric;
begin
  drop table if exists _chk136;
  create temp table _chk136 (ord int, item text, result text, detail text);

  select count(*) into n from public.orders_backup_136;
  insert into _chk136 values (1, '備份表 orders_backup_136', n || ' 張', '**不要刪**');

  select count(*) into n from _chg136;
  insert into _chk136 values (2, '★ 有變動的月租單', n || ' 張', '沒變的不列');

  select count(*) into n from _chg136 where paid;
  insert into _chk136 values (2, '★★ 其中已收款的',
    case when n = 0 then '✅ 0 張' else '⚠ ' || n || ' 張' end,
    case when n = 0 then '沒有動到收過錢的單'
         else '**這些單的金額跟當初實際收到的錢可能對不上,差額要人工處理**' end);

  select coalesce(sum(new_amt - old_amt), 0) into m from _chg136;
  insert into _chk136 values (3, '★★ 金額總變動',
    case when m >= 0 then '+' else '' end || '$' || to_char(m, 'FM999,999,999'),
    '負數代表原本多開了 —— 那些多出來的錢本來不該收');

  -- 逐張列出已收款且被改的（最需要人看的）
  insert into _chk136
  select 5, '⚠ ' || room || ' ' || ym,
         '$' || to_char(old_amt, 'FM999,999,999') || ' → $' || to_char(new_amt, 'FM999,999,999'),
         old_in || '~' || old_out || ' → ' || new_in || '~' || new_out || '　（已收款）'
    from _chg136 where paid order by room, ym;

  -- 未收款的只給筆數，不逐張列 —— 那些改了沒有後果
  select count(*) into n from _chg136 where not paid;
  insert into _chk136 values (7, '未收款而被改的', n || ' 張',
    '這些改了沒有後果 —— 錢還沒收，改成對的就是對的');

  /*
   * 重算之後每份契約的合計對不對得上「月租 × 月數」。
   * 這才是真正的驗收:前面都是「改了幾張」,這一條是「改完對不對」。
   */
  select count(*) into n
    from public.contracts c
    join (select contract_id, sum(amount) s from public.orders
           where imported_via = 'contract' group by contract_id) x on x.contract_id = c.id
   where c.start_date is not null and c.end_date is not null and c.monthly_rent is not null
     and c.active
     and abs(x.s - c.monthly_rent *
         ((extract(year from c.end_date)::int * 12 + extract(month from c.end_date)::int)
          - (extract(year from c.start_date)::int * 12 + extract(month from c.start_date)::int))) > 1;
  insert into _chk136 values (9, '★★ 合計對不上契約總額的',
    case when n = 0 then '✅ 全部對上' else '❌ ' || n || ' 份' end,
    '容許 1 元誤差（分攤捨去）。對不上代表算法還有洞,把那幾份列出來查');
end $$;

select item as "檢查項目", result as "結果", detail as "說明"
from _chk136 order by ord, item;
