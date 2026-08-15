-- migration_32：請款單撤銷規則 + 開放自核
--
-- 兩項規則變更（2026-08-01 David 指定）：
--   1. 撤銷：任何狀態都能撤銷，可撤銷者 = 提交者本人 / manager / accountant / super_admin。
--            但「已產生支出」的單一律不能撤銷。
--   2. 自核：房務主管(manager) 送的單，那一票由他自己投。
--            原本 migration_30 刻意擋掉自核，本次依需求解除。
--
-- ⚠️ 解除自核的代價：金額 >= 3000 的單仍需兩票，但 manager 那票不再由第二人把關。
--    manager 送的單實際上只剩 CEO 一道關卡。accountant 不得核可的規則維持不變。

-- ============================================================
-- 1. pr_guard_votes()：移除自核限制，保留「會計不得核可」
-- ============================================================
create or replace function public.pr_guard_votes() returns trigger
language plpgsql security definer set search_path = public as $$
declare r text := current_role_of();
begin
  -- 會計不得核可。RLS 管不到欄位層級（會計為了填採購日必須能 update 該列），
  -- 所以這條只能用觸發器擋。
  if r = 'accountant' and (
       new.manager_approved_at is distinct from old.manager_approved_at or
       new.admin_approved_at   is distinct from old.admin_approved_at) then
    raise exception '會計不得核可請款單';
  end if;
  -- migration_30 原有的「不得核可自己送出的請款單」兩段檢查已移除。
  return new;
end $$;


-- ============================================================
-- 2. pr_update：manager 可以更新自己送的單（投票）
--    原本有 requester_id <> auth.uid() 擋著
-- ============================================================
drop policy if exists pr_update on public.purchase_requests;
create policy pr_update on public.purchase_requests for update using (
  (requester_id = auth.uid() and status in ('draft','rejected'))
  or (current_role_of() = 'manager' and status in ('pending','approved'))
  or (current_role_of() = 'accountant' and status = 'approved')
  or current_role_of() = 'super_admin'
) with check (
  (requester_id = auth.uid() and status in ('draft','rejected','pending','approved'))
  or current_role_of() in ('manager','accountant','super_admin')
);


-- ============================================================
-- 3. pr_delete：撤銷規則
--    原本只有「自己的 draft / rejected」能刪
--
--    expense_generated_at is null 這條寫在 RLS 而不是只靠前端藏按鈕 ——
--    支出是錢真的花掉的紀錄，而且 gen_expenses_from_pr() 只在採購日
--    「從無到有」時才建立支出，單子刪掉後重填採購日也補不回來。
-- ============================================================
drop policy if exists pr_delete on public.purchase_requests;
create policy pr_delete on public.purchase_requests for delete using (
  expense_generated_at is null
  and (
    requester_id = auth.uid()
    or current_role_of() in ('manager','accountant','super_admin')
  )
);


-- ============================================================
-- 4. 驗證
-- ============================================================
-- 確認三個 policy 與函式都是新版：
select policyname, cmd, qual
from pg_policies
where schemaname = 'public' and tablename = 'purchase_requests'
order by policyname;

select prosrc like '%不得核可自己送出%' as 仍擋自核_應為false
from pg_proc where proname = 'pr_guard_votes';
