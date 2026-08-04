-- migration_61：退押金審核流程
--
-- 原本填個退押金日就算退了。押金動輒十幾二十萬，退錯追不回來，
-- 這道關卡該跟請款單一樣。
--
-- 流程：
--   暫收中 ──填退款資訊（房客帳戶 + 預計匯款日 + 我方出款帳號）──► 待審核
--          ──主管 ✓ + 總經理 ✓──► 已核可
--          ──實際匯出後填「退押金日」──► 已退款
--
-- 關鍵語意改變：「已退款」不再是「有填 returned_on」，
-- 而是「走完整條流程」。沒核可就填日期會被 CHECK 擋掉 ——
-- 寫在資料庫層，不是只靠前端藏按鈕。
--
-- 兩個帳戶方向相反，命名沿用請款單那一套，看程式碼不用再想一次：
--   payee_*         = 房客的收款帳戶（錢退到哪）
--   returned_account = 我方的出款帳號（錢從哪出，對應 payment_accounts.code）

alter table public.deposits
  add column if not exists refund_status text not null default 'none'
    check (refund_status in ('none','pending','approved','rejected')),

  -- 房客的收款帳戶
  add column if not exists payee_bank_code text,
  add column if not exists payee_name      text,   -- 戶名
  add column if not exists payee_account   text,

  add column if not exists planned_refund_on date,

  add column if not exists refund_requested_by uuid references public.profiles(id),
  add column if not exists refund_requested_at timestamptz,
  add column if not exists manager_approved_by uuid references public.profiles(id),
  add column if not exists manager_approved_at timestamptz,
  add column if not exists admin_approved_by   uuid references public.profiles(id),
  add column if not exists admin_approved_at   timestamptz,
  add column if not exists rejected_by    uuid references public.profiles(id),
  add column if not exists rejected_at    timestamptz,
  add column if not exists reject_reason  text;

comment on column public.deposits.refund_status is
  'none = 尚未申請退款；pending = 待審核；approved = 兩票到齊；rejected = 駁回。實際退款看 returned_on。';
comment on column public.deposits.payee_name is '戶名。房客的收款帳戶資訊，與 returned_account（我方出款）方向相反。';


-- ============================================================
-- 未核可不能填退款日
--
-- 舊資料是在這套流程之前退的，沒有 refund_status。
-- 直接加約束會讓那些列全部違規，所以先把它們補成 approved。
-- ============================================================
update public.deposits
   set refund_status = 'approved'
 where returned_on is not null and refund_status = 'none';

alter table public.deposits drop constraint if exists dep_refund_chk;
alter table public.deposits add constraint dep_refund_chk check (
  returned_on is null or refund_status = 'approved'
);


-- ============================================================
-- 狀態機：兩票到齊自動翻 approved，駁回清票
--
-- 跟請款單同一套做法 —— 放在觸發器而不是前端，
-- 否則改前端就能繞過審核。
-- ============================================================
create or replace function public.dep_apply_refund_status() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  -- 駁回：清掉既有票數，退回申請人
  if new.refund_status = 'rejected' and old.refund_status is distinct from 'rejected' then
    new.manager_approved_by := null; new.manager_approved_at := null;
    new.admin_approved_by   := null; new.admin_approved_at   := null;
    new.rejected_at := coalesce(new.rejected_at, now());
    return new;
  end if;

  -- 送審
  if new.refund_status = 'pending' and old.refund_status is distinct from 'pending' then
    new.refund_requested_at := coalesce(new.refund_requested_at, now());
    new.rejected_by := null; new.rejected_at := null; new.reject_reason := null;
  end if;

  -- 兩票到齊
  if new.refund_status = 'pending'
     and new.manager_approved_at is not null
     and new.admin_approved_at   is not null then
    new.refund_status := 'approved';
  end if;

  return new;
end $$;

drop trigger if exists trg_dep_refund_status on public.deposits;
create trigger trg_dep_refund_status
  before update on public.deposits
  for each row execute function public.dep_apply_refund_status();


-- ============================================================
-- 憑證：押金也能掛附件（匯款水單）
--
-- attachments 原本要求「恰好一個父鍵」。多一個 deposit_id 之後，
-- 條件從 = 1 變成仍然 = 1，只是候選多一個。
-- ============================================================
alter table public.attachments
  add column if not exists deposit_id uuid references public.deposits(id) on delete cascade;

create index if not exists att_dep_idx on public.attachments (deposit_id);

alter table public.attachments drop constraint if exists att_one_parent;
alter table public.attachments add constraint att_one_parent check (
  num_nonnulls(request_id, expense_id, deposit_id) = 1
);

-- storage policy 靠路徑判斷權限，押金的路徑前綴是 dep/
create or replace function public.can_see_receipt(p_path text)
returns boolean
language sql stable security definer set search_path = public as $$
  select case
    when current_role_of() in ('accountant','manager','super_admin') then true
    -- 一般使用者只看得到自己送的請款單底下的附件。
    -- 押金與支出對管家本來就不開放，所以不必列入。
    else exists (
      select 1
      from public.attachments a
      join public.purchase_requests p on p.id = a.request_id
      where a.path = p_path and p.requester_id = auth.uid()
    )
  end;
$$;

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
-- 驗證
-- ============================================================
select refund_status, count(*),
       count(*) filter (where returned_on is not null) as 已實際退款
from public.deposits group by refund_status order by 1;

-- 不該存在：填了退款日但沒核可
select count(*) as 未核可卻已退_應為0
from public.deposits
where returned_on is not null and refund_status <> 'approved';

select conname, pg_get_constraintdef(oid)
from pg_constraint where conrelid = 'public.attachments'::regclass and contype = 'c';
