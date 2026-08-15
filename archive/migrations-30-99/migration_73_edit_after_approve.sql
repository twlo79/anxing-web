-- migration_73：核可後仍可編輯（存檔即清票重送審）
--
-- 【原本的規則】
-- 請款單一旦 approved 就完全不能改，理由是「錢要出去了，改內容等於繞過審核」。
--
-- 【為什麼改】
-- 那個理由只在「改了不用重審」的前提下成立。實際上核可後才發現金額或
-- 收款帳號填錯是很常見的，而現行做法是撤銷整張單重開一張 ——
-- 單號跳號、附件要重傳、核可的人要重看一遍，比重新送審麻煩得多。
--
-- 改成：**核可後可以編輯，但存檔一定清掉既有核可票、退回重新送審。**
-- 「改內容」和「重新被審一次」永遠綁在一起，就不可能繞過審核。
--
-- 【真正的紅線沒有動】
-- purchased_on 一填，gen_expenses_from_pr() 就把支出產生出來了 ——
-- 那是錢真的花掉的紀錄。所以：
--
--   status = 'approved' 且 purchased_on / expense_generated_at 是 null  → 可編輯
--   出款日已填、支出已產生                                              → 不可編輯
--
-- 後者要調整請到支出頁，或撤銷後重開一張。
--
-- 【押金退款不用改 RLS】
-- dep_write 是 for all 給 accountant/manager/super_admin，沒有狀態限制，
-- 擋住的只有前端。那邊改前端就夠了。
-- CHECK 約束 dep_refund_chk（returned_on 不為 null 時必須是 approved）
-- 也剛好構成同一條紅線：錢匯出去之後改不動。

-- 原本的 using 子句裡，申請人只能碰 draft / rejected / pending。
-- 這裡把 approved 加進去，但加上「支出還沒產生」的條件。
drop policy if exists pr_update on public.purchase_requests;
create policy pr_update on public.purchase_requests for update
  using (
    -- 申請人本人：核可前都能改，含 approved；但支出一產生就收手
    ((requester_id = auth.uid())
      AND (status = any (array['draft', 'rejected', 'pending', 'approved']))
      AND (purchased_on is null) AND (expense_generated_at is null))
    -- 主管：要投票、要駁回，所以 pending / approved 都要能寫
    OR ((current_role_of() = 'manager') AND (status = any (array['pending', 'approved'])))
    -- 會計：排付款與確認支付，只碰 approved
    OR ((current_role_of() = 'accountant') AND (status = 'approved'))
    OR (current_role_of() = 'super_admin')
  )
  with check (
    ((requester_id = auth.uid())
      AND (status = any (array['draft', 'rejected', 'pending', 'approved'])))
    OR (current_role_of() = any (array['manager', 'accountant', 'super_admin']))
  );

comment on policy pr_update on public.purchase_requests is
  '申請人在支出產生前都能編輯(含已核可)。前端存檔時會退回 draft 並清空核可票,'
  '所以「改內容」必定伴隨「重新送審」。出款日一填、支出一產生就鎖住。';


-- 項目的 policy 只認 draft / rejected。
-- 前端存檔時會先把單頭改成 draft 再寫項目，所以現況能運作 ——
-- 但那是靠執行順序撐著的，看程式碼的人不會知道。這裡寫清楚。
comment on policy pri_write on public.purchase_request_items is
  '只在 draft / rejected 時可寫。前端編輯 pending / approved 的單時,'
  '會先把單頭退回 draft 再寫項目 —— 順序不能顛倒,顛倒就會被這條擋下來。';


-- ============================================================
-- 驗證
-- ============================================================
select polname as policy,
       case polcmd when 'w' then 'UPDATE' when 'a' then 'INSERT'
                   when 'r' then 'SELECT' when 'd' then 'DELETE' else polcmd::text end as 動作
from pg_policy
where polrelid = 'public.purchase_requests'::regclass
order by polname;

-- 目前有幾張已核可但還沒出款的單？這些就是新規則下變成可編輯的
select req_no as 單號, status as 狀態, total_amount as 金額,
       purchased_on as 出款日, expense_generated_at as 支出產生時間
from public.purchase_requests
where status = 'approved'
order by created_at desc
limit 20;

select count(*) filter (where purchased_on is null and expense_generated_at is null) as 可編輯,
       count(*) filter (where purchased_on is not null or expense_generated_at is not null) as 已鎖住
from public.purchase_requests
where status = 'approved';


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    raise notice '%', (select public.record_migration('73_edit_after_approve'));
  else
    raise notice '尚未建立 schema_migrations（migration_70），這支沒有被記錄';
  end if;
end $$;
