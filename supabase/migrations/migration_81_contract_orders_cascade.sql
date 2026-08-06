-- migration_81：刪契約 → 它的營收一起消失（並讓「換房源重複算」不可能發生）
--
-- ============================================================
-- 【你要解決的兩件事】
--
--   1. 刪掉契約之後，它的營收還留著
--   2. 編輯契約換了房源，同一個月被算兩次
--
-- 這兩件事都是同一個病：**沒有人強制「一張契約一個月只有一列，契約沒了列也沒了」**。
-- 到目前為止靠的都是觸發器裡的邏輯自己記得要清乾淨。邏輯一有洞就漏，
-- 而且漏出來的東西看不見 —— 契約在畫面上已經不存在了，它的錢還在總營收裡。
--
-- 這一支不再靠邏輯，改成靠資料庫的約束：
--
--   外鍵 on delete cascade   → 契約沒了，訂單一定跟著沒
--   唯一索引 (契約, 月份)     → 同一張契約同一個月，第二列插不進去
--
-- 約束的意義是「就算未來的程式寫錯，資料庫也會擋下來」。
--
--
-- ============================================================
-- 【現況：這一支會刪掉多少】
--
--   757 列孤兒訂單，全部是已收款
--   來自 39 張已刪除的契約
--   $888,573
--   2022-11 → 2028-10
--
-- 這些列在畫面上完全看不到（契約已經不存在），但它們的 revenue_recognitions
-- 還在，所以還在灌總營收。刪掉之後 2022 年起的營收數字會下降 ——
-- **那是對的**，現在的數字才是虛的。
--
-- ⚠️ 執行前請先跑一次下面的「執行前清單」，把結果存下來或截圖。
--
--
-- ============================================================
-- 【可以還原】
--
-- 刪掉的整列會先抄進 deleted_contract_orders_81。
-- 那張表存的是完整的 jsonb，發現刪錯了可以整列插回去。
-- 確認沒問題之後可以自己 drop 掉那張表。
--
--
-- ============================================================
-- 【為什麼不記進編輯紀錄】
--
-- 757 筆刪除會把 data_audit 塞爆，真正該看的手動刪除會被淹掉。
-- 所以這一段暫時關掉 orders 的稽核觸發器，改用上面那張備份表當紀錄 ——
-- 備份表存的資訊比 data_audit 更完整（有契約 id、有刪除原因）。
-- 之後從畫面刪東西照樣會被記錄，這只影響這一次的批次清理。


-- ============================================================
-- 執行前清單 —— 先跑這段，把結果留下來
-- ============================================================

select o.guest_name as 客戶, o.order_key as 訂單鍵, o.checkin as 月份,
       o.amount as 金額, o.paid as 已收款, o.imported_via as 來源
from public.orders o
where o.contract_id is not null
  and not exists (select 1 from public.contracts c where c.id = o.contract_id)
order by o.guest_name, o.checkin;


-- ============================================================
-- 1. 備份
-- ============================================================

create table if not exists public.deleted_contract_orders_81 (
  id           uuid primary key,
  contract_id  uuid not null,
  guest_name   text,
  order_key    text,
  checkin      date,
  amount       numeric,
  paid         boolean,
  imported_via text,
  row_json     jsonb not null,          -- 整列，還原用
  deleted_at   timestamptz not null default now()
);

comment on table public.deleted_contract_orders_81 is
  'migration_81 刪掉的孤兒訂單（來源契約已不存在）。row_json 是完整的原始列,'
  '確認無誤後可以 drop。還原:insert into orders select * from jsonb_populate_record(null::orders, row_json)';

alter table public.deleted_contract_orders_81 enable row level security;
drop policy if exists dco81_read on public.deleted_contract_orders_81;
create policy dco81_read on public.deleted_contract_orders_81
  for select using (current_role_of() = 'super_admin');


-- ============================================================
-- 2. 清掉孤兒
--
-- 注意這裡**不限 imported_via**。migration_80 的查詢只看 'contract'，
-- 但契約加費（CFEE_，imported_via='manual'）與續約（'extend'）同樣掛著
-- contract_id。只要有一列漏掉，第 3 步的外鍵就建不起來。
-- ============================================================

do $$
declare
  n int; amt bigint; rec record;
begin
  insert into public.deleted_contract_orders_81
    (id, contract_id, guest_name, order_key, checkin, amount, paid, imported_via, row_json)
  select o.id, o.contract_id, o.guest_name, o.order_key, o.checkin,
         o.amount, o.paid, o.imported_via, to_jsonb(o)
  from public.orders o
  where o.contract_id is not null
    and not exists (select 1 from public.contracts c where c.id = o.contract_id)
  on conflict (id) do nothing;

  -- 先看清楚是哪些來源要被刪，免得只盯著月租單、忘了加費也在裡面
  for rec in
    select imported_via, count(*) n, coalesce(sum(amount), 0)::bigint amt
    from public.deleted_contract_orders_81 group by 1 order by 2 desc
  loop
    raise notice '  來源 % → % 列,$%', rec.imported_via, rec.n, rec.amt;
  end loop;

  select count(*), coalesce(sum(amount), 0)::bigint into n, amt
  from public.deleted_contract_orders_81;
  raise notice '備份 % 列,合計 $%', n, amt;

  -- 稽核觸發器暫停 —— 理由見檔頭。備份表就是這次的紀錄。
  alter table public.orders disable trigger trg_data_audit_orders;

  delete from public.orders o
  where o.contract_id is not null
    and not exists (select 1 from public.contracts c where c.id = o.contract_id);
  get diagnostics n = row_count;

  alter table public.orders enable trigger trg_data_audit_orders;

  raise notice '刪除 % 列（revenue_recognitions 由 on delete cascade 跟著清）', n;
end $$;


-- ============================================================
-- 3. 外鍵：契約沒了，訂單跟著沒
--
-- 這是你要的「刪契約後營收就消失」。
--
-- 為什麼是 cascade 而不是 set null：
-- set null 會留下一堆沒有出處的訂單，跟現在的孤兒只差在看得見。
-- 你要的是數字乾淨、不重複，那就讓它整條線一起走。
--
-- 【代價，要記得】
-- 刪一張契約 = 它所有的月租單（含已收款）、加費、續約，以及那些訂單底下的
-- 營收認列，全部一起消失，而且不可逆。
-- 所以**契約不要拿來當「結束了就刪掉」用** —— 租約到期就把 active 關掉，
-- 契約留著，歷史才留得住。刪除只該用在「這張契約根本就建錯了」。
-- ============================================================

alter table public.orders drop constraint if exists orders_contract_id_fkey;
alter table public.orders
  add constraint orders_contract_id_fkey
  foreign key (contract_id) references public.contracts(id) on delete cascade;

comment on constraint orders_contract_id_fkey on public.orders is
  '刪契約會連同它所有的訂單與營收認列一起刪掉,包含已收款的。'
  '要結束租約請關 active,不要刪契約。';

-- 外鍵沒有索引的話，每次刪契約都要全表掃 orders
create index if not exists idx_orders_contract_id
  on public.orders (contract_id) where contract_id is not null;


-- ============================================================
-- 4. 唯一索引：同一張契約同一個月只能有一列
--
-- 這一條專門擋「換房源之後被算兩次」。
--
-- 只管 imported_via='contract'（自動產生的月租單）——
-- 加費（manual）與續約（extend）本來就可能同月多筆，那是正常的。
-- ============================================================

-- 建索引之前先把既有的重複收掉，否則索引建不起來
do $$
declare n int;
begin
  with keyed as (
    -- 每一列的「正確鍵前綴」是什麼，以及它現在的鍵對不對
    select o.id, o.contract_id, o.checkin, o.paid,
           (left(o.order_key, length(k.kbase)) = k.kbase) as key_ok
    from public.orders o
    join public.contracts c on c.id = o.contract_id
    cross join lateral (select case when coalesce(c.room, '') <> ''
                                    then 'LT_' || c.room || '_'
                                    else 'LTC_' || c.id || '_' end as kbase) k
    where o.imported_via = 'contract'
  ),
  ranked as (
    -- 留鍵正確的那一列（未來重產維護的是它），其次留已收款的
    select id, row_number() over (
             partition by contract_id, checkin
             order by key_ok desc, paid desc, id) as rn
    from keyed
  )
  delete from public.orders o
   using ranked r
   where r.id = o.id and r.rn > 1;
  get diagnostics n = row_count;
  raise notice '建索引前清掉 % 列同月重複', n;
end $$;

create unique index if not exists uq_contract_order_month
  on public.orders (contract_id, checkin)
  where imported_via = 'contract' and contract_id is not null;

comment on index public.uq_contract_order_month is
  '一張契約一個月只能有一列月租單。擋的是「改房號之後舊鍵與新鍵並存」造成的重複計算。'
  '這是硬約束 —— 就算 gen_contract_orders 未來寫錯,資料庫也會擋下來。';


-- ============================================================
-- 5. gen_contract_orders：改房號時先收斂成一列，再改名
--
-- migration_80 的版本有個洞：
--   「舊鍵，新鍵不存在 → 改名」如果同一個月有兩個不同的舊鍵
--   （例如 LT__202606 和 LT_2F-28_202606 都要變成 LTC_x_202606），
--   兩列會改成同一個鍵 → 主鍵衝突 → 整個存檔失敗。
--
-- 這一版改成：先按「一契約一月一列」收斂，再改名。
-- ============================================================

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

  -- 1. 同一個月多列 → 收斂成一列。
  --    留鍵正確的（未來重產維護的是它），其次留已收款的。
  --    這一步取代 migration_80 的「新鍵存在就刪舊鍵」，並且多擋了
  --    「兩個不同舊鍵改名後撞在一起」那種會直接讓存檔失敗的情況。
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


-- ============================================================
-- 6. 刪契約時，把它帶走了什麼寫進編輯紀錄
--
-- cascade 之後那些訂單就不存在了，事後想知道「那張契約刪掉時
-- 到底有多少錢」只能靠這一行。
--
-- 為什麼不靠 orders 自己的稽核觸發器：
-- cascade 刪除確實會觸發子表的 row trigger，所以已收款的月租單會各留一列。
-- 但那是一堆散落的列，沒有人會去把它們拼回來。這裡多留一行摘要，
-- 讓「契約」那一列自己就說得清楚。
--
-- 這個觸發器**不擋刪除** —— 只是記錄。
--
-- 注意：刪一張契約在編輯紀錄上會出現兩列 ——
-- migration_72 的通用觸發器記「契約這一列的原始內容」，
-- 這一支記「它帶走了多少錢」。兩件事都要留，所以不合併。
-- ============================================================

create or replace function public.log_contract_delete_impact() returns trigger
language plpgsql security definer set search_path = public as $fn$
declare
  n int; paid_n int; paid_amt numeric; amt numeric; d0 date; d1 date;
begin
  select count(*), count(*) filter (where paid), coalesce(sum(amount), 0),
         coalesce(sum(amount) filter (where paid), 0), min(checkin), max(checkin)
    into n, paid_n, amt, paid_amt, d0, d1
  from orders where contract_id = old.id;

  if n = 0 then return old; end if;

  insert into data_audit (user_id, table_name, record_id, label, action, changes)
  values (
    auth.uid(), 'contracts', old.id,
    coalesce(old.display_name, old.tenant_name, '(未命名契約)')
      || ' —— 連帶刪除 ' || n || ' 筆訂單,已收款 ' || paid_n || ' 筆 $' || round(paid_amt),
    'delete',
    jsonb_build_object(
      '_連帶刪除', jsonb_build_object(
        '訂單筆數', n, '已收款筆數', paid_n,
        '已收款金額', round(paid_amt), '訂單總額', round(amt),
        '期間', coalesce(to_char(d0, 'YYYY-MM'), '—') || ' ~ ' || coalesce(to_char(d1, 'YYYY-MM'), '—')),
      '契約', to_jsonb(old))
  );
  return old;
end $fn$;

-- before delete：要在 cascade 把 orders 清掉之前算，不然數字全是 0
drop trigger if exists trg_contracts_delete_impact on public.contracts;
create trigger trg_contracts_delete_impact before delete on public.contracts
  for each row execute function public.log_contract_delete_impact();

comment on function public.log_contract_delete_impact() is
  '刪契約時把連帶消失的訂單摘要寫進 data_audit。不擋刪除,只留紀錄。'
  '必須是 before delete —— after 的話 cascade 已經把 orders 清光,算出來會是 0。';


-- ============================================================
-- 驗證
--
-- 包在 exception 裡：驗證失敗只發警告，不要把上面已經做完的
-- schema 變更整包回滾掉（migration_76 就是那樣一夜白做）。
-- ============================================================

do $$
declare n int;
begin
  -- 還有沒有孤兒
  select count(*) into n from public.orders o
   where o.contract_id is not null
     and not exists (select 1 from public.contracts c where c.id = o.contract_id);
  if n > 0 then raise warning '❌ 還有 % 列孤兒訂單', n;
  else raise notice '✅ 沒有孤兒訂單了'; end if;

  -- 外鍵在不在，policy 對不對
  select count(*) into n from pg_constraint
   where conname = 'orders_contract_id_fkey' and confdeltype = 'c';
  if n = 1 then raise notice '✅ 外鍵已建立（on delete cascade）';
  else raise warning '❌ 外鍵不存在或不是 cascade'; end if;

  -- 唯一索引在不在
  select count(*) into n from pg_indexes
   where schemaname = 'public' and indexname = 'uq_contract_order_month';
  if n = 1 then raise notice '✅ 一契約一月唯一索引已建立';
  else raise warning '❌ 唯一索引不存在'; end if;

  -- 同月重複
  select count(*) into n from (
    select contract_id, checkin from public.orders
     where imported_via = 'contract' and contract_id is not null
     group by 1, 2 having count(*) > 1) t;
  if n > 0 then raise warning '❌ 還有 % 組同月重複', n;
  else raise notice '✅ 沒有同月重複'; end if;

  -- 稽核觸發器要記得開回來
  select count(*) into n from pg_trigger
   where tgname = 'trg_data_audit_orders' and tgenabled <> 'D';
  if n = 1 then raise notice '✅ 稽核觸發器是啟用的';
  else raise warning '❌ 稽核觸發器還是關的!請執行 alter table public.orders enable trigger trg_data_audit_orders;'; end if;

  -- 刪除摘要觸發器
  select count(*) into n from pg_trigger
   where tgname = 'trg_contracts_delete_impact' and tgenabled <> 'D';
  if n = 1 then raise notice '✅ 刪除摘要觸發器已掛上';
  else raise warning '❌ 刪除摘要觸發器不存在'; end if;

exception when others then
  raise warning '驗證區出錯（schema 變更不受影響）:%', sqlerrm;
end $$;


-- 清理後的總營收，跟執行前對一下
select coalesce(sum(month_amount), 0)::bigint as 總營收_認列, count(*) as 認列列數
from public.revenue_recognitions;

-- 備份了哪些（確認無誤後可以 drop table public.deleted_contract_orders_81）
select imported_via as 來源, count(*) as 列數, sum(amount)::bigint as 金額,
       min(checkin) as 最早, max(checkin) as 最晚
from public.deleted_contract_orders_81 group by 1 order by 3 desc;


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    raise notice '%', (select public.record_migration('81_contract_orders_cascade'));
  else
    raise notice '尚未建立 schema_migrations（migration_70），這支沒有被記錄';
  end if;
end $$;
