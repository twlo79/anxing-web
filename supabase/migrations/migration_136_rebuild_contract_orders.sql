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
-- 【為什麼不去改 gen_contract_orders 的 paid 保護】
--
-- 那支函式的 upsert 帶著
--
--     where orders.imported_via = 'contract' and orders.paid = false
--
-- 那是刻意的:**平常存一份契約時，絕對不該動到已收款的單。**
-- 那道保護在日常操作中每天都在生效,拿掉就永久沒了。
--
-- 所以這裡分工:未收款的交給函式，已收款的在這一支手動改。
-- 一次性的例外寫在一次性的腳本裡,不要為了它改掉常設的規則。

-- ── 備份 ───────────────────────────────────────────
drop table if exists public.orders_backup_136;
create table public.orders_backup_136 as
select o.*, clock_timestamp() as backed_up_at
  from public.orders o
 where o.imported_via = 'contract' and o.contract_id is not null;

comment on table public.orders_backup_136 is
  'migration_136 重算月租單之前的原值。**不要刪** —— '
  '沒有 down migration,改錯了只能靠這張表還原。至少留到下次結算對完帳。';


-- ── 重算 ───────────────────────────────────────────
/*
 * 【分工】
 *
 *   未收款的單  →  交給 gen_contract_orders（migration_135 已經改好）
 *                  它會清掉不在目標期間的、再 upsert 正確的
 *   已收款的單  →  在這裡手動 update，因為函式刻意不碰它們
 *
 * 【為什麼用「契約 + 日曆月」定位，不用 order_key】
 * order_key 是 `LT_房號_年月` —— 房號改過的契約，舊單掛著舊房號。
 * 第一版就是用 order_key 比對才會漏掉，然後撞上 uq_contract_order_month。
 *
 * 【為什麼要先讓開】
 * 把已收款那張的 checkin 從 10-01 移到 10-16 時，
 * 如果同一份契約已經有一張未收款的落在 10-16，就會撞唯一約束。
 * 所以先刪掉同月份的未收款重複列 —— 那些反正等一下會被函式重建。
 */
do $$
declare
  ct public.contracts;
  ms date; me date; p_start date; p_end date; lease_end date; last_ms date;
  n int; dim int; total numeric; acc numeric; amt numeric;
  touched int := 0; touched_paid int := 0;
begin
  drop table if exists _chg136;
  create temp table _chg136 (
    room text, ym text, paid boolean,
    old_in date, old_out date, old_amt numeric,
    new_in date, new_out date, new_amt numeric
  );

  /*
   * 【只跑有房號的契約】
   *
   * 房號空白的是**辦公室登記 / 公司登記**（使用者確認，2026-08-16）——
   * 它們本來就不屬於某一間房，走 `LTC_{契約id}_`，由前端契約頁產生。
   *
   * 不排除的話這裡會去動那些單，而它們的期數是另一套算法排的 ——
   * 兩邊搶同一份契約，正是第一次跑 135 撞 uq_contract_order_month 的原因。
   *
   * ⚠ 那批**沒有套用頭尾按比例**，仍然整月整額。
   *   要不要一起改是另一個決定（辦公室登記按不按比例收，跟租金不見得一樣）。
   */
  for ct in
    select * from public.contracts
     where start_date is not null and end_date is not null
       and monthly_rent is not null and monthly_rent > 0 and active
       and room is not null and btrim(room) <> ''
     order by room
  loop
    lease_end := (ct.end_date + 1)::date;
    total := 0; acc := 0; last_ms := null;

    -- 第一趟：總額（算法必須跟 gen_contract_orders 一字不差）
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

    -- 第二趟：只處理已收款的
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

        -- 先記下舊值。改完就查不到了
        insert into _chg136
        select ct.room, to_char(ms, 'YYYYMM'), true,
               o.checkin, o.checkout, o.amount, p_start, p_end, amt
          from public.orders o
         where o.contract_id = ct.id and o.imported_via = 'contract' and o.paid
           and o.checkin >= ms and o.checkin < me
           and (o.checkin <> p_start or o.checkout <> p_end or o.amount <> amt);

        -- 讓開：同月份的未收款重複列先刪掉，等下由函式重建
        delete from public.orders o
         where o.contract_id = ct.id and o.imported_via = 'contract' and not o.paid
           and o.checkin >= ms and o.checkin < me
           and exists (select 1 from public.orders p
                        where p.contract_id = ct.id and p.imported_via = 'contract' and p.paid
                          and p.checkin >= ms and p.checkin < me);

        update public.orders o
           set checkin = p_start, checkout = p_end, nights = n, amount = amt
         where o.contract_id = ct.id and o.imported_via = 'contract' and o.paid
           and o.checkin >= ms and o.checkin < me
           and (o.checkin <> p_start or o.checkout <> p_end or o.amount <> amt);
      end if;
      ms := me;
    end loop;

    -- 未收款的全部交給函式（清掉多餘期數 ＋ 補上正確的）
    perform public.gen_contract_orders(ct);
  end loop;

  select count(*), count(*) filter (where paid) into touched, touched_paid from _chg136;
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

  select count(*) into n from _chg136 where paid;
  insert into _chk136 values (2, '★★ 被改動的已收款單',
    case when n = 0 then '✅ 0 張' else '⚠ ' || n || ' 張' end,
    case when n = 0 then '沒有動到收過錢的單'
         else '**這些單的金額跟當初實際收到的錢可能對不上,差額要人工處理**' end);

  select coalesce(sum(new_amt - old_amt), 0) into m from _chg136 where paid;
  insert into _chk136 values (3, '★★ 已收款單的金額變動',
    case when m >= 0 then '+' else '' end || '$' || to_char(m, 'FM999,999,999'),
    '負數代表原本多開了 —— 那些多出來的錢本來不該收');

  -- 逐張列出已收款且被改的（最需要人看的）
  insert into _chk136
  select 5, '⚠ ' || room || ' ' || ym,
         '$' || to_char(old_amt, 'FM999,999,999') || ' → $' || to_char(new_amt, 'FM999,999,999'),
         old_in || '~' || old_out || ' → ' || new_in || '~' || new_out || '　（已收款）'
    from _chg136 where paid order by room, ym;

  -- 未收款的由函式整批重建，沒有逐張記錄 —— 那些改了沒有後果
  select count(*) into n from public.orders o
   where o.imported_via = 'contract' and not o.paid;
  insert into _chk136 values (7, '未收款的自動單（重建後）', n || ' 張',
    '這些由 gen_contract_orders 整批重建 —— 錢還沒收，改成對的就是對的');

  -- 跟備份比對，看總共動了幾張
  select count(*) into n
    from public.orders o
    join public.orders_backup_136 b on b.id = o.id
   where o.checkin <> b.checkin or o.checkout <> b.checkout or o.amount <> b.amount;
  insert into _chk136 values (6, '★ 跟備份比對・有變動的', n || ' 張',
    '含新增與刪除的話看下面兩條');

  select count(*) into n from public.orders_backup_136 b
   where not exists (select 1 from public.orders o where o.id = b.id);
  insert into _chk136 values (6, '★ 被刪掉的', n || ' 張',
    '多產的期數、以及起日從月初移到月中之後讓開的舊列');

  /*
   * 重算之後每份契約的合計對不對得上「月租 × 月數」。
   * 這才是真正的驗收:前面都是「改了幾張」,這一條是「改完對不對」。
   */
  select count(*) into n
    from public.contracts c
    join (select contract_id, sum(amount) s from public.orders
           where imported_via = 'contract' group by contract_id) x on x.contract_id = c.id
   where c.start_date is not null and c.end_date is not null and c.monthly_rent is not null
     and c.active and c.room is not null and btrim(c.room) <> ''
     and abs(x.s - c.monthly_rent *
         ((extract(year from c.end_date)::int * 12 + extract(month from c.end_date)::int)
          - (extract(year from c.start_date)::int * 12 + extract(month from c.start_date)::int))) > 1;
  insert into _chk136 values (9, '★★ 合計對不上契約總額的',
    case when n = 0 then '✅ 全部對上' else '❌ ' || n || ' 份' end,
    '容許 1 元誤差（分攤捨去）。對不上代表算法還有洞,把那幾份列出來查');
end $$;

select item as "檢查項目", result as "結果", detail as "說明"
from _chk136 order by ord, item;
