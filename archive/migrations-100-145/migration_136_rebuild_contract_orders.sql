-- migration_136：把既有月租單的期間搬到契約週期上
--
-- ============================================================
-- 【這一支動的是「期間」，不是金額】（2026-08-16 修正）
--
-- 第一版打算把金額按日曆月比例拆開。那是錯的 ——
-- **訂單是繳款單，客戶繳整月**；要按比例拆的是營收認列，
-- 而那一段（gen_recognitions）本來就會依 checkin/checkout 自動做。
--
-- 所以這一支只搬期間:
--
--     2026-07-01 ~ 2026-08-01   →   2026-07-16 ~ 2026-08-16
--     金額 $170,000             →   金額 $170,000（不變）
--
-- 【為什麼這比原本的計畫安全得多】
--
--   · 已收款的單金額不變 → 跟 order_payments 的實收永遠對得上
--   · order_key 不變（還是 checkin 的年月）
--   · 只有營收認列會重新分配 —— 那正是要修的東西
--
-- 認列由 orders 的更新觸發器自動重算，這支不用碰。
--
-- 【還是要先看 135 的「房源重疊」那一段】
-- 同一間房兩份契約重疊的話，其中一份的月租單開不出來（order_key 會撞）。
-- 那是資料問題，跑這支之前先把契約日期修好。
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
  ms date; me date; p_start date; p_end date; full_end date; lease_end date;
  n int; full_n int; periods int; idx int; total numeric; acc numeric; amt numeric;
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
   * ⚠ 那批的期間仍然是日曆月。要不要一起改是另一個決定。
   */
  for ct in
    select * from public.contracts
     where start_date is not null and end_date is not null
       and monthly_rent is not null and monthly_rent > 0 and active
       and room is not null and btrim(room) <> ''
     order by room
  loop
    lease_end := (ct.end_date + 1)::date;
    total := 0; acc := 0; periods := 0; idx := 0;

    -- 第一趟：期數與總額（算法必須跟 gen_contract_orders 一字不差）
    p_start := ct.start_date;
    while p_start < lease_end loop
      full_end := (p_start + interval '1 month')::date;
      p_end    := least(full_end, lease_end);
      n        := p_end - p_start;
      full_n   := full_end - p_start;
      if n > 0 then
        total   := total + (case when n = full_n then ct.monthly_rent::numeric
                                 else ct.monthly_rent::numeric * n / full_n end);
        periods := periods + 1;
      end if;
      p_start := full_end;
    end loop;
    total := round(total);

    -- 第二趟：只搬已收款的那幾張（未收款的交給函式）
    p_start := ct.start_date;
    while p_start < lease_end loop
      full_end := (p_start + interval '1 month')::date;
      p_end    := least(full_end, lease_end);
      n        := p_end - p_start;
      full_n   := full_end - p_start;
      if n > 0 then
        idx := idx + 1;
        if idx = periods then amt := total - acc;
        else amt := trunc(case when n = full_n then ct.monthly_rent::numeric
                               else ct.monthly_rent::numeric * n / full_n end);
             acc := acc + amt; end if;

        ms := date_trunc('month', p_start)::date;
        me := (date_trunc('month', p_start) + interval '1 month')::date;

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
      p_start := full_end;
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
         else '搬期間而已 —— 金額不變,實收對得上。認列會跟著重算' end);

  /*
   * 【這一條應該是 $0】
   *
   * 這支只搬期間，不動金額 —— 訂單是繳款單，客戶繳整月。
   * 不是 0 就代表某份契約的月租跟已開的單對不起來
   * （像南京5:契約 $99,000 但單開 $98,000），
   * 那是**資料本來就有的差異**，不是這支造成的。要逐筆看。
   */
  select coalesce(sum(new_amt - old_amt), 0) into m from _chg136 where paid;
  insert into _chk136 values (3, '★★ 已收款單的金額變動',
    case when m = 0 then '✅ $0'
         else (case when m > 0 then '+' else '' end) || '$' || to_char(m, 'FM999,999,999') end,
    case when m = 0 then '只搬期間,金額沒動 —— 跟 order_payments 的實收永遠對得上'
         else '⚠ 不是 0：某些契約的月租跟已開的單本來就對不起來,逐筆看下面' end);

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
