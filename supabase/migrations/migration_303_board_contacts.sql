/* ══════════════════════════════════════════════════════════════════════
 * migration_303  佈告欄 → 電話簿                                            2026-09-30
 *
 * 【為什麼】David：「多一個電話簿的功能：姓名／公司名・電話・email・備註。
 *   全公司都可讀；會計、主管、總經理可寫、編輯、刪。」
 *
 * 【這支做什麼】
 *   1. board_contacts：四個欄位 ＋ 誰建的／誰改的。
 *   2. RLS：讀 ＝ 登入就看得到（含房務）；寫 ＝ can_write_board_contacts()
 *      （會計・主管・總經理，一份定義，前端 lib/board-contacts.ts 的 CONTACT_WRITE_ROLES 要一樣）。
 *   3. grant 給 authenticated / service_role（10-30 之後沒這兩行前端讀不到）。
 *   4. 刪除走回收桶：trash_deletable_tables() 多一列 ('board_contacts', 'accountant')。
 *      ★ 那支函式是整份重寫的，底下這份清單照 migration_224 一字不差只多一行。
 *
 * ★★ 自檢在 commit 後面 —— 看不到那張表就是整支回滾了。
 * ══════════════════════════════════════════════════════════ */

begin;

-- ── 1. 表 ────────────────────────────────────────────────
create table if not exists public.board_contacts (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (btrim(name) <> ''),
  phone       text,
  email       text,
  note        text,
  created_by  uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_by  uuid references public.profiles(id) on delete set null,
  updated_at  timestamptz not null default now()
);
comment on table public.board_contacts is
  '佈告欄 → 電話簿（migration_303）。全公司可讀；會計・主管・總經理可寫（can_write_board_contacts()）。刪除走 soft_delete 進回收桶。';

create index if not exists board_contacts_name_idx on public.board_contacts (name);

-- ── 2. 誰可以寫（一份定義）───────────────────────────────
create or replace function public.board_contact_write_roles()
returns text[] language sql immutable as $fn$
  select array['accountant', 'manager', 'super_admin']::text[]
$fn$;

create or replace function public.can_write_board_contacts()
returns boolean language sql stable security definer set search_path = public as $fn$
  select coalesce(public.board_role() = any(public.board_contact_write_roles()), false)
$fn$;
grant execute on function public.can_write_board_contacts() to authenticated;

alter table public.board_contacts enable row level security;

drop policy if exists board_contacts_read on public.board_contacts;
create policy board_contacts_read on public.board_contacts
  for select using (auth.uid() is not null);

drop policy if exists board_contacts_insert on public.board_contacts;
create policy board_contacts_insert on public.board_contacts
  for insert with check (public.can_write_board_contacts());

drop policy if exists board_contacts_update on public.board_contacts;
create policy board_contacts_update on public.board_contacts
  for update using (public.can_write_board_contacts()) with check (public.can_write_board_contacts());

drop policy if exists board_contacts_delete on public.board_contacts;
create policy board_contacts_delete on public.board_contacts
  for delete using (public.can_write_board_contacts());

-- ── 3. Data API ──────────────────────────────────────────
grant select, insert, update, delete on public.board_contacts to authenticated, service_role;

-- ── 4. 回收桶白名單 ──────────────────────────────────────
create or replace function public.trash_deletable_tables()
returns table (tbl text, min_role text) language sql immutable as $fn$
  select * from (values
    -- 訂單降到管家（migration_167）
    ('orders', 'housekeeper'),
    ('contracts', 'accountant'), ('expenses', 'accountant'),
    ('purchase_requests', 'accountant'), ('purchase_request_items', 'accountant'),
    ('deposits', 'accountant'), ('invoices', 'accountant'),
    ('order_payments', 'accountant'), ('contract_payments', 'accountant'),
    ('deposit_payments', 'accountant'),
    ('contract_recurring_charges', 'accountant'), ('recurring_charges', 'accountant'),
    ('estates', 'accountant'), ('properties', 'accountant'),
    ('payment_accounts', 'accountant'), ('payee_presets', 'accountant'),
    ('hk_work_item', 'manager'), ('hk_event', 'manager'), ('cleaning_records', 'manager'),
    ('reviews', 'manager'), ('customers', 'manager'), ('announcements', 'manager'),
    -- ★ 採購需求（migration_224）。整張單與單一項目都要能刪
    ('purchase_demands', 'accountant'), ('purchase_demand_items', 'accountant'),
    -- ★ 電話簿（migration_303）
    ('board_contacts', 'accountant'),
    ('attachments', 'any')
  ) v(tbl, min_role);
$fn$;

comment on function public.trash_deletable_tables() is
  '哪些表可以走 soft_delete，以及最低角色。沒列在這裡的表一律不能刪（預設拒絕）。'
  'orders 於 migration_167 降到 housekeeper。'
  'purchase_demands / purchase_demand_items 於 migration_224 加入。'
  'board_contacts 於 migration_303 加入。';

do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('303_board_contacts');
  end if;
end $do$;

commit;

-- ═══ 自檢（在 commit 後面 —— 看不到這張表就是整支回滾了） ═══════════
select 1 as 序, '這支跑過了沒' as 檢查,
       (select count(*)::text from public.schema_migrations where name = '303_board_contacts') as 結果,
       case when exists (select 1 from public.schema_migrations where name = '303_board_contacts') then '✅' else '❌' end as 判定
union all select 2, '表在、RLS 開著',
       (select coalesce(relrowsecurity::text, '表不存在') from pg_class where oid = 'public.board_contacts'::regclass),
       case when (select relrowsecurity from pg_class where oid = 'public.board_contacts'::regclass) then '✅' else '❌' end
union all select 3, 'policy 四條（讀・新增・改・刪）',
       (select string_agg(polname, '、' order by polname) from pg_policy where polrelid = 'public.board_contacts'::regclass),
       case when (select count(*) from pg_policy where polrelid = 'public.board_contacts'::regclass) = 4 then '✅' else '❌' end
union all select 4, 'Data API：authenticated 讀得到、寫得了',
       has_table_privilege('authenticated', 'public.board_contacts', 'select')::text || ' / ' || has_table_privilege('authenticated', 'public.board_contacts', 'insert')::text,
       case when has_table_privilege('authenticated', 'public.board_contacts', 'select') and has_table_privilege('authenticated', 'public.board_contacts', 'insert') then '✅' else '❌ 10-30 後前端會 permission denied' end
union all select 5, '誰可以寫（要跟 lib/board-contacts.ts 的 CONTACT_WRITE_ROLES 一樣）',
       array_to_string(public.board_contact_write_roles(), '、'), 'ℹ accountant、manager、super_admin'
union all select 6, '回收桶白名單有 board_contacts',
       coalesce((select min_role from public.trash_deletable_tables() where tbl = 'board_contacts'), '沒有'),
       case when exists (select 1 from public.trash_deletable_tables() where tbl = 'board_contacts') then '✅' else '❌' end
union all select 7, '白名單總數（224 是 25 列 → 現在要 26）',
       (select count(*)::text from public.trash_deletable_tables()),
       case when (select count(*) from public.trash_deletable_tables()) = 26 then '✅' else '❌ 少抄了一行 —— 那張表的刪除會默默失效' end
order by 1;
