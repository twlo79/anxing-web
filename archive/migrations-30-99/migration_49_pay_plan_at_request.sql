-- migration_49：預定出款日／出款帳號改成申請時就能填
--
-- 原本的流程（migration_39）是：
--   核可 → 會計排付款（填預定匯款日 + 匯出帳號）→ 會計確認匯出
--
-- 實務上申請人送單時就知道「這筆要刷中信卡」「希望 8/15 匯」，
-- 卻要等會計再問一次。所以改成：
--   申請時可先填（選填）→ 核可 → 會計確認實際出款日
--
-- 語意沒有變，只是可以更早填：
--   planned_transfer_on = 打算哪天付（計畫，可改）
--   purchased_on        = 實際哪天付（會計確認，觸發器據此產生支出）
--
-- 會計仍然可以覆寫申請人填的計畫 —— 那兩欄的 RLS 沒動。

-- ============================================================
-- 舊約束要求 status = 'approved' 才能有計畫，現在要拿掉。
-- 保留的部分：付款方式是現金的話沒有「出款帳號」可言。
-- ============================================================
alter table public.purchase_requests drop constraint if exists pr_planned_chk;

alter table public.purchase_requests add constraint pr_planned_chk check (
  payout_account is null or payment_method in ('transfer', 'credit_card')
);

comment on column public.purchase_requests.planned_transfer_on is
  '預定出款日／刷卡日（計畫）。申請人送單時可先填，會計可覆寫。實際付款日看 purchased_on。';
comment on column public.purchase_requests.payout_account is
  '我方出款帳號／信用卡代號，對應 payment_accounts.code。注意與 payee_account 方向相反 —— 那個是廠商的收款帳號。';


-- ============================================================
-- RLS：申請人本來就能更新自己的 draft/rejected（pr_update 裡的
-- requester_id = auth.uid() 那條），欄位沒有白名單限制，
-- 所以這兩欄自動被涵蓋，不需要新增 policy。
--
-- 確認一下條件確實還在：
-- ============================================================
select policyname, cmd, qual, with_check
from pg_policies
where tablename = 'purchase_requests' and cmd in ('UPDATE', 'ALL')
order by policyname;


-- ============================================================
-- 驗證：現有資料有沒有違反新約束的（現金卻有出款帳號）
-- ============================================================
select count(*) as 現金卻有出款帳號_應為0
from public.purchase_requests
where payout_account is not null
  and (payment_method is null or payment_method not in ('transfer', 'credit_card'));

-- 舊約束若有殘留的違規資料，這裡會列出來
select id, req_no, status, payment_method, planned_transfer_on, payout_account
from public.purchase_requests
where planned_transfer_on is not null and status <> 'approved'
order by created_at desc
limit 20;
