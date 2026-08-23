-- migration_106：固定加費改成「跟著契約的繳別走」
--
-- ============================================================
-- 【這是一個還在線上收錯錢的 bug】
--
-- migration_86 的 gen_contract_fee_orders 不管契約是月繳、季繳還是年繳，
-- 一律 **每個月產生一張**費用單：
--
--     ms := (ms + interval '1 month')::date;
--
-- 但欄位的標籤寫的是「每期金額」，而使用者填的也是每一期的金額。
-- 於是年繳契約設了「管理費 3,000」之後：
--
--     使用者以為   一年收 3,000
--     系統實際做的 一年產 12 張 × 3,000 = 36,000
--
-- 季繳是 3 倍、半年繳是 6 倍、年繳是 12 倍。月繳剛好正確，
-- 而多數契約是月繳 —— 所以這個錯可以一直不被發現。
--
--
-- ============================================================
-- 【改成一期一張】
--
-- 期別的錨點是契約的起租月，每 step 個月一期：
--
--     月繳 1 · 季繳 3 · 半年繳 6 · 年繳 12
--
-- rc.start_ym / end_ym 用「包含它的那一期」來判斷，不是「等於期別起月」——
-- 舊資料的期別多半落在期中（因為以前是逐月產生的），
-- 用相等比對的話那些設定會整個消失。
--
--
-- ============================================================
-- 【已經收過的錢一律不動】
--
-- 改完之後，非月繳契約底下那些「期中月份」的費用單不該再存在。
-- 但其中可能有人已經收過款了 —— 那是真的進來的錢，刪掉營收會憑空少一塊。
--
--   未收款的期中月份 → 刪掉（沒有牽涉到錢）
--   已收款的期中月份 → **留著**，並在最後列出來
--
-- 留著會造成那一期的金額偏高（新的一張 ＋ 舊的幾張）。
-- 那是既成事實，要由人去看、去決定退款或沖銷，不是由這支 SQL 決定。
-- ============================================================


-- ── 一期幾個月 ─────────────────────────────────────
create or replace function public.cadence_step(p_cadence text)
returns int
language sql immutable as $fn$
  select case p_cadence
    when 'quarterly' then 3
    when 'halfyear'  then 6
    when 'yearly'    then 12
    else 1
  end;
$fn$;


-- ── 重寫產生函式 ───────────────────────────────────
create or replace function public.gen_contract_fee_orders(rc public.contract_recurring_charges)
returns integer
language plpgsql security definer set search_path = public as $fn$
declare
  ct       public.contracts;
  step     int;
  base     date;      -- 第一期的起月
  ms       date;      -- 目前這一期的起月
  pend     date;      -- 目前這一期的末月
  last_ms  date;      -- 租期最後一個月
  from_ms  date;      -- rc.start_ym
  to_ms    date;      -- rc.end_ym（null = 到租期結束）
  ymtxt    text;
  n        int := 0;
begin
  select * into ct from contracts where id = rc.contract_id;
  if not found or ct.start_date is null or ct.end_date is null then
    delete from orders
     where imported_via = 'contract_fee'
       and left(order_key, length('CRC_' || rc.id || '_')) = 'CRC_' || rc.id || '_' and paid = false;
    return 0;
  end if;

  /*
   * 【為什麼不用 LIKE】
   * LIKE 的 `_` 是萬用字元，而鍵前綴 'CRC_' 本身就有底線。
   * 這個專案為此吃過虧 —— lib/ltKey.ts 的註解記著曾經因此把
   * 2F-1/2F-2/2F-3 的收款記錄整批清空。一律用 left() 比對。
   */

  -- 停用：未收款的清掉，已收款的留著。**這一條就是「冰箱退掉了」的處理。**
  if not rc.active then
    delete from orders
     where imported_via = 'contract_fee'
       and left(order_key, length('CRC_' || rc.id || '_')) = 'CRC_' || rc.id || '_' and paid = false;
    return 0;
  end if;

  step    := public.cadence_step(ct.cadence);
  base    := date_trunc('month', ct.start_date)::date;
  -- 迄日先退一天：租期到 2028-10-01 表示住到 9/30，最後一個月是 2028-09
  last_ms := date_trunc('month', ct.end_date - 1)::date;
  from_ms := greatest(to_date(rc.start_ym || '01', 'YYYYMMDD'), base);
  to_ms   := case when rc.end_ym is null then last_ms
                  else least(to_date(rc.end_ym || '01', 'YYYYMMDD'), last_ms) end;

  /*
   * 先把「不該存在」的未收款費用單清掉，再重產。
   *
   * 兩種不該存在：
   *   1. 落在 from_ms ~ to_ms 之外的（改了期別或縮短租期）
   *   2. 不是期別起月的（這一版改成一期一張之後，期中月份全部作廢）
   *
   * 第 2 種用「距離起租月的月數能不能被 step 整除」判斷。
   * paid = false 是整支函式的核心約束 —— 收過的錢不因為設定改了而消失。
   */
  delete from orders o
   where o.imported_via = 'contract_fee'
     and left(o.order_key, length('CRC_' || rc.id || '_')) = 'CRC_' || rc.id || '_'
     and o.paid = false
     and (
       o.checkin < from_ms
       or o.checkin > to_ms
       or mod(
            ( (extract(year from o.checkin)::int * 12 + extract(month from o.checkin)::int)
            - (extract(year from base)::int      * 12 + extract(month from base)::int) ),
            step) <> 0
     );

  -- 一期一張。ms 從第一期起月開始，每次跳 step 個月。
  ms := base;
  while ms <= last_ms loop
    pend := (ms + (step || ' month')::interval - interval '1 day')::date;

    /*
     * 收不收這一期，看「這一期有沒有蓋到 from_ms ~ to_ms」——
     * 不是看期別起月等不等於 rc.start_ym。
     *
     * 舊資料的 start_ym 多半落在期中（以前是逐月產生的，
     * 使用者選得到任何一個月），用相等比對的話那些設定會整個消失，
     * 而且是「儲存成功但一期都不見了」那種沒有線索的消失。
     */
    if pend >= from_ms and ms <= to_ms then
      ymtxt := to_char(ms, 'YYYYMM');
      insert into orders (order_key, source, estate_id, property_raw, guest_name,
        checkin, checkout, nights, amount, deposit, fee_type, item_name, note,
        imported_via, contract_id, paid)
      values ('CRC_' || rc.id || '_' || ymtxt, 'oneoff', ct.estate_id, ct.room, ct.tenant_name,
        ms, ms, 0, rc.amount, 0, rc.fee_type, rc.item_name, coalesce(rc.note, '契約固定加費'),
        'contract_fee', ct.id, false)
      on conflict (order_key) do update
        set fee_type = excluded.fee_type,
            item_name = excluded.item_name,
            estate_id = excluded.estate_id,
            property_raw = excluded.property_raw,
            guest_name = excluded.guest_name,
            -- 金額只改未收款的 —— 錢收了之後金額是既成事實。
            amount = case when orders.paid then orders.amount else excluded.amount end
        where orders.imported_via = 'contract_fee';
      n := n + 1;
    end if;

    ms := (ms + (step || ' month')::interval)::date;
  end loop;

  return n;
end $fn$;

comment on function public.gen_contract_fee_orders is
  '固定加費一期一張,期別跟著契約的繳別（月/季/半年/年）。'
  '2026-08 之前是不管繳別一律每月一張,年繳契約因此多收了 11 個月。';


-- ============================================================
-- 全量重產
--
-- 觸發器只在設定或契約變動時跑，既有資料不會自己修正 —— 要主動重跑一次。
-- ============================================================

do $$
declare r public.contract_recurring_charges; n int := 0;
begin
  for r in select * from public.contract_recurring_charges loop
    perform public.gen_contract_fee_orders(r);
    n := n + 1;
  end loop;
  raise notice '已重產 % 筆固定加費設定', n;
end $$;


-- ============================================================
-- 確認
-- ============================================================

-- 1) 非月繳契約底下,還留著「期中月份」的已收款費用單 —— 需要人工處理
--
--    這些是**改版前多收的錢**。系統不會自己刪（錢真的收了），
--    也不會自己退。列出來讓人去看要退款還是沖銷。
select
  e.name                                       as "物業",
  ct.room                                      as "房源",
  ct.tenant_name                               as "租戶",
  ct.cadence                                   as "繳別",
  o.checkin                                    as "費用日",
  o.fee_type                                   as "科目",
  o.amount                                     as "金額",
  '改版前每月產生,這一筆落在期中且已收款 —— 請確認是否要退款或沖銷' as "說明"
from public.orders o
join public.contracts ct on ct.id = o.contract_id
left join public.estates e on e.id = ct.estate_id
where o.imported_via = 'contract_fee'
  and o.paid
  and public.cadence_step(ct.cadence) > 1
  and mod(
        ( (extract(year from o.checkin)::int * 12 + extract(month from o.checkin)::int)
        - (extract(year from date_trunc('month', ct.start_date))::int * 12
           + extract(month from date_trunc('month', ct.start_date))::int) ),
        public.cadence_step(ct.cadence)) <> 0
order by e.sort nulls last, ct.room, o.checkin;

-- 2) 總覽
select
  (select count(*) from public.contract_recurring_charges)                    as "加費設定數",
  (select count(*) from public.contract_recurring_charges rc
     join public.contracts c on c.id = rc.contract_id
    where public.cadence_step(c.cadence) > 1)                                as "非月繳的設定數",
  (select count(*) from public.orders where imported_via = 'contract_fee')    as "費用單總數",
  (select count(*) from public.orders where imported_via = 'contract_fee' and paid)
                                                                             as "其中已收款";

-- 3) 每張非月繳契約現在每期收多少（改版後應該等於設定的金額，不再乘上月數）
select
  ct.room                                      as "房源",
  ct.tenant_name                               as "租戶",
  ct.cadence                                   as "繳別",
  count(*)                                     as "產生期數",
  min(o.amount)                                as "每期金額",
  sum(o.amount)                                as "全期合計"
from public.orders o
join public.contracts ct on ct.id = o.contract_id
where o.imported_via = 'contract_fee'
  and public.cadence_step(ct.cadence) > 1
group by ct.room, ct.tenant_name, ct.cadence
order by ct.room;


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    raise notice '%', (select public.record_migration('106_fee_follow_cadence'));
  else
    raise notice '尚未建立 schema_migrations（migration_70），這支沒有被記錄';
  end if;
end $$;
