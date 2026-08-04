-- ############################################################################
-- ##                                                                        ##
-- ##   這個檔案不是 migration，不要執行。                                    ##
-- ##                                                                        ##
-- ##   它是線上 schema 的快照，用途是「查詢」不是「重放」：                  ##
-- ##   改任何既有函式前，先在這裡 grep 到真正的定義。                        ##
-- ##                                                                        ##
-- ##   整份執行會失敗（表已存在、create table 沒有依賴排序）。               ##
-- ##   下面那段 raise 會在第一行就把你擋下來。                               ##
-- ##                                                                        ##
-- ############################################################################

do $$
begin
  raise exception
    '這是 schema 快照，不是 migration，不要執行。用途是查詢線上定義 —— 見檔頭說明。';
end $$;


-- ============================================================================
-- migration_00：線上 schema 基準快照（2026-08 匯出）
-- ============================================================================
--
-- migration_30 之前的變更歷史已不可考，以這份為準。
-- 產生方式見 supabase/dump-schema.sql。
--
-- 【這份是參考用，不是可重跑的】
--   create table 沒有依賴排序，整份執行會因外鍵順序失敗。
--   它的價值在於「可查詢」：改任何既有函式前，先在這裡 grep 到真正的定義，
--   不要照 migration_30 那種舊版本猜 —— gen_expenses_from_pr() 已經被
--   34/38/40/52/54/55 改過六輪，照舊版 create or replace 會整批回捲。
--
-- 已刻意排除：
--   - pg_trgm 擴充自帶的函式（gtrgm_*、similarity_*、word_similarity_*、
--     gin_*_trgm、set_limit、show_limit、show_trgm）—— 那是擴充的東西不是我們寫的
--   - rls_auto_enable() event trigger —— Supabase 平台管理，新建表會自動開 RLS
--
-- 需要的擴充：pg_trgm（房號模糊比對）、pg_net（推播用，DB 直接發 HTTP）
--
-- ⚠️ pr_notify_push() 裡的 x-push-key 是明文寫死的共享密鑰。
--    輪替時要同時改函式與 .env.local，兩邊不同步推播會全部失敗。


-- ============================================================================
-- 1. 表
-- ============================================================================

create table public.account_codes (
  code text not null,
  name text not null,
  sort integer not null default 0,
  active boolean not null default true
);

create table public.attachments (
  id uuid not null default gen_random_uuid(),
  request_id uuid,
  expense_id uuid,
  path text not null,
  file_name text,
  mime_type text,
  size_bytes integer,
  uploaded_by uuid,
  created_at timestamp with time zone not null default now(),
  deposit_id uuid
);

create table public.cleaning_records (
  id uuid not null default gen_random_uuid(),
  record_key text not null,
  record_date date not null,
  staff_name text not null,
  staff_id uuid,
  staff_type text,
  property_id uuid,
  property_raw text,
  estate_name text,
  overall_rating integer,
  note text,
  doc_url text,
  source text default 'seed'::text,
  created_at timestamp with time zone not null default now()
);

create table public.contract_payments (
  id uuid not null default gen_random_uuid(),
  contract_id uuid,
  period_start date not null,
  period_end date not null,
  amount numeric not null,
  confirmed boolean not null default false,
  confirmed_at timestamp with time zone,
  order_id uuid
);

create table public.contracts (
  id uuid not null default gen_random_uuid(),
  name text not null,
  type text not null default 'longterm'::text,
  estate_id uuid,
  property_raw text,
  tenant_name text,
  start_date date not null,
  end_date date not null,
  amount_per_period numeric not null,
  cadence text not null default 'monthly'::text,
  account text,
  note text,
  active boolean not null default true,
  created_at timestamp with time zone not null default now(),
  room text,
  monthly_rent numeric,
  deposit numeric,
  phone text,
  paid boolean default false,
  pay_day integer,
  deposit_received boolean default false,     -- 【已淘汰】改用 deposits.received_on
  deposit_received_at date,                   -- 【已淘汰】
  deposit_returned boolean default false,     -- 【已淘汰】改用 deposits.returned_on
  deposit_returned_at date,                   -- 【已淘汰】
  first_payment_date date,
  auto_renew boolean not null default false,
  watch boolean not null default false,
  display_name text,
  invoice_required boolean not null default false,
  invoice_day smallint,
  invoice_after_paid boolean not null default true,
  invoice_title text,
  invoice_tax_id text,
  invoice_note text,
  concessions jsonb not null default '[]'::jsonb
);

create table public.deposits (
  id uuid not null default gen_random_uuid(),
  order_id uuid,
  contract_id uuid,
  estate_id uuid,
  property_id uuid,
  room text,
  guest_name text,
  currency text not null default 'TWD'::text,
  amount numeric not null default 0,
  received_on date,
  received_method text,
  received_account text,
  returned_on date,
  returned_method text,
  returned_account text,        -- 我方出款帳號（與 payee_* 方向相反）
  note text,
  orphaned boolean not null default false,
  created_at timestamp with time zone not null default now(),
  is_manual boolean not null default false,
  refund_status text not null default 'none'::text,
  payee_bank_code text,         -- 房客的收款帳戶
  payee_name text,
  payee_account text,
  planned_refund_on date,
  refund_requested_by uuid,
  refund_requested_at timestamp with time zone,
  manager_approved_by uuid,
  manager_approved_at timestamp with time zone,
  admin_approved_by uuid,
  admin_approved_at timestamp with time zone,
  rejected_by uuid,
  rejected_at timestamp with time zone,
  reject_reason text
);

create table public.estates (
  id uuid not null default gen_random_uuid(),
  name text not null,
  manager text,
  sort integer default 99,
  created_at timestamp with time zone not null default now(),
  active boolean not null default true
);

create table public.expenses (
  id uuid not null default gen_random_uuid(),
  spent_on date not null,
  item_name text not null,
  amount numeric not null default 0,
  account_code text,
  purpose_type text not null default 'estate'::text,
  property_id uuid,
  voucher_no text,
  payment_method text,
  pay_account text,
  note text,
  source_item_id uuid,
  created_by uuid,
  created_at timestamp with time zone not null default now(),
  estate_id uuid,
  currency text not null default 'TWD'::text,
  fx_rate numeric not null default 1,
  amount_original numeric,
  no_voucher boolean not null default false,
  request_id uuid
);

create table public.invoices (
  id uuid not null default gen_random_uuid(),
  contract_id uuid,
  order_id uuid,
  room text not null,
  ym text not null,
  amount numeric,
  invoice_no text not null,
  invoice_date date not null,
  title text,
  tax_id text,
  note text,
  status text not null default 'issued'::text,
  issued_by uuid default auth.uid(),
  created_at timestamp with time zone not null default now()
);

create table public.orders (
  id uuid not null default gen_random_uuid(),
  order_key text not null,
  source text not null,
  estate_id uuid,
  property_id uuid,
  property_raw text,
  guest_name text,
  checkin date not null,
  checkout date not null,
  nights integer not null,
  amount numeric not null default 0,
  deposit numeric default 0,
  account text,
  note text,
  contract_id uuid,
  imported_via text default 'manual'::text,
  created_at timestamp with time zone not null default now(),
  paid boolean not null default false,
  deposit_received boolean default false,     -- 【已淘汰】改用 deposits
  deposit_returned boolean default false,     -- 【已淘汰】
  parent_order_id uuid,
  fee_type text,
  fx_revenue jsonb not null default '[]'::jsonb,
  fx_deposit jsonb not null default '[]'::jsonb,
  move_group uuid,
  deposit_received_at date,                   -- 【已淘汰】
  deposit_returned_at date,                   -- 【已淘汰】
  paid_at date
);

create table public.payment_accounts (
  id uuid not null default gen_random_uuid(),
  method text not null,
  code text not null,
  name text not null,
  for_income boolean not null default true,
  for_payment boolean not null default true,
  sort integer not null default 50,
  active boolean not null default true,
  created_at timestamp with time zone not null default now()
);

create table public.profiles (
  id uuid not null,
  name text not null,
  role text not null default 'housekeeper'::text,
  active boolean not null default true
);

create table public.properties (
  id uuid not null default gen_random_uuid(),
  name text not null,
  airbnb_listing_id text,
  name_aliases text[] default '{}'::text[],
  active boolean not null default true,
  created_at timestamp with time zone not null default now(),
  estate_id uuid
);

create table public.purchase_requests (
  id uuid not null default gen_random_uuid(),
  req_no text not null,
  requester_id uuid not null,
  status text not null default 'draft'::text,
  total_amount numeric not null default 0,
  payment_method text,
  payee_bank_code text,         -- 廠商的收款帳戶
  payee_account text,
  payee_company text,
  payee_tax_id text,
  note text,
  submitted_at timestamp with time zone,
  manager_approved_by uuid,
  manager_approved_at timestamp with time zone,
  admin_approved_by uuid,
  admin_approved_at timestamp with time zone,
  rejected_by uuid,
  rejected_at timestamp with time zone,
  reject_reason text,
  purchased_on date,
  expense_generated_at timestamp with time zone,
  created_at timestamp with time zone not null default now(),
  planned_transfer_on date,
  payout_account text,          -- 我方出款帳號（與 payee_* 方向相反）
  currency text not null default 'TWD'::text,
  fx_rate numeric not null default 1,
  voucher_no text,
  no_voucher boolean not null default false
);

create table public.purchase_request_items (
  id uuid not null default gen_random_uuid(),
  request_id uuid not null,
  item_name text not null,
  amount numeric not null default 0,
  account_code text,
  purpose_type text not null default 'estate'::text,
  property_id uuid,
  note text,
  sort integer not null default 0,
  estate_id uuid,
  amount_original numeric
);

create table public.push_subscriptions (
  id uuid not null default gen_random_uuid(),
  user_id uuid not null,
  endpoint text not null,
  p256dh text not null,
  auth text not null,
  user_agent text,
  created_at timestamp with time zone not null default now(),
  fail_count integer not null default 0,
  last_sent_at timestamp with time zone
);

create table public.revenue_recognitions (
  id uuid not null default gen_random_uuid(),
  order_id uuid not null,
  ym text not null,
  period_start date not null,
  period_end date not null,
  source text not null,
  estate_id uuid,
  property_id uuid,
  estate_name text,
  property_raw text,
  guest_name text,
  checkin date,
  checkout date,
  total_amount numeric,
  total_nights integer,
  month_nights integer,
  month_amount numeric not null,
  created_at timestamp with time zone not null default now(),
  fee_type text
);

create table public.revenue_snapshots (
  id uuid not null default gen_random_uuid(),
  ym text not null,
  source text not null,
  estate_name text,
  property_raw text,
  guest_name text,
  checkin date,
  checkout date,
  total_amount numeric,
  month_amount numeric not null,
  month_nights integer,
  total_nights integer,
  note text,
  created_at timestamp with time zone not null default now()
);

create table public.reviews (
  id uuid not null default gen_random_uuid(),
  airbnb_review_id text not null,
  property_id uuid,
  listing_name_raw text,
  guest_name text not null,
  checkin_date date,
  checkout_date date,
  nights integer,
  overall_rating numeric(2,1) not null,
  comment text,
  comment_original text,
  comment_language text,
  rating_checkin integer,
  rating_cleanliness integer,
  rating_accuracy integer,
  rating_communication integer,
  rating_location integer,
  rating_value integer,
  detail_comments jsonb,
  host_reply text,
  source_url text,
  scraped_at timestamp with time zone not null default now(),
  imported_via text default 'csv'::text
);

create table public.staff (
  id uuid not null default gen_random_uuid(),
  name text not null,
  aliases text[] default '{}'::text[],
  staff_type text not null default 'housekeeper'::text,
  active boolean not null default true,
  sort integer default 99,
  created_at timestamp with time zone not null default now(),
  email text,
  role text default 'housekeeper'::text,
  auth_uid uuid
);

create table public.staff_properties (
  staff_id uuid not null,
  property_id uuid not null
);

-- ── 房務排班（migration_58~60） ──────────────────────────────

create table public.hk_staff (
  id uuid not null default gen_random_uuid(),
  source_name text not null,
  code text not null,
  name text not null,
  count_mode text not null default 'none'::text,
  count_cleans boolean not null default true,
  color text,
  leave_prefix text,
  active boolean not null default true,
  sort integer not null default 0,
  source_names text[] not null default '{}'::text[],
  color_text text,
  color_bar text
);

create table public.hk_property (
  id uuid not null default gen_random_uuid(),
  code text not null,
  name text,
  aliases text[] not null default '{}'::text[],
  beds integer,
  linen_group text not null default 'other'::text,
  is_common boolean not null default false,   -- 與 ptype='common_area' 語意重疊，待收斂
  active boolean not null default true,
  sort integer not null default 0,
  count_linen boolean not null default true,
  ptype text not null default 'room'::text
);

create table public.hk_work_type (
  code text not null,
  name text not null,
  count_workload boolean not null default true,   -- ⚠️ 尚未被任何計算套用
  count_linen boolean not null default true,      -- ⚠️ 尚未被任何計算套用
  sort integer not null default 0,
  active boolean not null default true
);

create table public.hk_event (
  id uuid not null default gen_random_uuid(),
  period text not null,
  event_date date not null,
  title text not null,
  label text,
  assignees text[] not null default '{}'::text[],
  external_id text,
  parsed_code text,
  work_type text,
  excluded text,
  imported_at timestamp with time zone not null default now()
);

create table public.hk_work_item (
  id uuid not null default gen_random_uuid(),
  event_id uuid,
  period text not null,
  work_date date not null,
  property_code text,
  work_type text not null default '清潔'::text,
  staff_id uuid not null,
  created_at timestamp with time zone not null default now(),
  source text not null default 'timetree'::text,
  note text,
  version integer not null default 1
);

create table public.hk_day (
  period text not null,
  work_date date not null,
  staff_id uuid not null,
  status text,
  hours numeric,
  note text,
  rooms_override integer      -- migration_60
);

create table public.hk_month_property (
  period text not null,
  property_code text not null,
  count_override integer,
  linen_taken integer not null default 0
);

create table public.hk_period (
  period text not null,
  count_mode text not null default 'clean'::text,
  include_gift boolean not null default true,
  note text,
  updated_at timestamp with time zone not null default now()
);

create table public.hk_setting (
  key text not null,
  value text,
  vtype text not null default 'text'::text,
  options text[],
  description text,
  sort integer not null default 0
);

create table public.hk_audit (
  id bigint not null default nextval('hk_audit_id_seq'::regclass),
  table_name text not null,
  record_key text not null,
  action text not null,
  changes jsonb,
  user_id uuid,
  at timestamp with time zone not null default now()
  -- ⚠️ 建了但目前沒有任何地方寫入
);


-- ============================================================================
-- 2. 約束
-- ============================================================================

alter table account_codes add constraint account_codes_pkey PRIMARY KEY (code);

alter table attachments add constraint attachments_pkey PRIMARY KEY (id);
alter table attachments add constraint attachments_path_key UNIQUE (path);
alter table attachments add constraint att_one_parent CHECK ((num_nonnulls(request_id, expense_id, deposit_id) = 1));
alter table attachments add constraint attachments_request_id_fkey FOREIGN KEY (request_id) REFERENCES purchase_requests(id) ON DELETE CASCADE;
alter table attachments add constraint attachments_expense_id_fkey FOREIGN KEY (expense_id) REFERENCES expenses(id) ON DELETE CASCADE;
alter table attachments add constraint attachments_deposit_id_fkey FOREIGN KEY (deposit_id) REFERENCES deposits(id) ON DELETE CASCADE;
alter table attachments add constraint attachments_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES profiles(id);

alter table cleaning_records add constraint cleaning_records_pkey PRIMARY KEY (id);
alter table cleaning_records add constraint cleaning_records_record_key_key UNIQUE (record_key);
alter table cleaning_records add constraint cleaning_records_overall_rating_check CHECK (((overall_rating >= 1) AND (overall_rating <= 5)));
alter table cleaning_records add constraint cleaning_records_property_id_fkey FOREIGN KEY (property_id) REFERENCES properties(id);
alter table cleaning_records add constraint cleaning_records_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES staff(id);

alter table contract_payments add constraint contract_payments_pkey PRIMARY KEY (id);
alter table contract_payments add constraint contract_payments_contract_id_period_start_key UNIQUE (contract_id, period_start);
alter table contract_payments add constraint contract_payments_contract_id_fkey FOREIGN KEY (contract_id) REFERENCES contracts(id) ON DELETE CASCADE;
alter table contract_payments add constraint contract_payments_order_id_fkey FOREIGN KEY (order_id) REFERENCES orders(id);

alter table contracts add constraint contracts_pkey PRIMARY KEY (id);
alter table contracts add constraint contracts_estate_id_fkey FOREIGN KEY (estate_id) REFERENCES estates(id);
alter table contracts add constraint contracts_invoice_day_chk CHECK (((invoice_day IS NULL) OR ((invoice_day >= 1) AND (invoice_day <= 31))));
alter table contracts add constraint contracts_invoice_tax_id_chk CHECK (((invoice_tax_id IS NULL) OR (invoice_tax_id = ''::text) OR (invoice_tax_id ~ '^[0-9]{8}$'::text)));

alter table deposits add constraint deposits_pkey PRIMARY KEY (id);
alter table deposits add constraint dep_one_source CHECK (((num_nonnulls(order_id, contract_id) = 1) OR is_manual OR orphaned));
alter table deposits add constraint dep_return_needs_receive CHECK (((returned_on IS NULL) OR (received_on IS NOT NULL)));
alter table deposits add constraint dep_refund_chk CHECK (((returned_on IS NULL) OR (refund_status = 'approved'::text)));
alter table deposits add constraint deposits_refund_status_check CHECK ((refund_status = ANY (ARRAY['none'::text, 'pending'::text, 'approved'::text, 'rejected'::text])));
alter table deposits add constraint deposits_order_id_fkey FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE SET NULL;
alter table deposits add constraint deposits_contract_id_fkey FOREIGN KEY (contract_id) REFERENCES contracts(id) ON DELETE SET NULL;
alter table deposits add constraint deposits_estate_id_fkey FOREIGN KEY (estate_id) REFERENCES estates(id);
alter table deposits add constraint deposits_property_id_fkey FOREIGN KEY (property_id) REFERENCES properties(id);
alter table deposits add constraint deposits_manager_approved_by_fkey FOREIGN KEY (manager_approved_by) REFERENCES profiles(id);
alter table deposits add constraint deposits_admin_approved_by_fkey FOREIGN KEY (admin_approved_by) REFERENCES profiles(id);
alter table deposits add constraint deposits_refund_requested_by_fkey FOREIGN KEY (refund_requested_by) REFERENCES profiles(id);
alter table deposits add constraint deposits_rejected_by_fkey FOREIGN KEY (rejected_by) REFERENCES profiles(id);

alter table estates add constraint estates_pkey PRIMARY KEY (id);
alter table estates add constraint estates_name_key UNIQUE (name);

alter table expenses add constraint expenses_pkey PRIMARY KEY (id);
alter table expenses add constraint expenses_source_item_id_key UNIQUE (source_item_id);
alter table expenses add constraint exp_pay_chk CHECK (((payment_method IS NULL) OR (payment_method = ANY (ARRAY['cash'::text, 'transfer'::text, 'credit_card'::text]))));
alter table expenses add constraint exp_purpose_chk CHECK ((((purpose_type = 'office'::text) AND (estate_id IS NULL)) OR ((purpose_type = 'estate'::text) AND (estate_id IS NOT NULL))));
alter table expenses add constraint exp_room_in_estate CHECK (((property_id IS NULL) OR (estate_id IS NOT NULL)));
alter table expenses add constraint exp_voucher_chk CHECK ((NOT (no_voucher AND (voucher_no IS NOT NULL) AND (voucher_no <> ''::text))));
alter table expenses add constraint expenses_account_code_fkey FOREIGN KEY (account_code) REFERENCES account_codes(code);
alter table expenses add constraint expenses_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);
alter table expenses add constraint expenses_estate_id_fkey FOREIGN KEY (estate_id) REFERENCES estates(id);
alter table expenses add constraint expenses_property_id_fkey FOREIGN KEY (property_id) REFERENCES properties(id);
alter table expenses add constraint expenses_request_id_fkey FOREIGN KEY (request_id) REFERENCES purchase_requests(id) ON DELETE SET NULL;
alter table expenses add constraint expenses_source_item_id_fkey FOREIGN KEY (source_item_id) REFERENCES purchase_request_items(id) ON DELETE SET NULL;

alter table invoices add constraint invoices_pkey PRIMARY KEY (id);
alter table invoices add constraint invoices_invoice_no_chk CHECK ((invoice_no ~ '^[A-Z]{2}[0-9]{8}$'::text));
alter table invoices add constraint invoices_ym_chk CHECK ((ym ~ '^[0-9]{6}$'::text));
alter table invoices add constraint invoices_status_chk CHECK ((status = ANY (ARRAY['issued'::text, 'voided'::text])));
alter table invoices add constraint invoices_contract_id_fkey FOREIGN KEY (contract_id) REFERENCES contracts(id) ON DELETE SET NULL;
alter table invoices add constraint invoices_order_id_fkey FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE SET NULL;

alter table orders add constraint orders_pkey PRIMARY KEY (id);
alter table orders add constraint orders_order_key_key UNIQUE (order_key);
alter table orders add constraint orders_estate_id_fkey FOREIGN KEY (estate_id) REFERENCES estates(id);
alter table orders add constraint orders_property_id_fkey FOREIGN KEY (property_id) REFERENCES properties(id);

alter table payment_accounts add constraint payment_accounts_pkey PRIMARY KEY (id);
alter table payment_accounts add constraint payment_accounts_code_key UNIQUE (code);
-- ⚠️ 只允許 transfer / credit_card。押金頁的「入款方式」提供了 cash 與 crypto，
--    那兩種在這張主檔裡沒有對應帳戶，帳號下拉會是空的。
alter table payment_accounts add constraint payment_accounts_method_check CHECK ((method = ANY (ARRAY['transfer'::text, 'credit_card'::text])));

alter table profiles add constraint profiles_pkey PRIMARY KEY (id);
alter table profiles add constraint profiles_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id);
alter table profiles add constraint profiles_role_chk CHECK ((role = ANY (ARRAY['housekeeper'::text, 'accountant'::text, 'manager'::text, 'super_admin'::text])));

alter table properties add constraint properties_pkey PRIMARY KEY (id);
alter table properties add constraint properties_airbnb_listing_id_key UNIQUE (airbnb_listing_id);
alter table properties add constraint properties_estate_id_fkey FOREIGN KEY (estate_id) REFERENCES estates(id);

alter table purchase_requests add constraint purchase_requests_pkey PRIMARY KEY (id);
alter table purchase_requests add constraint purchase_requests_req_no_key UNIQUE (req_no);
alter table purchase_requests add constraint pr_status_chk CHECK ((status = ANY (ARRAY['draft'::text, 'pending'::text, 'approved'::text, 'rejected'::text])));
alter table purchase_requests add constraint pr_pay_chk CHECK (((payment_method IS NULL) OR (payment_method = ANY (ARRAY['cash'::text, 'transfer'::text, 'credit_card'::text]))));
alter table purchase_requests add constraint pr_purchase_chk CHECK (((purchased_on IS NULL) OR (status = 'approved'::text)));
alter table purchase_requests add constraint pr_planned_chk CHECK (((payout_account IS NULL) OR (payment_method = ANY (ARRAY['transfer'::text, 'credit_card'::text]))));
alter table purchase_requests add constraint pr_fx_chk CHECK (((fx_rate > (0)::numeric) AND ((currency <> 'TWD'::text) OR (fx_rate = (1)::numeric))));
alter table purchase_requests add constraint pr_voucher_chk CHECK ((NOT (no_voucher AND (voucher_no IS NOT NULL) AND (voucher_no <> ''::text))));
alter table purchase_requests add constraint purchase_requests_requester_id_fkey FOREIGN KEY (requester_id) REFERENCES auth.users(id);
alter table purchase_requests add constraint purchase_requests_manager_approved_by_fkey FOREIGN KEY (manager_approved_by) REFERENCES auth.users(id);
alter table purchase_requests add constraint purchase_requests_admin_approved_by_fkey FOREIGN KEY (admin_approved_by) REFERENCES auth.users(id);
alter table purchase_requests add constraint purchase_requests_rejected_by_fkey FOREIGN KEY (rejected_by) REFERENCES auth.users(id);

alter table purchase_request_items add constraint purchase_request_items_pkey PRIMARY KEY (id);
alter table purchase_request_items add constraint pri_purpose_chk CHECK ((((purpose_type = 'office'::text) AND (estate_id IS NULL)) OR ((purpose_type = 'estate'::text) AND (estate_id IS NOT NULL))));
alter table purchase_request_items add constraint purchase_request_items_request_id_fkey FOREIGN KEY (request_id) REFERENCES purchase_requests(id) ON DELETE CASCADE;
alter table purchase_request_items add constraint purchase_request_items_account_code_fkey FOREIGN KEY (account_code) REFERENCES account_codes(code);
alter table purchase_request_items add constraint purchase_request_items_estate_id_fkey FOREIGN KEY (estate_id) REFERENCES estates(id);
alter table purchase_request_items add constraint purchase_request_items_property_id_fkey FOREIGN KEY (property_id) REFERENCES properties(id);

alter table push_subscriptions add constraint push_subscriptions_pkey PRIMARY KEY (id);
alter table push_subscriptions add constraint push_subscriptions_endpoint_key UNIQUE (endpoint);
alter table push_subscriptions add constraint push_subscriptions_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

alter table revenue_recognitions add constraint revenue_recognitions_pkey PRIMARY KEY (id);
alter table revenue_recognitions add constraint revenue_recognitions_order_id_fkey FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE;

alter table revenue_snapshots add constraint revenue_snapshots_pkey PRIMARY KEY (id);

alter table reviews add constraint reviews_pkey PRIMARY KEY (id);
alter table reviews add constraint reviews_airbnb_review_id_key UNIQUE (airbnb_review_id);
alter table reviews add constraint reviews_property_id_fkey FOREIGN KEY (property_id) REFERENCES properties(id);
alter table reviews add constraint reviews_rating_accuracy_check CHECK (((rating_accuracy >= 1) AND (rating_accuracy <= 5)));
alter table reviews add constraint reviews_rating_checkin_check CHECK (((rating_checkin >= 1) AND (rating_checkin <= 5)));
alter table reviews add constraint reviews_rating_cleanliness_check CHECK (((rating_cleanliness >= 1) AND (rating_cleanliness <= 5)));
alter table reviews add constraint reviews_rating_communication_check CHECK (((rating_communication >= 1) AND (rating_communication <= 5)));
alter table reviews add constraint reviews_rating_location_check CHECK (((rating_location >= 1) AND (rating_location <= 5)));
alter table reviews add constraint reviews_rating_value_check CHECK (((rating_value >= 1) AND (rating_value <= 5)));

alter table staff add constraint staff_pkey PRIMARY KEY (id);
alter table staff add constraint staff_name_key UNIQUE (name);
alter table staff add constraint staff_staff_type_check CHECK ((staff_type = ANY (ARRAY['housekeeper'::text, 'roomservice'::text, 'manager'::text, 'accountant'::text, 'gm'::text, 'other'::text])));

alter table staff_properties add constraint staff_properties_pkey PRIMARY KEY (staff_id, property_id);
alter table staff_properties add constraint staff_properties_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES staff(id) ON DELETE CASCADE;
alter table staff_properties add constraint staff_properties_property_id_fkey FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE CASCADE;

-- 房務
alter table hk_staff add constraint hk_staff_pkey PRIMARY KEY (id);
alter table hk_staff add constraint hk_staff_source_name_key UNIQUE (source_name);
alter table hk_staff add constraint hk_staff_count_mode_check CHECK ((count_mode = ANY (ARRAY['rooms'::text, 'hours'::text, 'none'::text])));
alter table hk_property add constraint hk_property_pkey PRIMARY KEY (id);
alter table hk_property add constraint hk_property_code_key UNIQUE (code);
alter table hk_property add constraint hk_property_linen_group_check CHECK ((linen_group = ANY (ARRAY['kai'::text, 'ab'::text, 'zl'::text, 'other'::text])));
alter table hk_property add constraint hk_property_ptype_check CHECK ((ptype = ANY (ARRAY['room'::text, 'building'::text, 'common_area'::text, 'other'::text])));
alter table hk_work_type add constraint hk_work_type_pkey PRIMARY KEY (code);
alter table hk_event add constraint hk_event_pkey PRIMARY KEY (id);
alter table hk_event add constraint hk_event_period_event_date_title_external_id_key UNIQUE (period, event_date, title, external_id);
alter table hk_work_item add constraint hk_work_item_pkey PRIMARY KEY (id);
alter table hk_work_item add constraint hk_work_item_source_check CHECK ((source = ANY (ARRAY['timetree'::text, 'manual'::text, 'timetree_edited'::text])));
alter table hk_work_item add constraint hk_work_item_event_id_fkey FOREIGN KEY (event_id) REFERENCES hk_event(id) ON DELETE CASCADE;
alter table hk_work_item add constraint hk_work_item_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES hk_staff(id);
alter table hk_day add constraint hk_day_pkey PRIMARY KEY (work_date, staff_id);
alter table hk_day add constraint hk_day_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES hk_staff(id) ON DELETE CASCADE;
alter table hk_month_property add constraint hk_month_property_pkey PRIMARY KEY (period, property_code);
alter table hk_period add constraint hk_period_pkey PRIMARY KEY (period);
alter table hk_period add constraint hk_period_count_mode_check CHECK ((count_mode = ANY (ARRAY['clean'::text, 'headcount'::text])));
alter table hk_setting add constraint hk_setting_pkey PRIMARY KEY (key);
alter table hk_setting add constraint hk_setting_vtype_check CHECK ((vtype = ANY (ARRAY['text'::text, 'int'::text, 'bool'::text, 'enum'::text])));
alter table hk_audit add constraint hk_audit_pkey PRIMARY KEY (id);


-- ============================================================================
-- 3. 索引（不含主鍵與唯一約束自動產生的）
-- ============================================================================

CREATE INDEX att_req_idx ON public.attachments USING btree (request_id);
CREATE INDEX att_exp_idx ON public.attachments USING btree (expense_id);
CREATE INDEX att_dep_idx ON public.attachments USING btree (deposit_id);

CREATE INDEX idx_clean_date ON public.cleaning_records USING btree (record_date);
CREATE INDEX idx_clean_property ON public.cleaning_records USING btree (property_id);
CREATE INDEX idx_clean_staff ON public.cleaning_records USING btree (staff_id);
CREATE INDEX idx_clean_rating ON public.cleaning_records USING btree (overall_rating);
CREATE INDEX idx_clean_note_trgm ON public.cleaning_records USING gin (note gin_trgm_ops);

CREATE UNIQUE INDEX dep_order_cur_idx ON public.deposits USING btree (order_id, currency) WHERE (order_id IS NOT NULL);
CREATE UNIQUE INDEX dep_contract_cur_idx ON public.deposits USING btree (contract_id, currency) WHERE (contract_id IS NOT NULL);
CREATE INDEX dep_received_idx ON public.deposits USING btree (received_on);
CREATE INDEX dep_estate_idx ON public.deposits USING btree (estate_id);

CREATE INDEX exp_spent_idx ON public.expenses USING btree (spent_on DESC);
CREATE INDEX exp_account_idx ON public.expenses USING btree (account_code);
CREATE INDEX exp_estate_idx ON public.expenses USING btree (estate_id);
CREATE INDEX exp_prop_idx ON public.expenses USING btree (property_id);
CREATE INDEX exp_request_idx ON public.expenses USING btree (request_id);
CREATE INDEX exp_src_idx ON public.expenses USING btree (source_item_id);

CREATE INDEX invoices_contract_id_idx ON public.invoices USING btree (contract_id);
CREATE INDEX invoices_order_id_idx ON public.invoices USING btree (order_id);
CREATE INDEX invoices_ym_idx ON public.invoices USING btree (ym);
-- 同一契約同一月份只能有一張有效發票
CREATE UNIQUE INDEX invoices_contract_ym_uniq ON public.invoices USING btree (contract_id, ym) WHERE (status = 'issued'::text);

CREATE INDEX idx_orders_checkin ON public.orders USING btree (checkin);
CREATE INDEX idx_orders_checkout ON public.orders USING btree (checkout);
CREATE INDEX idx_orders_estate ON public.orders USING btree (estate_id);
CREATE INDEX idx_orders_source ON public.orders USING btree (source);

CREATE INDEX pay_acct_method_idx ON public.payment_accounts USING btree (method);

CREATE INDEX pr_created_idx ON public.purchase_requests USING btree (created_at DESC);
CREATE INDEX pr_status_idx ON public.purchase_requests USING btree (status);
CREATE INDEX pr_requester_idx ON public.purchase_requests USING btree (requester_id);
CREATE INDEX pr_planned_idx ON public.purchase_requests USING btree (planned_transfer_on);
CREATE INDEX pri_request_idx ON public.purchase_request_items USING btree (request_id);
CREATE INDEX pri_estate_idx ON public.purchase_request_items USING btree (estate_id);

CREATE INDEX push_sub_user_idx ON public.push_subscriptions USING btree (user_id);

CREATE INDEX idx_recog_ym ON public.revenue_recognitions USING btree (ym);
CREATE INDEX idx_recog_order ON public.revenue_recognitions USING btree (order_id);
CREATE INDEX idx_snap_ym ON public.revenue_snapshots USING btree (ym);
CREATE INDEX idx_snap_estate ON public.revenue_snapshots USING btree (estate_name);

CREATE INDEX idx_reviews_property ON public.reviews USING btree (property_id);
CREATE INDEX idx_reviews_checkout ON public.reviews USING btree (checkout_date);
CREATE INDEX idx_reviews_rating ON public.reviews USING btree (overall_rating);

CREATE INDEX hk_event_period_idx ON public.hk_event USING btree (period, event_date);
CREATE INDEX hk_wi_period_idx ON public.hk_work_item USING btree (period, work_date);
CREATE INDEX hk_wi_prop_idx ON public.hk_work_item USING btree (period, property_code);
CREATE INDEX hk_audit_at_idx ON public.hk_audit USING btree (at DESC);


-- ============================================================================
-- 4. 函式
--
-- 這一段是整份檔案最重要的部分 —— 踩坑幾乎都在這裡。
-- 改任何一支之前，先確認你看的是這裡的版本，不是 migration_30 的舊版。
-- ============================================================================

-- ── RLS 基礎 ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.current_role_of()
 RETURNS text LANGUAGE sql STABLE SECURITY DEFINER
AS $function$
  select role from profiles where id = auth.uid() and active
$function$;


-- ── 契約 → 月租單 ───────────────────────────────────────────
-- ⚠️ 這支不是 SECURITY DEFINER。它的巢狀 UPDATE 會用呼叫者的權限跑，
--    所以在 orders 上加欄位白名單的觸發器會擋住它（migration_41 踩過，
--    症狀是「會計改契約日期存不進去且沒有錯誤訊息」）。
CREATE OR REPLACE FUNCTION public.gen_contract_orders(ct contracts)
 RETURNS void LANGUAGE plpgsql
AS $function$
declare ms date; me date; ymtxt text;
begin
  if ct.room is null or ct.start_date is null or ct.end_date is null then return; end if;
  -- 刪除超出租期、未收款、由契約自動生成的月份
  delete from orders
  where order_key like 'LT_' || ct.room || '_%'
    and imported_via = 'contract' and paid = false
    and (checkin < date_trunc('month', ct.start_date)::date or checkin >= ct.end_date);
  if not ct.active or ct.monthly_rent is null or ct.monthly_rent <= 0 then return; end if;
  ms := date_trunc('month', ct.start_date)::date;
  while ms < ct.end_date loop
    me := (ms + interval '1 month')::date;
    ymtxt := to_char(ms, 'YYYYMM');
    insert into orders (order_key, source, estate_id, property_raw, guest_name,
      checkin, checkout, nights, amount, deposit, note, imported_via, contract_id, paid)
    values ('LT_' || ct.room || '_' || ymtxt, 'longterm', ct.estate_id, ct.room, ct.tenant_name,
      ms, me, (me - ms), ct.monthly_rent, 0, '契約應收', 'contract', ct.id, false)
    on conflict (order_key) do update
      set amount = excluded.amount, guest_name = excluded.guest_name,
          estate_id = excluded.estate_id, contract_id = excluded.contract_id
      where orders.imported_via = 'contract' and orders.paid = false;  -- 匯入資料與已收款不覆蓋
    ms := me;
  end loop;
end $function$;

CREATE OR REPLACE FUNCTION public.trg_contracts_sync()
 RETURNS trigger LANGUAGE plpgsql
AS $function$
begin
  if tg_op = 'DELETE' then
    delete from orders where contract_id = old.id and paid = false and imported_via = 'contract';
    return old;
  end if;
  perform gen_contract_orders(new);
  return new;
end $function$;

CREATE OR REPLACE FUNCTION public.rebuild_contract_orders()
 RETURNS integer LANGUAGE plpgsql SECURITY DEFINER
AS $function$
declare ct contracts; c int := 0;
begin
  for ct in select * from contracts loop
    perform gen_contract_orders(ct);
    c := c + 1;
  end loop;
  return c;
end $function$;


-- ── 訂單 → 營收認列 ─────────────────────────────────────────
-- 攤分規則（migration_53）：除最後一個月外無條件捨去到整數，餘數全給最後一個月。
CREATE OR REPLACE FUNCTION public.gen_recognitions(o orders)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER
AS $function$
declare
  ms date; me date; n int; ename text; pname text;
  last_ms date;          -- 最後一個有住宿天數的月份
  acc numeric := 0;      -- 前面各月已認列的合計
  amt numeric;
begin
  select e.name into ename from estates e where e.id = o.estate_id;
  select p.name into pname from properties p where p.id = o.property_id;
  pname := coalesce(pname, o.property_raw);
  -- 一次性收入（含折讓的負數）不跨月，整筆記在 checkin 當月
  if o.source in ('oneoff', 'airbnb_cancelled') then
    if o.checkin is null or o.amount is null then return; end if;
    ms := date_trunc('month', o.checkin)::date;
    insert into revenue_recognitions(order_id, ym, period_start, period_end, source, estate_id, property_id,
      estate_name, property_raw, guest_name, checkin, checkout, total_amount, total_nights, month_nights, month_amount, fee_type)
    values (o.id, to_char(o.checkin,'YYYYMM'), ms, (ms + interval '1 month')::date, 'oneoff', o.estate_id, o.property_id,
      ename, pname, o.guest_name, o.checkin, o.checkout, o.amount, coalesce(o.nights,0), 0, o.amount, coalesce(o.fee_type,'取消費'));
    return;
  end if;
  if o.checkin is null or o.checkout is null or o.nights is null or o.nights <= 0 then return; end if;
  -- checkout 是退房日（不算一晚），所以最後一晚是 checkout - 1。
  -- 7/30 進 8/1 出 → 最後一晚在 7/31，最後一個月是 7 月，不是 8 月。
  last_ms := date_trunc('month', o.checkout - 1)::date;
  ms := date_trunc('month', o.checkin)::date;
  while ms < o.checkout loop
    me := (ms + interval '1 month')::date;
    n := greatest(0, least(o.checkout, me) - greatest(o.checkin, ms));
    if n > 0 then
      if ms = last_ms then
        amt := o.amount - acc;                        -- 餘數全給最後一期
      else
        amt := trunc(o.amount * n / o.nights);        -- 無條件捨去到整數
        acc := acc + amt;
      end if;
      insert into revenue_recognitions(order_id, ym, period_start, period_end, source, estate_id, property_id,
        estate_name, property_raw, guest_name, checkin, checkout, total_amount, total_nights, month_nights, month_amount, fee_type)
      values (o.id, to_char(ms,'YYYYMM'), greatest(o.checkin, ms), least(o.checkout, me),
        case when o.source = 'partner' then 'airbnb' else o.source end,
        o.estate_id, o.property_id,
        ename, pname, o.guest_name, o.checkin, o.checkout, o.amount, o.nights, n, amt, null);
    end if;
    ms := me;
  end loop;
end $function$;

CREATE OR REPLACE FUNCTION public.trg_orders_recog()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
AS $function$
begin
  if tg_op in ('UPDATE','DELETE') then
    delete from revenue_recognitions where order_id = old.id;
  end if;
  if tg_op in ('INSERT','UPDATE') then
    perform gen_recognitions(new);
  end if;
  return coalesce(new, old);
end $function$;

CREATE OR REPLACE FUNCTION public.rebuild_recognitions()
 RETURNS integer LANGUAGE plpgsql SECURITY DEFINER
AS $function$
declare r orders; c int := 0;
begin
  delete from revenue_recognitions;
  for r in select * from orders loop
    perform gen_recognitions(r);
    c := c + 1;
  end loop;
  return c;
end $function$;


-- ── 請款單 ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.next_req_no()
 RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare ym text; n int;
begin
  ym := to_char(now() at time zone 'Asia/Taipei', 'YYYYMM');
  select coalesce(max((regexp_replace(req_no, '^PR-\d{6}-', ''))::int), 0) + 1
    into n from public.purchase_requests where req_no like 'PR-' || ym || '-%';
  return 'PR-' || ym || '-' || lpad(n::text, 3, '0');
end $function$;

CREATE OR REPLACE FUNCTION public.sync_pr_total()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
begin
  update public.purchase_requests p
     set total_amount = coalesce(
       (select sum(amount) from public.purchase_request_items where request_id = p.id), 0)
   where p.id = coalesce(new.request_id, old.request_id);
  return null;
end $function$;

-- 免核門檻寫在這裡，前端不自己算 —— 否則改前端就能繞過門檻。
CREATE OR REPLACE FUNCTION public.pr_apply_status()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
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
end $function$;

CREATE OR REPLACE FUNCTION public.pr_guard_votes()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare r text := current_role_of();
begin
  -- 會計不得核可。RLS 管不到欄位層級（會計為了填出款日必須能 update 該列），
  -- 所以這條只能用觸發器擋。
  if r = 'accountant' and (
       new.manager_approved_at is distinct from old.manager_approved_at or
       new.admin_approved_at   is distinct from old.admin_approved_at) then
    raise exception '會計不得核可請款單';
  end if;
  -- migration_30 原有的「不得核可自己送出的請款單」兩段檢查已移除（開放自核）。
  return new;
end $function$;

-- ⚠️ 被 migration_34/38/40/52/54/55 連續改過六輪的那一支。
--    on conflict do nothing：出款日「從無到有」時才建立支出，
--    連動產生的支出一旦刪除，重填出款日也不會補回來。
CREATE OR REPLACE FUNCTION public.gen_expenses_from_pr()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
begin
  if new.status <> 'approved' or new.purchased_on is null then
    return new;
  end if;
  if old.purchased_on is not null and old.purchased_on = new.purchased_on then
    return new;
  end if;
  -- 只改日期：同步既有支出，不重複產生
  if old.purchased_on is not null and old.purchased_on <> new.purchased_on then
    update public.expenses e
       set spent_on = new.purchased_on
     where e.source_item_id in (
       select i.id from public.purchase_request_items i where i.request_id = new.id);
    return new;
  end if;
  insert into public.expenses (
    spent_on, item_name, amount, amount_original, currency, fx_rate,
    account_code, purpose_type, estate_id, property_id,
    payment_method, pay_account, voucher_no, no_voucher,
    note, source_item_id, request_id, created_by
  )
  select new.purchased_on, i.item_name, i.amount,
         coalesce(i.amount_original, i.amount), new.currency, new.fx_rate,
         i.account_code, i.purpose_type, i.estate_id, i.property_id,
         new.payment_method,
         new.payout_account,          -- 我方付款帳號,之前漏帶,支出頁的付款帳號一直是空的
         -- 一張請款單可能拆成多筆支出，憑證號碼會重複帶。
         -- 這是對的：同一張發票本來就對應多個項目，之後對帳靠這個號碼把它們串回去。
         new.voucher_no, coalesce(new.no_voucher, false),
         i.note, i.id, new.id, new.requester_id
    from public.purchase_request_items i
   where i.request_id = new.id
  on conflict (source_item_id) do nothing;
  new.expense_generated_at := now();
  return new;
end $function$;

-- ⚠️ x-push-key 是明文寫死的共享密鑰。輪替時要同時改這裡與 .env.local。
CREATE OR REPLACE FUNCTION public.pr_notify_push()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
begin
  perform net.http_post(
    url     := 'https://justwork.estia.com.tw/api/push/notify',
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'x-push-key',   '<0117>'
               ),
    body    := jsonb_build_object(
                 'type',       'UPDATE',
                 'table',      'purchase_requests',
                 'record',     to_jsonb(new),
                 'old_record', to_jsonb(old)
               )
  );
  return new;
end $function$;


-- ── 押金 ────────────────────────────────────────────────────
-- ⚠️ migration_56 原版有個 bug：`keep := keep || 'TWD'` 會被當成
--    「陣列 || 陣列」而噴 malformed array literal，導致短租訂單只要
--    押金 > 0 就存不進去。migration_65 改用 array_append 修正。
CREATE OR REPLACE FUNCTION public.sync_order_deposits()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare
  l jsonb;
  keep text[] := '{}';
  c text;
  a numeric;
begin
  -- 台幣押金
  if coalesce(new.deposit, 0) > 0 then
    keep := array_append(keep, 'TWD');
    insert into deposits (order_id, currency, amount, estate_id, property_id, room, guest_name)
    values (new.id, 'TWD', new.deposit, new.estate_id, new.property_id, new.property_raw, new.guest_name)
    on conflict (order_id, currency) where order_id is not null
    do update set amount = excluded.amount, estate_id = excluded.estate_id,
                  property_id = excluded.property_id, room = excluded.room,
                  guest_name = excluded.guest_name, orphaned = false;
  end if;
  -- 外幣押金（fx_deposit: [{"cur":"USD","amt":300}, ...]）
  for l in select * from jsonb_array_elements(coalesce(new.fx_deposit, '[]'::jsonb)) loop
    c := nullif(l->>'cur', '');
    a := coalesce((l->>'amt')::numeric, 0);
    if c is not null and a > 0 then
      keep := array_append(keep, c);
      insert into deposits (order_id, currency, amount, estate_id, property_id, room, guest_name)
      values (new.id, c, a, new.estate_id, new.property_id, new.property_raw, new.guest_name)
      on conflict (order_id, currency) where order_id is not null
      do update set amount = excluded.amount, estate_id = excluded.estate_id,
                    property_id = excluded.property_id, room = excluded.room,
                    guest_name = excluded.guest_name, orphaned = false;
    end if;
  end loop;
  -- 金額被改成 0 或幣別被移除。還沒收錢的直接清掉；
  -- 已經收了的留著標記 orphaned —— 錢在我們手上，紀錄不能無聲消失。
  delete from deposits
   where order_id = new.id and not (currency = any(keep)) and received_on is null;
  update deposits set orphaned = true
   where order_id = new.id and not (currency = any(keep)) and received_on is not null;
  return new;
end $function$;

CREATE OR REPLACE FUNCTION public.sync_contract_deposits()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
begin
  if coalesce(new.deposit, 0) > 0 then
    insert into deposits (contract_id, currency, amount, estate_id, room, guest_name)
    values (new.id, 'TWD', new.deposit, new.estate_id, new.room, new.tenant_name)
    on conflict (contract_id, currency) where contract_id is not null
    do update set amount = excluded.amount, estate_id = excluded.estate_id,
                  room = excluded.room, guest_name = excluded.guest_name, orphaned = false;
  else
    delete from deposits where contract_id = new.id and received_on is null;
    update deposits set orphaned = true
     where contract_id = new.id and received_on is not null;
  end if;
  return new;
end $function$;

-- FK 的 on delete set null 不會標記 orphaned，所以要在刪除前先處理。
CREATE OR REPLACE FUNCTION public.mark_deposits_orphaned()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
begin
  if tg_table_name = 'orders' then
    delete from deposits where order_id = old.id and received_on is null;
    update deposits set orphaned = true,
           note = concat_ws('・', note, '來源訂單已刪除 ' || to_char(now(), 'YYYY-MM-DD'))
     where order_id = old.id;
  else
    delete from deposits where contract_id = old.id and received_on is null;
    update deposits set orphaned = true,
           note = concat_ws('・', note, '來源契約已刪除 ' || to_char(now(), 'YYYY-MM-DD'))
     where contract_id = old.id;
  end if;
  return old;
end $function$;

CREATE OR REPLACE FUNCTION public.dep_apply_refund_status()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
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
end $function$;


-- ── 憑證附件的權限 ──────────────────────────────────────────
-- SECURITY DEFINER：storage policy 要能查 purchase_requests，
-- 但一般使用者對那張表只有自己的列可見，直接查會誤判。
CREATE OR REPLACE FUNCTION public.can_see_receipt(p_path text)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION public.can_edit_receipt(p_path text)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
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
$function$;


-- ── 報表 RPC ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.review_stats(p_from date DEFAULT NULL::date, p_to date DEFAULT NULL::date)
 RETURNS TABLE(estate_id uuid, estate_name text, manager text, sort integer, review_count bigint, avg_rating numeric)
 LANGUAGE sql STABLE
AS $function$
  select e.id, e.name, e.manager, e.sort, count(r.id), round(avg(r.overall_rating), 2)
  from estates e
  join properties p on p.estate_id = e.id
  join reviews r on r.property_id = p.id
  where e.active
    and (p_from is null or r.checkout_date >= p_from)
    and (p_to is null or r.checkout_date <= p_to)
  group by e.id, e.name, e.manager, e.sort
  order by e.sort;
$function$;

CREATE OR REPLACE FUNCTION public.manager_stats(p_from date DEFAULT NULL::date, p_to date DEFAULT NULL::date)
 RETURNS TABLE(manager text, avg_rating numeric, s5 bigint, s4 bigint, s3 bigint, s2 bigint, s1 bigint, total bigint)
 LANGUAGE sql STABLE
AS $function$
  select
    coalesce(e.manager, '未指派'),
    round(avg(r.overall_rating), 2),
    count(*) filter (where r.overall_rating >= 5),
    count(*) filter (where r.overall_rating >= 4 and r.overall_rating < 5),
    count(*) filter (where r.overall_rating >= 3 and r.overall_rating < 4),
    count(*) filter (where r.overall_rating >= 2 and r.overall_rating < 3),
    count(*) filter (where r.overall_rating < 2),
    count(*)
  from reviews r
  join properties p on p.id = r.property_id
  join estates e on e.id = p.estate_id
  where e.active
    and (p_from is null or r.checkout_date >= p_from)
    and (p_to is null or r.checkout_date <= p_to)
  group by coalesce(e.manager, '未指派')
  order by 1;
$function$;

CREATE OR REPLACE FUNCTION public.cleaning_staff_stats(p_from date DEFAULT NULL::date, p_to date DEFAULT NULL::date)
 RETURNS TABLE(staff_name text, staff_type text, active boolean, total bigint, rated bigint, avg_rating numeric, low_count bigint)
 LANGUAGE sql STABLE
AS $function$
  select
    coalesce(s.name, c.staff_name),
    coalesce(s.staff_type, 'other'),
    coalesce(s.active, true),
    count(*),
    count(c.overall_rating),
    round(avg(c.overall_rating), 2),
    count(*) filter (where c.overall_rating <= 4)
  from cleaning_records c
  left join staff s on s.id = c.staff_id
  where (p_from is null or c.record_date >= p_from)
    and (p_to is null or c.record_date <= p_to)
  group by coalesce(s.name, c.staff_name), coalesce(s.staff_type, 'other'), coalesce(s.active, true)
  order by count(*) desc;
$function$;

-- ⚠️ 這兩支還在用舊的 round(..., 2) 攤分法，與 gen_recognitions 的
--    「捨去 + 尾期補餘額」不一致。前端已改讀 revenue_recognitions，
--    這兩支目前沒有被呼叫，但留著會誤導 —— 要用之前先對齊算法。
CREATE OR REPLACE FUNCTION public.monthly_revenue(p_year integer, p_month integer)
 RETURNS TABLE(order_id uuid, source text, estate_id uuid, estate_name text, property_raw text, guest_name text, checkin date, checkout date, total_amount numeric, total_nights integer, month_nights integer, month_amount numeric)
 LANGUAGE sql STABLE
AS $function$
  with m as (
    select make_date(p_year, p_month, 1) as ms,
           (make_date(p_year, p_month, 1) + interval '1 month')::date as me
  )
  select o.id, o.source, o.estate_id, e.name,
    coalesce(p.name, o.property_raw) as property_raw,   -- 優先用內部暱稱
    o.guest_name, o.checkin, o.checkout,
    o.amount, o.nights,
    greatest(0, least(o.checkout, m.me) - greatest(o.checkin, m.ms))::int as month_nights,
    case
      when o.source = 'airbnb_cancelled' then
        case when o.checkout >= m.ms and o.checkout < m.me then o.amount else 0 end
      else
        round(o.amount * greatest(0, least(o.checkout, m.me) - greatest(o.checkin, m.ms))::numeric
              / nullif(o.nights, 0), 2)
    end as month_amount
  from orders o
  left join estates e on e.id = o.estate_id
  left join properties p on p.id = o.property_id
  cross join m
  where (o.checkin < m.me and o.checkout > m.ms)
     or (o.source = 'airbnb_cancelled' and o.checkout >= m.ms and o.checkout < m.me)
  order by e.sort nulls last, o.checkin;
$function$;

CREATE OR REPLACE FUNCTION public.monthly_revenue_summary(p_year integer, p_month integer)
 RETURNS TABLE(estate_id uuid, estate_name text, source text, month_amount numeric, order_count bigint)
 LANGUAGE sql STABLE
AS $function$
  select estate_id, estate_name, source, sum(month_amount), count(*)
  from monthly_revenue(p_year, p_month)
  where month_amount > 0
  group by estate_id, estate_name, source;
$function$;


-- ============================================================================
-- 5. 觸發器
--
-- purchase_requests 上有三支 BEFORE UPDATE，執行順序依名稱字母序：
--   trg_gen_expenses → trg_pr_guard_votes → trg_pr_status
-- ============================================================================

CREATE TRIGGER contracts_sync AFTER INSERT OR DELETE OR UPDATE ON public.contracts
  FOR EACH ROW EXECUTE FUNCTION trg_contracts_sync();

CREATE TRIGGER orders_recognize AFTER INSERT OR DELETE OR UPDATE ON public.orders
  FOR EACH ROW EXECUTE FUNCTION trg_orders_recog();

CREATE TRIGGER trg_sync_pr_total AFTER INSERT OR DELETE OR UPDATE ON public.purchase_request_items
  FOR EACH ROW EXECUTE FUNCTION sync_pr_total();

CREATE TRIGGER trg_pr_status BEFORE UPDATE ON public.purchase_requests
  FOR EACH ROW EXECUTE FUNCTION pr_apply_status();
CREATE TRIGGER trg_pr_guard_votes BEFORE UPDATE ON public.purchase_requests
  FOR EACH ROW EXECUTE FUNCTION pr_guard_votes();
CREATE TRIGGER trg_gen_expenses BEFORE UPDATE ON public.purchase_requests
  FOR EACH ROW EXECUTE FUNCTION gen_expenses_from_pr();
CREATE TRIGGER trg_pr_notify_push AFTER UPDATE ON public.purchase_requests
  FOR EACH ROW WHEN (((new.status IS DISTINCT FROM old.status)
    OR (new.manager_approved_at IS DISTINCT FROM old.manager_approved_at)
    OR (new.admin_approved_at IS DISTINCT FROM old.admin_approved_at)))
  EXECUTE FUNCTION pr_notify_push();

CREATE TRIGGER trg_sync_order_deposits AFTER INSERT OR UPDATE OF deposit, fx_deposit, estate_id, property_id, property_raw, guest_name
  ON public.orders FOR EACH ROW EXECUTE FUNCTION sync_order_deposits();
CREATE TRIGGER trg_sync_contract_deposits AFTER INSERT OR UPDATE OF deposit, estate_id, room, tenant_name
  ON public.contracts FOR EACH ROW EXECUTE FUNCTION sync_contract_deposits();
CREATE TRIGGER trg_orders_dep_orphan BEFORE DELETE ON public.orders
  FOR EACH ROW EXECUTE FUNCTION mark_deposits_orphaned();
CREATE TRIGGER trg_contracts_dep_orphan BEFORE DELETE ON public.contracts
  FOR EACH ROW EXECUTE FUNCTION mark_deposits_orphaned();
CREATE TRIGGER trg_dep_refund_status BEFORE UPDATE ON public.deposits
  FOR EACH ROW EXECUTE FUNCTION dep_apply_refund_status();


-- ============================================================================
-- 6. RLS
--
-- Postgres 的 permissive policy 是 OR 關係。開放新角色的做法是「追加一條」，
-- 不改寫既有的 —— 這就是為什麼同一張表會有 xxx_read 又有 xxx_accountant_read。
-- ============================================================================

alter table public.account_codes          enable row level security;
alter table public.attachments            enable row level security;
alter table public.cleaning_records       enable row level security;
alter table public.contract_payments      enable row level security;
alter table public.contracts              enable row level security;
alter table public.deposits               enable row level security;
alter table public.estates                enable row level security;
alter table public.expenses               enable row level security;
alter table public.invoices               enable row level security;
alter table public.orders                 enable row level security;
alter table public.payment_accounts       enable row level security;
alter table public.profiles               enable row level security;
alter table public.properties             enable row level security;
alter table public.purchase_requests      enable row level security;
alter table public.purchase_request_items enable row level security;
alter table public.push_subscriptions     enable row level security;
alter table public.revenue_recognitions   enable row level security;
alter table public.revenue_snapshots      enable row level security;
alter table public.reviews                enable row level security;
alter table public.staff                  enable row level security;
alter table public.staff_properties       enable row level security;
alter table public.hk_staff               enable row level security;
alter table public.hk_property            enable row level security;
alter table public.hk_work_type           enable row level security;
alter table public.hk_event               enable row level security;
alter table public.hk_work_item           enable row level security;
alter table public.hk_day                 enable row level security;
alter table public.hk_month_property      enable row level security;
alter table public.hk_period              enable row level security;
alter table public.hk_setting             enable row level security;
alter table public.hk_audit               enable row level security;

-- ── 主檔 ────────────────────────────────────────────────────
create policy ac_read on public.account_codes for select
  using ((current_role_of() = ANY (ARRAY['housekeeper','accountant','manager','super_admin'])));
create policy ac_write on public.account_codes for all
  using ((current_role_of() = 'super_admin')) with check ((current_role_of() = 'super_admin'));
create policy account_codes_accountant_all on public.account_codes for all
  using ((current_role_of() = 'accountant')) with check ((current_role_of() = 'accountant'));

create policy estates_read on public.estates for select using ((current_role_of() IS NOT NULL));
create policy estates_write on public.estates for all using ((current_role_of() = 'super_admin'));
create policy estates_accountant_read on public.estates for select using ((current_role_of() = 'accountant'));
create policy estates_accountant_all on public.estates for all
  using ((current_role_of() = 'accountant')) with check ((current_role_of() = 'accountant'));

create policy properties_read on public.properties for select using ((current_role_of() IS NOT NULL));
create policy properties_write on public.properties for all using ((current_role_of() = 'super_admin'));
create policy properties_accountant_read on public.properties for select using ((current_role_of() = 'accountant'));
create policy properties_accountant_all on public.properties for all
  using ((current_role_of() = 'accountant')) with check ((current_role_of() = 'accountant'));

create policy pay_acct_read on public.payment_accounts for select using ((current_role_of() IS NOT NULL));
create policy pay_acct_write on public.payment_accounts for all
  using ((current_role_of() = 'super_admin')) with check ((current_role_of() = 'super_admin'));

create policy staff_read on public.staff for select using ((current_role_of() IS NOT NULL));
create policy staff_write on public.staff for all using ((current_role_of() = 'super_admin'));
create policy sp_read on public.staff_properties for select using ((current_role_of() IS NOT NULL));
create policy sp_write on public.staff_properties for all using ((current_role_of() = 'super_admin'));

create policy profiles_self_read on public.profiles for select
  using (((id = auth.uid()) OR (current_role_of() = 'super_admin')));
create policy profiles_self_read_accountant on public.profiles for select using ((id = auth.uid()));
create policy profiles_admin_write on public.profiles for all using ((current_role_of() = 'super_admin'));

-- ── 交易 ────────────────────────────────────────────────────
create policy orders_rw on public.orders for all
  using ((current_role_of() = ANY (ARRAY['manager','super_admin'])));
create policy orders_housekeeper on public.orders for all
  using ((current_role_of() = 'housekeeper')) with check ((current_role_of() = 'housekeeper'));
create policy orders_accountant_read on public.orders for select using ((current_role_of() = 'accountant'));
create policy orders_accountant_all on public.orders for all
  using ((current_role_of() = 'accountant')) with check ((current_role_of() = 'accountant'));

create policy contracts_rw on public.contracts for all
  using ((current_role_of() = ANY (ARRAY['housekeeper','manager','super_admin'])));
create policy contracts_accountant_read on public.contracts for select using ((current_role_of() = 'accountant'));
create policy contracts_accountant_write on public.contracts for all
  using ((current_role_of() = 'accountant')) with check ((current_role_of() = 'accountant'));

create policy cp_rw on public.contract_payments for all
  using ((current_role_of() = ANY (ARRAY['housekeeper','manager','super_admin'])));

create policy invoices_all on public.invoices for all
  using ((current_role_of() = ANY (ARRAY['housekeeper','manager','super_admin'])))
  with check ((current_role_of() = ANY (ARRAY['housekeeper','manager','super_admin'])));
create policy invoices_accountant_read on public.invoices for select using ((current_role_of() = 'accountant'));
create policy invoices_accountant_write on public.invoices for all
  using ((current_role_of() = 'accountant')) with check ((current_role_of() = 'accountant'));

-- revenue_recognitions 對所有角色唯讀 —— 那是 orders 的衍生資料，能手改就會對不起來
create policy recog_read on public.revenue_recognitions for select
  using ((current_role_of() = ANY (ARRAY['manager','super_admin'])));
create policy revenue_recognitions_accountant_read on public.revenue_recognitions for select
  using ((current_role_of() = 'accountant'));
create policy snap_rw on public.revenue_snapshots for all
  using ((current_role_of() = ANY (ARRAY['manager','super_admin'])));

-- ── 請款與支出 ──────────────────────────────────────────────
create policy pr_read on public.purchase_requests for select
  using (((current_role_of() = ANY (ARRAY['accountant','manager','super_admin']))
       OR ((current_role_of() = 'housekeeper') AND (requester_id = auth.uid()))));
create policy pr_insert on public.purchase_requests for insert
  with check (((requester_id = auth.uid()) AND (status = 'draft')
    AND (current_role_of() = ANY (ARRAY['housekeeper','accountant','manager','super_admin']))));
create policy pr_update on public.purchase_requests for update
  using ((((requester_id = auth.uid()) AND (status = ANY (ARRAY['draft','rejected','pending'])))
       OR ((current_role_of() = 'manager') AND (status = ANY (ARRAY['pending','approved'])))
       OR ((current_role_of() = 'accountant') AND (status = 'approved'))
       OR (current_role_of() = 'super_admin')))
  with check ((((requester_id = auth.uid()) AND (status = ANY (ARRAY['draft','rejected','pending','approved'])))
       OR (current_role_of() = ANY (ARRAY['manager','accountant','super_admin']))));
-- 已產生支出的單不能撤銷：支出是錢真的花掉的紀錄，刪了重填出款日也補不回來
create policy pr_delete on public.purchase_requests for delete
  using (((expense_generated_at IS NULL) AND ((requester_id = auth.uid())
       OR (current_role_of() = ANY (ARRAY['manager','accountant','super_admin'])))));

create policy pri_read on public.purchase_request_items for select
  using ((EXISTS ( SELECT 1 FROM purchase_requests p
    WHERE ((p.id = purchase_request_items.request_id)
      AND ((current_role_of() = ANY (ARRAY['accountant','manager','super_admin']))
        OR (p.requester_id = auth.uid()))))));
create policy pri_write on public.purchase_request_items for all
  using (((EXISTS ( SELECT 1 FROM purchase_requests p
    WHERE ((p.id = purchase_request_items.request_id) AND (p.requester_id = auth.uid())
      AND (p.status = ANY (ARRAY['draft','rejected']))))) OR (current_role_of() = 'super_admin')))
  with check (((EXISTS ( SELECT 1 FROM purchase_requests p
    WHERE ((p.id = purchase_request_items.request_id) AND (p.requester_id = auth.uid())
      AND (p.status = ANY (ARRAY['draft','rejected']))))) OR (current_role_of() = 'super_admin')));
create policy pri_accountant_all on public.purchase_request_items for all
  using ((current_role_of() = 'accountant')) with check ((current_role_of() = 'accountant'));

create policy exp_read on public.expenses for select
  using ((current_role_of() = ANY (ARRAY['accountant','manager','super_admin'])));
create policy exp_write on public.expenses for all
  using ((current_role_of() = ANY (ARRAY['accountant','manager','super_admin'])))
  with check ((current_role_of() = ANY (ARRAY['accountant','manager','super_admin'])));

create policy dep_read on public.deposits for select
  using ((current_role_of() = ANY (ARRAY['accountant','manager','super_admin'])));
create policy dep_write on public.deposits for all
  using ((current_role_of() = ANY (ARRAY['accountant','manager','super_admin'])))
  with check ((current_role_of() = ANY (ARRAY['accountant','manager','super_admin'])));

create policy att_read on public.attachments for select using (can_see_receipt(path));
create policy att_write on public.attachments for insert
  with check ((can_edit_receipt(path) AND (uploaded_by = auth.uid())));
create policy att_delete on public.attachments for delete using (can_edit_receipt(path));

-- ── 其他 ────────────────────────────────────────────────────
create policy reviews_read on public.reviews for select using ((current_role_of() IS NOT NULL));
create policy reviews_write on public.reviews for all
  using ((current_role_of() = ANY (ARRAY['manager','super_admin'])));
create policy clean_read on public.cleaning_records for select using ((current_role_of() IS NOT NULL));
create policy clean_write on public.cleaning_records for all
  using ((current_role_of() = ANY (ARRAY['manager','super_admin'])));

create policy push_own_select on public.push_subscriptions for select using ((user_id = auth.uid()));
create policy push_own_insert on public.push_subscriptions for insert with check ((user_id = auth.uid()));
create policy push_own_update on public.push_subscriptions for update
  using ((user_id = auth.uid())) with check ((user_id = auth.uid()));
create policy push_own_delete on public.push_subscriptions for delete using ((user_id = auth.uid()));

-- 房務：主管與總經理。牽涉個人工作量與出勤，會計看不到。
create policy hk_staff_all          on public.hk_staff          for all using ((current_role_of() = ANY (ARRAY['manager','super_admin']))) with check ((current_role_of() = ANY (ARRAY['manager','super_admin'])));
create policy hk_property_all       on public.hk_property       for all using ((current_role_of() = ANY (ARRAY['manager','super_admin']))) with check ((current_role_of() = ANY (ARRAY['manager','super_admin'])));
create policy hk_work_type_all      on public.hk_work_type      for all using ((current_role_of() = ANY (ARRAY['manager','super_admin']))) with check ((current_role_of() = ANY (ARRAY['manager','super_admin'])));
create policy hk_event_all          on public.hk_event          for all using ((current_role_of() = ANY (ARRAY['manager','super_admin']))) with check ((current_role_of() = ANY (ARRAY['manager','super_admin'])));
create policy hk_work_item_all      on public.hk_work_item      for all using ((current_role_of() = ANY (ARRAY['manager','super_admin']))) with check ((current_role_of() = ANY (ARRAY['manager','super_admin'])));
create policy hk_day_all            on public.hk_day            for all using ((current_role_of() = ANY (ARRAY['manager','super_admin']))) with check ((current_role_of() = ANY (ARRAY['manager','super_admin'])));
create policy hk_month_property_all on public.hk_month_property for all using ((current_role_of() = ANY (ARRAY['manager','super_admin']))) with check ((current_role_of() = ANY (ARRAY['manager','super_admin'])));
create policy hk_period_all         on public.hk_period         for all using ((current_role_of() = ANY (ARRAY['manager','super_admin']))) with check ((current_role_of() = ANY (ARRAY['manager','super_admin'])));
create policy hk_setting_all        on public.hk_setting        for all using ((current_role_of() = ANY (ARRAY['manager','super_admin']))) with check ((current_role_of() = ANY (ARRAY['manager','super_admin'])));
create policy hk_audit_all          on public.hk_audit          for all using ((current_role_of() = ANY (ARRAY['manager','super_admin']))) with check ((current_role_of() = ANY (ARRAY['manager','super_admin'])));
