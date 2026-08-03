-- migration_50：送審中的請款單可以由申請人編輯
--
-- 原本送出後就鎖死，打錯一個字只能撤銷重開一張，單號也跟著跳號。
--
-- 新規則：
--   draft / rejected / pending  → 申請人可編輯
--   approved 之後               → 不可編輯（錢要出去了，動內容等於繞過審核）
--
-- 「一存檔就清掉既有核可票」怎麼做的：
--   前端在存檔時把 status 先退回 'draft' 並把兩個 *_approved_at 清成 null，
--   寫完項目再送 status='pending'。這樣就直接重用既有的狀態機
--   （pr_apply_status 的 draft→pending 分支），不必新增觸發器邏輯。
--
--   附帶好處：免核門檻會依「新的金額」重算。
--   例如把 5,000 的單改成 2,000，重新送審時會自動核可，
--   而不是卡在 pending 等兩張永遠不需要的票。
--
--   項目的 pri_write policy 只允許 draft/rejected —— 因為 status 是先退回
--   draft 才寫項目，所以那條 policy 不用動。

-- ============================================================
-- pr_update：USING 加上「自己的 pending 單」
--
-- WITH CHECK 那半段本來就允許 requester 把自己的單存成
-- draft/rejected/pending/approved，不用改。
-- ============================================================
drop policy if exists pr_update on public.purchase_requests;
create policy pr_update on public.purchase_requests for update using (
  (requester_id = auth.uid() and status in ('draft','rejected','pending'))
  or (current_role_of() = 'manager' and status in ('pending','approved'))
  or (current_role_of() = 'accountant' and status = 'approved')
  or current_role_of() = 'super_admin'
) with check (
  (requester_id = auth.uid() and status in ('draft','rejected','pending','approved'))
  or current_role_of() in ('manager','accountant','super_admin')
);


-- ============================================================
-- 驗證
-- ============================================================
select policyname, cmd, qual
from pg_policies
where tablename = 'purchase_requests' and policyname = 'pr_update';

-- 目前有幾張單處於可編輯狀態
select status, count(*)
from public.purchase_requests
group by status
order by 2 desc;
