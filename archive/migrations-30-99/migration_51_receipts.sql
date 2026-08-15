-- migration_51：憑證圖片上傳（請款單 + 支出）
--
-- 兩個東西：
--   ① storage bucket 'receipts'（私有，不能靠猜網址看到別人的發票）
--   ② public.attachments 一張表，記錄「哪個檔案掛在哪張單下」
--
-- 為什麼不直接在 purchase_requests 加一個 image_url 欄位？
--   一張請款單常常有好幾張發票（三個項目三張收據），單一欄位放不下，
--   而且刪檔案要順便清欄位，很容易留下指向不存在檔案的死連結。
--   獨立一張表 + on delete cascade，單子刪掉附件自動跟著走。
--
-- 檔案路徑約定（storage policy 靠這個判斷權限）：
--   pr/{request_id}/{uuid}.{ext}
--   exp/{expense_id}/{uuid}.{ext}

-- ============================================================
-- 1. bucket
-- ============================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'receipts', 'receipts', false,
  10485760,                                    -- 10MB。前端會先壓縮，正常不會碰到
  array['image/jpeg','image/png','image/webp','image/heic','application/pdf']
)
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;


-- ============================================================
-- 2. attachments
-- ============================================================
create table if not exists public.attachments (
  id          uuid primary key default gen_random_uuid(),
  request_id  uuid references public.purchase_requests(id) on delete cascade,
  expense_id  uuid references public.expenses(id)          on delete cascade,
  path        text not null unique,            -- storage.objects.name
  file_name   text,
  mime_type   text,
  size_bytes  integer,
  uploaded_by uuid references public.profiles(id),
  created_at  timestamptz not null default now(),
  -- 一個附件只能掛在一個地方。兩個都填或都不填都是資料錯誤。
  constraint att_one_parent check (num_nonnulls(request_id, expense_id) = 1)
);

create index if not exists att_req_idx on public.attachments (request_id);
create index if not exists att_exp_idx on public.attachments (expense_id);

comment on table public.attachments is '憑證附件。檔案本體在 storage 的 receipts bucket，這裡只存路徑與歸屬。';


-- ============================================================
-- 3. 誰看得到某個附件
--
-- SECURITY DEFINER：storage policy 要能查 purchase_requests，
-- 但一般使用者對那張表只有自己的列可見，直接查會看不到別人的單而誤判。
-- ============================================================
create or replace function public.can_see_receipt(p_path text)
returns boolean
language sql stable security definer set search_path = public as $$
  select case
    -- 會計、主管、總經理看得到全部
    when current_role_of() in ('accountant','manager','super_admin') then true
    -- 一般使用者只看得到自己送的請款單底下的附件
    else exists (
      select 1
      from public.attachments a
      join public.purchase_requests p on p.id = a.request_id
      where a.path = p_path and p.requester_id = auth.uid()
    )
  end;
$$;

-- 誰可以上傳／刪除：能編輯母單的人。
-- 支出只有會計以上碰得到，請款單則是申請人本人或總經理（見 migration_50）。
create or replace function public.can_edit_receipt(p_path text)
returns boolean
language sql stable security definer set search_path = public as $$
  select case
    when current_role_of() in ('accountant','manager','super_admin') then true
    else exists (
      select 1
      from public.purchase_requests p
      where p.id = nullif(split_part(p_path, '/', 2), '')::uuid
        and p.requester_id = auth.uid()
        and p.status in ('draft','rejected','pending')
    )
  end;
$$;


-- ============================================================
-- 4. attachments 的 RLS
-- ============================================================
alter table public.attachments enable row level security;

drop policy if exists att_read   on public.attachments;
drop policy if exists att_write  on public.attachments;
drop policy if exists att_delete on public.attachments;

create policy att_read on public.attachments for select
  using (can_see_receipt(path));

create policy att_write on public.attachments for insert
  with check (can_edit_receipt(path) and uploaded_by = auth.uid());

create policy att_delete on public.attachments for delete
  using (can_edit_receipt(path));


-- ============================================================
-- 5. storage.objects 的 RLS
--
-- 注意：這裡用 name 欄位（就是路徑），不是 id。
-- ============================================================
drop policy if exists receipts_read   on storage.objects;
drop policy if exists receipts_insert on storage.objects;
drop policy if exists receipts_delete on storage.objects;

create policy receipts_read on storage.objects for select
  using (bucket_id = 'receipts' and public.can_see_receipt(name));

-- 上傳時 attachments 那列還不存在，所以只能靠路徑判斷母單
create policy receipts_insert on storage.objects for insert
  with check (bucket_id = 'receipts' and public.can_edit_receipt(name));

create policy receipts_delete on storage.objects for delete
  using (bucket_id = 'receipts' and public.can_edit_receipt(name));


-- ============================================================
-- 6. 驗證
-- ============================================================
select id, public, file_size_limit from storage.buckets where id = 'receipts';

select policyname, cmd from pg_policies
where tablename = 'objects' and schemaname = 'storage' and policyname like 'receipts%'
order by policyname;

select policyname, cmd from pg_policies
where tablename = 'attachments'
order by policyname;
