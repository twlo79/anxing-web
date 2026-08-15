-- migration_78：契約產生的月租單要帶「契約類別」
--
-- 【問題】
-- gen_contract_orders 產生月租單時，來源是寫死的：
--     values (kbase || ymtxt, 'longterm', ...)
--                             ↑ 不管契約類別是什麼，一律 longterm
--
-- 但 contracts.type 有三種：longterm / company / office。
-- 所以辦公室出租與公司登記的契約，產生出來的月租單全部被標成「長租」。
--
-- 【症狀】
--   1. 營收報表的「依房源」段出現公司登記的房間（時兆 2F-28）——
--      那不是租金收入，卻被算進物業營收。
--   2. 公司登記那一段的金額越來越少：202605 是 21,260、202606 是 11,896、
--      202607 只剩 6,896。錢沒有不見，是跑到「長租」那一欄去了。
--
-- 既有的列沒被改掉，是因為 on conflict do update 沒有更新 source ——
-- 所以舊資料還是對的，只有新產生的月份會跑錯。這讓問題看起來像「資料越來越怪」
-- 而不是「有個 bug」，更難查。
--
-- 【修法】
--   1. source 依 ct.type 決定
--   2. on conflict 時一併更正 source，把已經標錯的列拉回來
--   3. 跑一次 rebuild_contract_orders() 讓所有契約重新對齊
--
-- 【護欄】
-- 這支只搬分類，一分錢都不該多也不該少。所以動之前記下總營收，
-- 動完再比一次，不同就 raise exception 中止。

create or replace function public.gen_contract_orders(ct public.contracts)
 returns void language plpgsql
as $function$
declare
  ms date; me date; ymtxt text; kbase text; src text;
begin
  -- 房號不是必要條件（migration_77）。真正必要的是租期。
  if ct.start_date is null or ct.end_date is null then return; end if;

  kbase := case
    when coalesce(ct.room, '') <> '' then 'LT_' || ct.room || '_'
    else 'LTC_' || ct.id || '_'
  end;

  -- 契約類別 → 訂單來源。營收報表就是靠這一欄分段的。
  -- 沒對應到的一律當長租 —— 將來多一種類別時，錢會落在長租而不是消失。
  src := case ct.type
    when 'office'  then 'office'
    when 'company' then 'company'
    else 'longterm'
  end;

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
      -- source 一定要一起更新，否則標錯的舊列永遠不會被修正。
      -- 這一欄不影響金額，就算是已收款的列也應該歸到正確的分類。
      set source = excluded.source,
          guest_name = excluded.guest_name,
          estate_id = excluded.estate_id,
          contract_id = excluded.contract_id,
          property_raw = excluded.property_raw,
          -- 金額仍然只改未收款的 —— 錢收了之後金額是既成事實
          amount = case when orders.paid then orders.amount else excluded.amount end
      where orders.imported_via = 'contract';
    ms := me;
  end loop;
end $function$;


-- ── 重新對齊所有契約 ───────────────────────────────
do $$
declare
  n int; before_total bigint; after_total bigint;
  n_office int; n_company int;
begin
  select coalesce(sum(month_amount), 0)::bigint into before_total from revenue_recognitions;

  select public.rebuild_contract_orders() into n;

  select count(*) into n_office  from orders where imported_via = 'contract' and source = 'office';
  select count(*) into n_company from orders where imported_via = 'contract' and source = 'company';
  raise notice '重建 % 張契約：辦公室 % 列、公司登記 % 列', n, n_office, n_company;

  select coalesce(sum(month_amount), 0)::bigint into after_total from revenue_recognitions;
  if before_total <> after_total then
    raise exception '總營收被動到了：% → %，差 %。這支只該搬分類，不該改金額。',
      before_total, after_total, after_total - before_total;
  end if;
  raise notice '總營收不變：%', after_total;
end $$;


-- ============================================================
-- 驗證 —— 建三種類別各一張契約再回滾
--
-- 包在 exception 裡：驗證是附加的，不該有能力把上面的修正一起回滾掉
-- （migration_76 就是這樣連續兩次「顯示成功但其實什麼都沒建」）。
-- ============================================================
do $$
declare eid uuid; cid uuid; got text; t text;
begin
  begin
    select id into eid from estates order by sort, name limit 1;
    if eid is null then raise notice '沒有物業，跳過驗證'; return; end if;

    foreach t in array array['longterm', 'company', 'office'] loop
      insert into contracts (name, type, estate_id, room, tenant_name,
                             start_date, end_date, amount_per_period, cadence, monthly_rent, active)
      values ('__類別測試__' || t, t, eid, null, '__測試__',
              date_trunc('month', current_date)::date,
              (date_trunc('month', current_date) + interval '1 month')::date,
              1000, 'monthly', 1000, true)
      returning id into cid;

      select source into got from orders where contract_id = cid limit 1;
      if got is distinct from t then
        raise exception '契約類別 % 產生的訂單來源是 %，應該是 %', t, got, t;
      end if;

      delete from orders where contract_id = cid;
      delete from contracts where id = cid;
    end loop;

    raise notice '三種契約類別都對應到正確的訂單來源';
  exception when others then
    begin
      delete from orders where guest_name = '__測試__';
      delete from contracts where tenant_name = '__測試__';
    exception when others then null;
    end;
    raise warning '⚠ 契約類別驗證沒過：% —— 函式已經更新，但這一條要查', sqlerrm;
  end;
end $$;


-- ============================================================
-- 驗證用的查詢
-- ============================================================

-- 各類別的月租單筆數。公司登記與辦公室不該是 0。
select o.source as 訂單來源, count(*) as 筆數, sum(o.amount)::bigint as 金額
from public.orders o
where o.imported_via = 'contract'
group by 1 order by 3 desc;

-- 還有沒有「公司登記/辦公室的契約，訂單卻標成長租」的
select c.type as 契約類別, o.source as 訂單來源, count(*) as 筆數
from public.orders o
join public.contracts c on c.id = o.contract_id
where o.imported_via = 'contract' and c.type is distinct from o.source
group by 1, 2;
-- 預期：0 筆


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    raise notice '%', (select public.record_migration('78_contract_order_source'));
  else
    raise notice '尚未建立 schema_migrations（migration_70），這支沒有被記錄';
  end if;
end $$;
