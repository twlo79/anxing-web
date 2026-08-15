-- migration_39：請款單加入「預定匯款」階段
--
-- 流程變成兩段：
--   核可 → 會計填「預定匯款日 + 匯出帳號」（計畫，錢還沒出去）
--        → 會計按「匯出」→ 採購日成立 → 觸發器產生支出（錢實際出去）
--
-- 現金的單跳過中間那段，直接填採購日。
--
-- purchased_on 的語意因此收斂為「實際付款日」，
-- 而 planned_transfer_on 是「打算哪天付」。兩者並存，不互相取代。

alter table public.purchase_requests
  add column if not exists planned_transfer_on date,
  add column if not exists payout_account text;   -- 我方匯出帳號，對應 payment_accounts.code

comment on column public.purchase_requests.planned_transfer_on is '預定匯款日（計畫）。實際付款日看 purchased_on。';
comment on column public.purchase_requests.payout_account is '我方匯出帳號代號。注意與 payee_account 方向相反 —— 那個是廠商的收款帳號。';

create index if not exists pr_planned_idx on public.purchase_requests (planned_transfer_on);


-- ============================================================
-- 這兩欄只有已核可的單才有意義。
-- 未核可就先排匯款日，等於還沒過關就在安排付錢。
-- ============================================================
alter table public.purchase_requests drop constraint if exists pr_planned_chk;
alter table public.purchase_requests add constraint pr_planned_chk check (
  (planned_transfer_on is null and payout_account is null)
  or status = 'approved'
);


-- ============================================================
-- RLS：會計原本就能更新已核可的單（為了填採購日），
-- 這兩個新欄位落在同一條 policy 底下，不用改。
--
-- 主管與總經理也能按「匯出」—— pr_update 裡他們的條件已涵蓋 approved。
-- 一般（管家）不能碰，policy 只允許他們改自己的 draft/rejected。
-- 這裡不新增 policy，只留註記說明為什麼不用改。
-- ============================================================


-- ============================================================
-- 驗證
-- ============================================================
select column_name, data_type
from information_schema.columns
where table_name = 'purchase_requests'
  and column_name in ('planned_transfer_on','payout_account','purchased_on')
order by column_name;
