-- =============================================================
-- 請款與支出模組
-- 設計文件:docs/expenses.md
--
-- 部署鐵則:這支 SQL 先跑完,前端才推。結尾的 notify pgrst 不能漏。
-- =============================================================

-- ─────────────────────────────────────────────────────────────
-- 0. 新增 accountant(會計)角色
--
-- current_role_of() 直接回傳 profiles.role,不必改。
-- 但若 profiles.role 有 CHECK 約束,得先放行新值,否則設定頁存不進去。
-- ─────────────────────────────────────────────────────────────
do $$
declare c record;
begin
  for c in
    select con.conname
      from pg_constraint con
      join pg_class rel on rel.oid = con.conrelid
      join pg_namespace ns on ns.oid = rel.relnamespace
     where ns.nspname = 'public' and rel.relname = 'profiles'
       and con.contype = 'c' and pg_get_constraintdef(con.oid) ilike '%role%'
  loop
    execute format('alter table public.profiles drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.profiles
  add constraint profiles_role_chk
  check (role in ('housekeeper','accountant','manager','super_admin'));

-- ─────────────────────────────────────────────────────────────
-- 1. 會計科目主檔
-- ─────────────────────────────────────────────────────────────
create table if not exists public.account_codes (
  code   text primary key,
  name   text not null,
  sort   int  not null default 0,
  active boolean not null default true
);

insert into public.account_codes (code, name, sort) values
  ('repair',    '修繕維護',    10),
  ('cleaning',  '清潔費',      20),
  ('supplies',  '備品消耗品',  30),
  ('utility',   '水電瓦斯',    40),
  ('internet',  '網路第四台',  50),
  ('rent',      '房租支出',    60),
  ('mgmtfee',   '管理費',      70),
  ('insurance', '保險費',      80),
  ('salary',    '薪資勞務',    90),
  ('transport', '差旅交通',   100),
  ('marketing', '廣告行銷',   110),
  ('office',    '辦公用品',   120),
  ('tax',       '規費稅捐',   130),
  ('service',   '專業服務費', 140),
  ('other',     '其他',       900)
on conflict (code) do nothing;

-- ─────────────────────────────────────────────────────────────
-- 2. 請款單
--
-- 兩道核可「並行」,沒有先後:manager 一票、super_admin 一票。
-- 所以狀態只有 pending(等票),不再有 pending_manager / pending_ceo 之分,
-- 是否核可完成由兩個 *_approved_at 是否都有值決定,由觸發器翻轉狀態。
-- ─────────────────────────────────────────────────────────────
create table if not exists public.purchase_requests (
  id           uuid primary key default gen_random_uuid(),
  req_no       text unique not null,
  requester_id uuid not null references auth.users(id),
  status       text not null default 'draft',
  total_amount numeric not null default 0,      -- 觸發器維護,前端勿寫

  -- 收款方(廠商)。payment_method='transfer' 時才需要填。
  payment_method  text,
  payee_bank_code text,
  payee_account   text,
  payee_company   text,
  payee_tax_id    text,

  note         text,
  submitted_at timestamptz,

  manager_approved_by uuid references auth.users(id),
  manager_approved_at timestamptz,
  admin_approved_by   uuid references auth.users(id),
  admin_approved_at   timestamptz,
  rejected_by         uuid references auth.users(id),
  rejected_at         timestamptz,
  reject_reason       text,

  purchased_on         date,
  expense_generated_at timestamptz,

  created_at timestamptz not null default now(),
  constraint pr_status_chk check (status in ('draft','pending','approved','rejected')),
  constraint pr_pay_chk    check (payment_method is null or payment_method in ('cash','transfer','credit_card')),
  -- 採購日只有在已核可時才能有值。這條在資料庫層擋住「未核可就採購」,
  -- 不是只靠前端把按鈕藏起來。
  constraint pr_purchase_chk check (purchased_on is null or status = 'approved')
);

create index if not exists pr_status_idx    on public.purchase_requests (status);
create index if not exists pr_requester_idx on public.purchase_requests (requester_id);
create index if not exists pr_created_idx   on public.purchase_requests (created_at desc);

-- ─────────────────────────────────────────────────────────────
-- 3. 請款項目
-- ─────────────────────────────────────────────────────────────
create table if not exists public.purchase_request_items (
  id           uuid primary key default gen_random_uuid(),
  request_id   uuid not null references public.purchase_requests(id) on delete cascade,
  item_name    text not null,
  amount       numeric not null default 0,
  account_code text references public.account_codes(code),
  purpose_type text not null default 'property',   -- property | office
  property_id  uuid references public.properties(id),
  note         text,
  sort         int not null default 0,
  constraint pri_purpose_chk check (
    (purpose_type = 'office'   and property_id is null) or
    (purpose_type = 'property' and property_id is not null)
  )
);

create index if not exists pri_request_idx on public.purchase_request_items (request_id);

-- ─────────────────────────────────────────────────────────────
-- 4. 支出
-- ─────────────────────────────────────────────────────────────
create table if not exists public.expenses (
  id           uuid primary key default gen_random_uuid(),
  spent_on     date not null,
  item_name    text not null,
  amount       numeric not null default 0,
  account_code text references public.account_codes(code),
  purpose_type text not null default 'property',
  property_id  uuid references public.properties(id),
  voucher_no   text,
  payment_method text,
  pay_account  text,                               -- 我方付款帳號,如 8088 0513
  note         text,
  -- 來源請款項目。獨立新增的支出為 null。
  -- unique 讓「一個請款項目只能產生一筆支出」在資料庫層成立,不靠應用層自律。
  source_item_id uuid unique references public.purchase_request_items(id) on delete set null,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  constraint exp_purpose_chk check (
    (purpose_type = 'office'   and property_id is null) or
    (purpose_type = 'property' and property_id is not null)
  ),
  constraint exp_pay_chk check (payment_method is null or payment_method in ('cash','transfer','credit_card'))
);

create index if not exists exp_spent_idx   on public.expenses (spent_on desc);
create index if not exists exp_account_idx on public.expenses (account_code);
create index if not exists exp_prop_idx    on public.expenses (property_id);
create index if not exists exp_src_idx     on public.expenses (source_item_id);

-- ─────────────────────────────────────────────────────────────
-- 5. 總額觸發器
--
-- total_amount 一律由此維護。免核門檻(3000)靠它判斷 ——
-- 若讓前端自己送總額,等於把規則交給呼叫端,門檻形同虛設。
-- ─────────────────────────────────────────────────────────────
create or replace function public.sync_pr_total() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update public.purchase_requests p
     set total_amount = coalesce(
       (select sum(amount) from public.purchase_request_items where request_id = p.id), 0)
   where p.id = coalesce(new.request_id, old.request_id);
  return null;
end $$;

drop trigger if exists trg_sync_pr_total on public.purchase_request_items;
create trigger trg_sync_pr_total
  after insert or update or delete on public.purchase_request_items
  for each row execute function public.sync_pr_total();

-- ─────────────────────────────────────────────────────────────
-- 6. 單號產生器 PR-YYYYMM-NNN
-- ─────────────────────────────────────────────────────────────
create or replace function public.next_req_no() returns text
language plpgsql security definer set search_path = public as $$
declare ym text; n int;
begin
  ym := to_char(now() at time zone 'Asia/Taipei', 'YYYYMM');
  select coalesce(max((regexp_replace(req_no, '^PR-\d{6}-', ''))::int), 0) + 1
    into n from public.purchase_requests where req_no like 'PR-' || ym || '-%';
  return 'PR-' || ym || '-' || lpad(n::text, 3, '0');
end $$;

-- ─────────────────────────────────────────────────────────────
-- 7. 狀態機
--
-- 送出時:總額 < 3000 直接 approved(兩票全免),否則進 pending 等票。
-- 收到票時:兩票到齊才翻 approved。前端不自己算狀態 ——
-- 免核門檻與「幾票算數」是政策,放在資料庫才不會被繞過。
-- ─────────────────────────────────────────────────────────────
create or replace function public.pr_apply_status() returns trigger
language plpgsql security definer set search_path = public as $$
declare threshold numeric := 3000;
begin
  -- 駁回:清掉既有票數,退回申請人
  if new.status = 'rejected' and old.status is distinct from 'rejected' then
    new.manager_approved_by := null; new.manager_approved_at := null;
    new.admin_approved_by   := null; new.admin_approved_at   := null;
    new.rejected_at := coalesce(new.rejected_at, now());
    return new;
  end if;

  -- 送出(draft/rejected → pending)
  if new.status = 'pending' and old.status in ('draft','rejected') then
    new.submitted_at  := now();
    new.rejected_by   := null; new.rejected_at := null; new.reject_reason := null;
    if new.total_amount < threshold then
      new.status := 'approved';           -- 免核,直接放行
      return new;
    end if;
  end if;

  -- 兩票到齊 → 核可完成
  if new.status = 'pending'
     and new.manager_approved_at is not null
     and new.admin_approved_at   is not null then
    new.status := 'approved';
  end if;

  return new;
end $$;

drop trigger if exists trg_pr_status on public.purchase_requests;
create trigger trg_pr_status
  before update on public.purchase_requests
  for each row execute function public.pr_apply_status();

-- ─────────────────────────────────────────────────────────────
-- 8. 連動:核可後填入採購日 → 逐項產生支出
--
-- source_item_id 的唯一約束保證同一項目不會產生第二筆:
-- 事後改採購日只會更新既有支出的 spent_on,不會再長出一筆。
-- ─────────────────────────────────────────────────────────────
create or replace function public.gen_expenses_from_pr() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status <> 'approved' or new.purchased_on is null then
    return new;
  end if;

  if old.purchased_on is not null and old.purchased_on <> new.purchased_on then
    update public.expenses e set spent_on = new.purchased_on
      from public.purchase_request_items i
     where e.source_item_id = i.id and i.request_id = new.id;
    return new;
  end if;

  if old.purchased_on is not null then
    return new;                       -- 日期沒變,不重複產生
  end if;

  insert into public.expenses (
    spent_on, item_name, amount, account_code, purpose_type, property_id,
    payment_method, note, source_item_id, created_by
  )
  select new.purchased_on, i.item_name, i.amount, i.account_code, i.purpose_type, i.property_id,
         new.payment_method, i.note, i.id, new.requester_id
    from public.purchase_request_items i
   where i.request_id = new.id
  on conflict (source_item_id) do nothing;

  new.expense_generated_at := now();
  return new;
end $$;

drop trigger if exists trg_gen_expenses on public.purchase_requests;
create trigger trg_gen_expenses
  before update on public.purchase_requests
  for each row execute function public.gen_expenses_from_pr();

-- ─────────────────────────────────────────────────────────────
-- 9. RLS — 新表
-- ─────────────────────────────────────────────────────────────
alter table public.account_codes          enable row level security;
alter table public.purchase_requests      enable row level security;
alter table public.purchase_request_items enable row level security;
alter table public.expenses               enable row level security;

drop policy if exists ac_read  on public.account_codes;
drop policy if exists ac_write on public.account_codes;
create policy ac_read  on public.account_codes for select
  using (current_role_of() in ('housekeeper','accountant','manager','super_admin'));
create policy ac_write on public.account_codes for all
  using (current_role_of() = 'super_admin') with check (current_role_of() = 'super_admin');

-- ── 請款單 ──
drop policy if exists pr_read on public.purchase_requests;
create policy pr_read on public.purchase_requests for select using (
  current_role_of() in ('accountant','manager','super_admin')
  or (current_role_of() = 'housekeeper' and requester_id = auth.uid())
);

drop policy if exists pr_insert on public.purchase_requests;
create policy pr_insert on public.purchase_requests for insert with check (
  requester_id = auth.uid()
  and status = 'draft'
  and current_role_of() in ('housekeeper','accountant','manager','super_admin')
);

-- 更新的三種情境:
--   a) 申請人改自己的 draft / rejected(修改、送出)
--   b) manager 投票或駁回 —— 但不能核自己送的單,否則第一票形同虛設
--   c) super_admin 投票或駁回,以及任何管理操作
--   d) accountant 只能在已核可後填採購日(不能投票),用 pr_no_vote_by_accountant 觸發器把關
drop policy if exists pr_update on public.purchase_requests;
create policy pr_update on public.purchase_requests for update using (
  (requester_id = auth.uid() and status in ('draft','rejected'))
  or (current_role_of() = 'manager' and requester_id <> auth.uid() and status in ('pending','approved'))
  or (current_role_of() = 'accountant' and status = 'approved')
  or current_role_of() = 'super_admin'
) with check (
  (requester_id = auth.uid() and status in ('draft','rejected','pending','approved'))
  or current_role_of() in ('manager','accountant','super_admin')
);

drop policy if exists pr_delete on public.purchase_requests;
create policy pr_delete on public.purchase_requests for delete using (
  requester_id = auth.uid() and status in ('draft','rejected')
);

-- 會計不得投票。RLS 只能管到「哪些列可改」,管不到「改了哪些欄位」,
-- 所以用觸發器擋。同理擋掉自己核自己的單。
create or replace function public.pr_guard_votes() returns trigger
language plpgsql security definer set search_path = public as $$
declare r text := current_role_of();
begin
  if r = 'accountant' and (
       new.manager_approved_at is distinct from old.manager_approved_at or
       new.admin_approved_at   is distinct from old.admin_approved_at) then
    raise exception '會計不得核可請款單';
  end if;
  if new.manager_approved_at is distinct from old.manager_approved_at
     and new.manager_approved_by = new.requester_id then
    raise exception '不得核可自己送出的請款單';
  end if;
  if new.admin_approved_at is distinct from old.admin_approved_at
     and new.admin_approved_by = new.requester_id then
    raise exception '不得核可自己送出的請款單';
  end if;
  return new;
end $$;

drop trigger if exists trg_pr_guard_votes on public.purchase_requests;
create trigger trg_pr_guard_votes
  before update on public.purchase_requests
  for each row execute function public.pr_guard_votes();

-- ── 請款項目 ── 權限跟隨母單
drop policy if exists pri_read on public.purchase_request_items;
create policy pri_read on public.purchase_request_items for select using (
  exists (select 1 from public.purchase_requests p where p.id = request_id and (
    current_role_of() in ('accountant','manager','super_admin') or p.requester_id = auth.uid()))
);

drop policy if exists pri_write on public.purchase_request_items;
create policy pri_write on public.purchase_request_items for all using (
  exists (select 1 from public.purchase_requests p where p.id = request_id
          and p.requester_id = auth.uid() and p.status in ('draft','rejected'))
  or current_role_of() = 'super_admin'
) with check (
  exists (select 1 from public.purchase_requests p where p.id = request_id
          and p.requester_id = auth.uid() and p.status in ('draft','rejected'))
  or current_role_of() = 'super_admin'
);

-- ── 支出 ── 管家完全看不到
drop policy if exists exp_read   on public.expenses;
drop policy if exists exp_write  on public.expenses;
drop policy if exists exp_insert on public.expenses;
drop policy if exists exp_update on public.expenses;
drop policy if exists exp_delete on public.expenses;

create policy exp_read on public.expenses for select
  using (current_role_of() in ('accountant','manager','super_admin'));

create policy exp_insert on public.expenses for insert
  with check (current_role_of() in ('accountant','manager','super_admin'));

create policy exp_update on public.expenses for update
  using (current_role_of() in ('accountant','manager','super_admin'))
  with check (current_role_of() in ('accountant','manager','super_admin'));

-- 刪除:來自請款單的支出只有 super_admin 能刪。
--
-- 兩票核可是為了管錢,若那筆錢的紀錄一個人就能刪掉,這道關卡等於白設。
-- 而且刪除是靜默的 —— 請款單仍顯示已核可、有採購日,支出卻不見了,兩邊對不上而系統不會叫。
-- 加上 gen_expenses_from_pr() 只在採購日「從無到有」時才建立,刪掉後重填也救不回來。
-- 獨立新增的支出(source_item_id is null)維持可刪,那是自己打錯字。
create policy exp_delete on public.expenses for delete
  using (
    (source_item_id is null and current_role_of() in ('accountant','manager','super_admin'))
    or current_role_of() = 'super_admin'
  );

-- ─────────────────────────────────────────────────────────────
-- 10. RLS — 既有表開放給 accountant
--
-- 用「追加 policy」而非改寫既有的。Postgres 的 permissive policy 是 OR 關係,
-- 加一條新的不會動到原本的判斷,避免重寫時把既有權限改壞。
-- 一律唯讀(for select)。
-- ─────────────────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array[
    'orders','contracts','revenue_recognitions','estates','properties','invoices'
  ] loop
    if to_regclass('public.' || t) is not null then
      execute format('drop policy if exists %I on public.%I', t || '_accountant_read', t);
      execute format(
        'create policy %I on public.%I for select using (current_role_of() = ''accountant'')',
        t || '_accountant_read', t);
    end if;
  end loop;
end $$;

-- 會計要能讀自己的 profile,否則側邊選單抓不到角色,整個 app 會空白
drop policy if exists profiles_self_read_accountant on public.profiles;
create policy profiles_self_read_accountant on public.profiles for select
  using (id = auth.uid());

notify pgrst, 'reload schema';
