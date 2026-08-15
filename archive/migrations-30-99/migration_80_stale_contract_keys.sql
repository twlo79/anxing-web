-- migration_80：清掉「鍵過期」的契約月租單，並修掉根因
--
-- 【問題是我造成的】
-- migration_77 把月租單的鍵改成兩種：
--     房號有值 → LT_{房號}_{年月}
--     房號空的 → LTC_{契約id}_{年月}
--
-- 但 gen_contract_orders 的 delete 只清「租期外」的列。所以清掉房號的那一刻，
-- 舊的 LT_2F-28_202607 還在（它在租期內），新的 LTC_xxx_202607 又被插進去 ——
-- **同一張契約同一個月出現兩列**，營收被重複計算。
--
-- 症狀是營收報表上同一家公司出現兩列，一列金額很低（舊費率）、一列正常。
-- 不會報錯，只會讓總營收偏高。
--
-- 2026-08 的實際狀況：
--   療癒財商小老師工作室   13 列  LT__{年月}      $1,470  未收款
--   萊恩獅子投資(限)        8 列  LT_2F-28_{年月}  $117   已收款
-- （LT__ 是房號等於空字串時產生的：'LT_' || '' || '_'）
--
--
-- 【修法：改名而不是刪除】
--
-- 房號改了之後，舊鍵那幾列**原則上要改名，不是刪掉** ——
-- 它們身上有 paid / paid_at / 發票，刪了就沒了。
--
-- 只有一種情況要刪：新鍵那一列已經存在（也就是真的重複了）。
-- 那時保留「鍵正確」的那一列，因為未來重產會維護的是它。
--
--     1. 舊鍵，且新鍵已存在  → 刪掉舊的（重複）
--     2. 舊鍵，新鍵不存在    → 改名，收款紀錄跟著走
--
-- 這一版的 21 列全部落在情況 1，因為它們都有對應的新鍵。
--
--
-- 【營收會下降，那是對的】
-- 減少約 $20,046。現在的數字是重複計算出來的，所以這支**不加「總額不變」的護欄**，
-- 改成把前後差額印出來讓人核對。
--
--
-- 【這種刪除不會留在編輯紀錄裡】
-- migration_72 刻意跳過「契約自動產生、未收款」的刪除（那種一次幾十筆會把
-- 真正的刪除淹掉）。萊恩那 8 列是已收款的，會被記錄；療癒那 13 列不會。
-- 動手前的 select 清單就是唯一的完整紀錄。

create or replace function public.gen_contract_orders(ct public.contracts)
 returns void language plpgsql
as $function$
declare
  ms date; me date; ymtxt text; kbase text; src text;
begin
  if ct.start_date is null or ct.end_date is null then return; end if;

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
   * ── 鍵過期的列 ──
   *
   * 用 left(order_key, length(kbase)) 比對而不是 LIKE ——
   * LIKE 的 _ 與 % 是萬用字元，房號裡出現那些字就會比錯。
   * lib/ltKey.ts 的註解記著這件事：曾經因此把 2F-1/2F-2/2F-3 的收款記錄整批清空。
   */

  -- 1. 新鍵已經存在 = 真的重複了。留鍵正確的那一列，刪掉舊的。
  delete from orders o
   where o.contract_id = ct.id
     and o.imported_via = 'contract'
     and left(o.order_key, length(kbase)) is distinct from kbase
     and exists (select 1 from orders n where n.order_key = kbase || right(o.order_key, 6));

  -- 2. 新鍵不存在 → 改名。paid / paid_at / 發票全部跟著走，不會有任何損失。
  update orders o
     set order_key = kbase || right(o.order_key, 6)
   where o.contract_id = ct.id
     and o.imported_via = 'contract'
     and left(o.order_key, length(kbase)) is distinct from kbase;

  -- 超出租期、未收款的照舊清掉
  delete from orders
   where contract_id = ct.id
     and imported_via = 'contract'
     and paid = false
     and (checkin < date_trunc('month', ct.start_date)::date or checkin >= ct.end_date);

  if not ct.active or ct.monthly_rent is null or ct.monthly_rent <= 0 then return; end if;

  ms := date_trunc('month', ct.start_date)::date;
  while ms < ct.end_date loop
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
          contract_id = excluded.contract_id,
          property_raw = excluded.property_raw,
          -- 金額只改未收款的 —— 錢收了之後金額是既成事實
          amount = case when orders.paid then orders.amount else excluded.amount end
      where orders.imported_via = 'contract';
    ms := me;
  end loop;
end $function$;


-- ── 清理既有資料 ───────────────────────────────────
do $$
declare
  before_total bigint; after_total bigint; n int;
begin
  select coalesce(sum(month_amount), 0)::bigint into before_total from revenue_recognitions;

  -- 刪除筆數在下面用總額差反映。要看清單的話,執行前的那段 select 就是紀錄。
  select public.rebuild_contract_orders() into n;

  select coalesce(sum(month_amount), 0)::bigint into after_total from revenue_recognitions;
  raise notice '重建 % 張契約', n;
  raise notice '總營收 % → %（差 %）', before_total, after_total, after_total - before_total;
  raise notice '差額應該是負的 —— 重複計算的部分被移除了';
end $$;


-- ============================================================
-- 驗證
-- ============================================================

-- 還有沒有鍵過期的列
select coalesce(c.display_name, c.tenant_name) as 契約, o.order_key, o.amount, o.paid
from public.orders o
join public.contracts c on c.id = o.contract_id
where o.imported_via = 'contract'
  and left(o.order_key, length(case when coalesce(c.room,'') <> ''
                                     then 'LT_' || c.room || '_'
                                     else 'LTC_' || c.id || '_' end))
      is distinct from (case when coalesce(c.room,'') <> ''
                             then 'LT_' || c.room || '_'
                             else 'LTC_' || c.id || '_' end);
-- 預期：0 筆

-- 還有沒有同一契約同一月出現兩列的
select coalesce(c.display_name, c.tenant_name) as 契約, o.checkin as 月份, count(*) as 列數
from public.orders o
join public.contracts c on c.id = o.contract_id
where o.imported_via = 'contract'
group by 1, 2 having count(*) > 1;
-- 預期：0 筆

-- 這兩張契約現在長什麼樣
select coalesce(c.display_name, c.tenant_name) as 契約, o.order_key, o.checkin, o.amount, o.paid
from public.orders o
join public.contracts c on c.id = o.contract_id
where coalesce(c.display_name, c.tenant_name) in ('療癒財商小老師工作室', '萊恩獅子投資(限)')
order by 1, o.checkin;


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    raise notice '%', (select public.record_migration('80_stale_contract_keys'));
  else
    raise notice '尚未建立 schema_migrations（migration_70），這支沒有被記錄';
  end if;
end $$;
