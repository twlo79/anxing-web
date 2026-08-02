-- migration_38：付款/收款帳號主檔
--
-- 現況問題：帳號清單寫死在三個頁面裡，而且寫法不一致 ——
--   contracts  入款帳號  '8088' / '0564' / '4145'
--   shortterm  入款方式  '現金' / '8088' / '0564' / '4145' / '加密貨幣'
--   expenses   付款帳號  '8088 0513'   ← 同一個帳號多了後四碼
-- 支出頁那個跟其他頁對不起來，跨頁統計會被當成兩個不同帳號。
--
-- 模型：支付方式（寫死四種，不會變）→ 底下可以有多個帳號
--   現金      無帳號
--   匯款      可多個
--   信用卡    可多個
--   加密貨幣  無帳號（不細分錢包）

create table if not exists public.payment_accounts (
  id          uuid primary key default gen_random_uuid(),
  method      text not null check (method in ('transfer','credit_card')),
  -- code 是「資料實際存進 orders.account / expenses.pay_account 的值」，
  -- 一旦有交易掛在上面就不該再改，否則舊資料會對不到。要改標示請改 name。
  code        text not null unique,
  name        text not null,
  for_income  boolean not null default true,   -- 可用於收款（短租、契約）
  for_payment boolean not null default true,   -- 可用於付款（請款、支出）
  sort        int not null default 50,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

create index if not exists pay_acct_method_idx on public.payment_accounts (method);

alter table public.payment_accounts enable row level security;

-- 所有登入者可讀（各頁下拉都要用），只有總經理能改
drop policy if exists pay_acct_read on public.payment_accounts;
create policy pay_acct_read on public.payment_accounts
  for select using (current_role_of() is not null);

drop policy if exists pay_acct_write on public.payment_accounts;
create policy pay_acct_write on public.payment_accounts
  for all using (current_role_of() = 'super_admin')
  with check (current_role_of() = 'super_admin');


-- ============================================================
-- 初始資料
--   三個匯款帳號都是元大，收付兩用（契約與短租現在就用它們收款）。
--   信用卡只用於付款，末四碼待補，之後在設定頁改 name 即可。
-- ============================================================
insert into public.payment_accounts (method, code, name, for_income, for_payment, sort) values
  ('transfer',    '8088', '元大 8088', true,  true,  1),
  ('transfer',    '0564', '元大 0564', true,  true,  2),
  ('transfer',    '4145', '元大 4145', true,  true,  3),
  ('credit_card', '匯豐', '匯豐信用卡', false, true, 11),
  ('credit_card', '中信', '中信信用卡', false, true, 12)
on conflict (code) do nothing;


-- ============================================================
-- 正規化既有資料：'8088 0513' → '8088'
-- 不做的話支出頁的帳號永遠跟其他頁對不起來
-- ============================================================
update public.expenses set pay_account = '8088' where pay_account = '8088 0513';


-- ============================================================
-- 驗證
-- ============================================================
select method, code, name, for_income, for_payment, sort
from public.payment_accounts order by sort;

-- 應回傳 0 列
select distinct pay_account from public.expenses
where pay_account is not null
  and pay_account not in (select code from public.payment_accounts);
