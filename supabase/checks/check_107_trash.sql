-- 回收桶健康檢查（migration_107）
--
-- 【為什麼要單獨一份】
-- migration 裡的自我測試是用 raise notice 印的，而 Supabase SQL Editor
-- 只顯示最後一個 select 的結果表格 —— 那些 notice 實際上沒有人看得到，
-- 等於沒有測。測試要是沒有人看得到結果，它就不是測試，只是註解。
--
-- 這份把每一條檢查寫進暫存表，最後 select 出來。整份唯讀，
-- 中間建立的測試資料會在同一個交易裡清掉。
--
-- 用法：整份貼進 SQL Editor 執行，看「結果」欄有沒有 ❌。

drop table if exists _chk;
create temp table _chk (n int, item text, result text, detail text);

do $$
declare
  admin_id uuid; hk_id uuid; oid uuid; tid uuid; cid uuid;
  r jsonb; kids jsonb; n_rev int; n_missing int;
begin
  -- soft_delete 的權限看 current_role_of()，而它看 auth.uid()。
  -- SQL Editor 裡 auth.uid() 是 null，不假裝成某個人的話，
  -- 每一條都會走 NO_PERM，「通過」的其實是錯誤路徑。
  select id into admin_id from public.profiles where role = 'super_admin' limit 1;
  if admin_id is null then
    insert into _chk values (0, '前置', '❌ 找不到 super_admin', '無法進行需要身分的檢查');
    return;
  end if;
  perform set_config('request.jwt.claims',
    json_build_object('sub', admin_id::text)::text, true);

  -- 1. 函式都在
  insert into _chk
  select 1, '函式齊全',
    case when count(*) = 5 then '✅' else '❌ 只有 ' || count(*) || '/5' end,
    string_agg(p, '、')
  from unnest(array[
    'public.soft_delete(text,uuid,text)', 'public.restore_trash(uuid)',
    'public.purge_trash(uuid)', 'public.trash_collect_children(text,uuid[],integer)',
    'public.trash_can_delete(text)']) p
  where to_regprocedure(p) is not null;

  -- 2. 刪除 → 復原（含營收認列要跟著回來）
  insert into public.orders (order_key, source, guest_name, checkin, checkout, nights, amount)
  values ('__TRASH_CHECK__', 'private', '回收桶檢查', '2026-01-01', '2026-01-03', 2, 12345)
  returning id into oid;
  select count(*) into n_rev from public.revenue_recognitions where order_id = oid;

  r := public.soft_delete('orders', oid, '健康檢查');
  insert into _chk values (2, '刪除',
    case when (r->>'ok')::boolean and not exists (select 1 from public.orders where id = oid)
         then '✅' else '❌' end,
    r->>'message');

  select id into tid from public.trash where record_id = oid;
  r := public.restore_trash(tid);
  insert into _chk values (3, '復原',
    case when (r->>'ok')::boolean
          and exists (select 1 from public.orders where id = oid and amount = 12345)
         then '✅' else '❌' end,
    r->>'message');

  insert into _chk values (4, '復原後營收認列回來',
    case when (select count(*) from public.revenue_recognitions where order_id = oid) >= n_rev
         then '✅' else '❌ 比原本少' end,
    '原本 ' || n_rev || ' 筆');

  insert into _chk values (5, '重複復原被擋',
    case when (public.restore_trash(tid)->>'code') = 'ALREADY' then '✅' else '❌' end, '');

  delete from public.orders where id = oid;
  delete from public.trash where record_id = oid;

  -- 3. 子列要一路收到底：契約 → 訂單 → 收款紀錄
  select c.id into cid
    from public.contracts c
    join public.orders o on o.contract_id = c.id
    join public.order_payments p on p.order_id = o.id
   limit 1;
  if cid is null then
    insert into _chk values (6, '子列遞迴（契約→訂單→收款）', '－', '找不到樣本資料,跳過');
  else
    kids := public.trash_collect_children('contracts', array[cid]);
    insert into _chk values (6, '子列遞迴（契約→訂單→收款）',
      case when exists (select 1 from jsonb_array_elements(kids) g
                         where g->>'table' = 'order_payments')
           then '✅' else '❌ 只收到一層,復原契約會弄丟收款紀錄' end,
      (select string_agg(public.trash_table_label(g->>'table'), '、')
         from jsonb_array_elements(kids) g));
  end if;

  -- 4. 白名單預設拒絕 —— soft_delete 繞過 RLS,這條錯了就是全站後門
  insert into _chk values (7, 'profiles 不能刪',
    case when not public.trash_can_delete('profiles')
          and (public.soft_delete('profiles', admin_id)->>'code') = 'NO_PERM'
         then '✅' else '❌ 可以刪 —— 白名單預設值錯了' end, '');

  insert into _chk values (8, '打卡紀錄不能刪',
    case when not public.trash_can_delete('attendance') then '✅' else '❌' end,
    '不擋的話,遲到的人可以自己刪掉紀錄');

  -- 5. 房管不能刪訂單
  select id into hk_id from public.profiles where role = 'housekeeper' limit 1;
  if hk_id is null then
    insert into _chk values (9, '房管不能刪訂單', '－', '沒有房管帳號,跳過');
  else
    perform set_config('request.jwt.claims',
      json_build_object('sub', hk_id::text)::text, true);
    insert into _chk values (9, '房管不能刪訂單',
      case when not public.trash_can_delete('orders') then '✅' else '❌' end, '');
    perform set_config('request.jwt.claims',
      json_build_object('sub', admin_id::text)::text, true);
  end if;
end $$;

-- 6. 有沒有會進回收桶卻沒中文名的表
with recursive
fks as (
  select cl.relname::text  collate "default" as child,
         cl2.relname::text collate "default" as parent
    from pg_constraint c
    join pg_class cl     on cl.oid = c.conrelid
    join pg_class cl2    on cl2.oid = c.confrelid
    join pg_namespace ns on ns.oid = cl.relnamespace
   where c.contype = 'f' and c.confdeltype = 'c' and ns.nspname = 'public'
),
reach(tbl, depth) as (
  select d.tbl, 0 from public.trash_deletable_tables() d
  union
  select f.child, r.depth + 1 from reach r join fks f on f.parent = r.tbl where r.depth < 5
),
missing as (
  select distinct tbl from reach where public.trash_table_label(tbl) = tbl
)
insert into _chk
select 10, '每張表都有中文名',
  case when count(*) = 0 then '✅' else '❌ 缺 ' || count(*) || ' 張' end,
  coalesce(string_agg(tbl, '、'), '')
from missing;

-- 7. RLS 有開
insert into _chk
select 11, 'trash 的 RLS',
  case when (select relrowsecurity from pg_class where oid = 'public.trash'::regclass)
        and count(*) > 0 then '✅' else '❌' end,
  count(*) || ' 條政策'
from pg_policies where schemaname = 'public' and tablename = 'trash';


select item as "檢查項目", result as "結果", detail as "說明"
from _chk order by n;
