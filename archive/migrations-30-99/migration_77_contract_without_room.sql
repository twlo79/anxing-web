-- migration_77：契約可以只掛物業（沒有房號）
--
-- 【問題】
-- gen_contract_orders 第一行是：
--     if ct.room is null or ... then return; end if;
--
-- 房號空的就一列都不產。畫面上的症狀是「應收 $0、沒有確認收款按鈕」——
-- 看起來像金額算錯，實際上是根本沒有月租單可以收，而且沒有任何錯誤訊息。
--
-- 2026-08 遇到：公司登記的契約本來就不屬於任何一間房，房號一刪整張契約就停擺。
--
-- 【根本原因】
-- 房號是 order_key 的組成部分：LT_{房號}_{年月}
-- 而 contracts.room 是純文字，沒有外鍵 —— 它同時扮演「給人看的名稱」與
-- 「當鍵用的識別碼」。拿顯示值當鍵，改名或刪掉就會無聲地斷掉。
--
-- 【這一版怎麼修】
-- 房號有值：維持 LT_{房號}_    ← 既有幾千筆訂單的鍵完全不動，不需要資料搬遷
-- 房號空的：改用 LTC_{契約id}_ ← 契約 id 不會變，不會再斷
--
-- 沒有一次全部改成契約 id，是因為那要改寫已經收過錢的訂單鍵，
-- 而 paid / paid_at / 發票都掛在上面 —— 搬遷寫錯就是收款紀錄對不上。
-- 房號當鍵這個設計缺陷留著，等真的需要改房號時再處理。
--
-- 【順便修掉一個潛在的誤刪】
-- 原本的 delete 用 `order_key like 'LT_' || ct.room || '_%'`。
-- SQL LIKE 的 "_" 是萬用字元，所以房號 2F-1 的條件會連 2F-10 ~ 2F-19 一起掃到，
-- 可能刪掉別間房未收款的月租單。前端有 lib/ltKey.ts 擋這件事，SQL 這邊沒有。
-- 改用 contract_id = ct.id，精確而且不需要處理跳脫字元。

create or replace function public.gen_contract_orders(ct public.contracts)
 returns void language plpgsql
as $function$
declare
  ms date; me date; ymtxt text; kbase text;
begin
  -- 房號不再是必要條件。真正必要的是租期 —— 沒有起訖就不知道要產哪幾個月。
  if ct.start_date is null or ct.end_date is null then return; end if;

  -- 鍵的基底。房號空字串也算沒有 —— 前端的下拉留白送過來是 ''，不是 null。
  kbase := case
    when coalesce(ct.room, '') <> '' then 'LT_' || ct.room || '_'
    else 'LTC_' || ct.id || '_'
  end;

  -- 刪除超出租期、未收款、由契約自動生成的月份。
  -- 用 contract_id 而不是 order_key like —— 見檔頭說明。
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
    values (kbase || ymtxt, 'longterm', ct.estate_id, ct.room, ct.tenant_name,
      ms, me, (me - ms), ct.monthly_rent, 0, '契約應收', 'contract', ct.id, false)
    on conflict (order_key) do update
      set amount = excluded.amount, guest_name = excluded.guest_name,
          estate_id = excluded.estate_id, contract_id = excluded.contract_id,
          property_raw = excluded.property_raw
      where orders.imported_via = 'contract' and orders.paid = false;  -- 匯入資料與已收款不覆蓋
    ms := me;
  end loop;
end $function$;


-- ── 把現在停擺的契約補起來 ─────────────────────────
do $$
declare n int; before_n bigint; after_n bigint;
begin
  select count(*) into before_n from orders where imported_via = 'contract';
  select public.rebuild_contract_orders() into n;
  select count(*) into after_n from orders where imported_via = 'contract';
  raise notice '重建 % 張契約：月租單 % → %（新增 %）', n, before_n, after_n, after_n - before_n;
end $$;


-- ============================================================
-- 驗證 —— 建一張沒有房號的契約再回滾
--
-- 只 select 驗證不到函式跑不跑得動（migration_65 就是這樣漏掉的）。
-- ============================================================
do $$
declare eid uuid; cid uuid; n int;
begin
  select id into eid from estates order by sort, name limit 1;
  if eid is null then raise notice '沒有物業，跳過驗證'; return; end if;

  insert into contracts (name, type, estate_id, room, tenant_name,
                         start_date, end_date, amount_per_period, cadence, monthly_rent, active)
  values ('__無房號測試__', 'longterm', eid, null, '__測試__',
          date_trunc('month', current_date)::date,
          (date_trunc('month', current_date) + interval '3 months')::date,
          1000, 'monthly', 1000, true)
  returning id into cid;

  select count(*) into n from orders where contract_id = cid;
  if n <> 3 then
    raise exception '沒有房號的契約應該產生 3 個月，實際 %', n;
  end if;

  if not exists (select 1 from orders where contract_id = cid and order_key like 'LTC!_%' escape '!') then
    raise exception '鍵的格式不對，應該是 LTC_<契約id>_<年月>';
  end if;

  -- 房源留白 = 整棟，property_raw 應該是空的而不是被塞值
  if exists (select 1 from orders where contract_id = cid and property_raw is not null) then
    raise exception '沒有房號的契約不該有 property_raw';
  end if;

  raise notice '無房號契約正常：產生 % 個月，鍵是 LTC_ 開頭', n;

  delete from orders where contract_id = cid;
  delete from contracts where id = cid;
end $$;


-- 目前有哪些契約沒有房號（這些以前完全產不出月租單）
select coalesce(c.display_name, c.tenant_name, c.name) as 契約,
       e.name as 物業, c.type as 類別, c.cadence as 繳別,
       c.monthly_rent as 月租, c.start_date as 起, c.end_date as 迄,
       (select count(*) from orders o where o.contract_id = c.id) as 月租單數
from public.contracts c
left join public.estates e on e.id = c.estate_id
where coalesce(c.room, '') = '' and c.active
order by e.sort, c.start_date;
-- 預期：月租單數不再是 0


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    raise notice '%', (select public.record_migration('77_contract_without_room'));
  else
    raise notice '尚未建立 schema_migrations（migration_70），這支沒有被記錄';
  end if;
end $$;
