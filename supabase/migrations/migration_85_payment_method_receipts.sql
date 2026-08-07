-- migration_85：收款方式，以及每一筆收款可以附圖
--
-- ============================================================
-- 【一、收款方式】
--
-- migration_84 只有「收款帳號」一個欄位。問題是那張表（payment_accounts）
-- 裡只有元大 8088／0564／4145 三個匯款帳號 ——
-- 收現金、收加密貨幣、刷卡的時候沒有東西可選，只能留白，
-- 事後完全看不出那筆錢是怎麼進來的。
--
-- 所以拆成兩個欄位：
--
--     method   現金 / 匯款 / 信用卡 / 加密貨幣
--     account  只有「匯款」對得到我方帳戶
--
-- **這四個值不是新造的** —— 押金收退款（deposits.received_method）用的就是
-- 同一組。全站共用一份定義在 lib/pay-method.ts。
--
-- 【為什麼非匯款一定要把 account 清成 null】
-- 使用者會先選匯款＋元大 8088，再改成現金。只把畫面欄位藏起來的話，
-- 資料庫裡那個帳號還在，對帳時這筆現金會出現在元大 8088 的明細裡。
-- 前端會清，但前端清不算數 —— 約束才算。
--
--
-- ============================================================
-- 【二、每筆收款的證明照片】
--
-- 沿用既有的 attachments + receipts bucket，多一個父鍵就好。
-- 做法完全比照 migration_61 幫押金加 deposit_id 的那次。
--
-- 路徑前綴是 op/{收款id}/{uuid}.{副檔名}。
-- can_edit_receipt() / can_see_receipt() **不用改** ——
-- 它們對會計／主管／總經理一律回 true，而 order_payments 的 RLS
-- 本來就只開放這三種角色，兩邊剛好對齊。
-- 其他角色會走 else 分支去比對 purchase_requests，收款 id 當然對不到，
-- 結果是 false，正是我們要的。


-- ============================================================
-- 1. 收款方式
-- ============================================================

alter table public.order_payments
  add column if not exists method text;

-- 既有資料：有帳號的一定是匯款進來的，沒有的當現金。
-- migration_84 補登的那批帳號是從 orders.account 帶過來的，語意一致。
update public.order_payments
   set method = case when account is not null then 'transfer' else 'cash' end
 where method is null;

alter table public.order_payments alter column method set default 'transfer';
alter table public.order_payments alter column method set not null;

alter table public.order_payments drop constraint if exists op_method_chk;
alter table public.order_payments add constraint op_method_chk check (
  method in ('cash', 'transfer', 'credit_card', 'crypto')
);

-- 只有匯款能帶帳號。其餘三種一律 null —— 理由見檔頭。
alter table public.order_payments drop constraint if exists op_account_chk;
alter table public.order_payments add constraint op_account_chk check (
  method = 'transfer' or account is null
);

comment on column public.order_payments.method is
  '收款方式:cash 現金 / transfer 匯款 / credit_card 信用卡 / crypto 加密貨幣。'
  '與 deposits.received_method 同一組值,定義在 lib/pay-method.ts。';
comment on column public.order_payments.account is
  '我方收款帳戶,payment_accounts.code。只有 method=transfer 能有值（op_account_chk）。';


-- ============================================================
-- 2. 附件多一個父鍵
--
-- attachments 原本要求「恰好一個父鍵」。多一個候選之後條件仍然是 = 1。
-- ============================================================

alter table public.attachments
  add column if not exists order_payment_id uuid
    references public.order_payments(id) on delete cascade;

create index if not exists att_op_idx on public.attachments (order_payment_id);

alter table public.attachments drop constraint if exists att_one_parent;
alter table public.attachments add constraint att_one_parent check (
  num_nonnulls(request_id, expense_id, deposit_id, order_payment_id) = 1
);

comment on column public.attachments.order_payment_id is
  '這個附件掛在哪一筆短租收款上（收款證明）。storage 路徑前綴 op/。';


-- ============================================================
-- 驗證
--
-- 包在 exception 裡：驗證失敗只發警告，不要把已經做完的
-- schema 變更整包回滾掉（migration_76 就是那樣一夜白做）。
-- ============================================================

do $$
declare n int; c text;
begin
  -- 欄位
  select count(*) into n from information_schema.columns
   where table_schema = 'public' and table_name = 'order_payments' and column_name = 'method';
  if n = 1 then raise notice '✅ order_payments.method 已建立';
  else raise warning '❌ order_payments.method 不存在'; return; end if;

  -- 沒有漏掉的 null（set not null 會擋，但講清楚比較好追）
  select count(*) into n from public.order_payments where method is null;
  if n = 0 then raise notice '✅ 沒有未設定收款方式的收款紀錄';
  else raise warning '❌ 還有 % 筆沒有收款方式', n; end if;

  -- 約束的內容 —— 建在錯的條件上跟沒建一樣。
  -- 不用「插一筆試試看」那種驗法:萬一約束沒生效就真的寫了髒資料進去。
  -- CHECK 是宣告式的,讀定義就是最直接的證明。
  select pg_get_constraintdef(oid) into c from pg_constraint where conname = 'op_account_chk';
  if c like '%transfer%' and c like '%account IS NULL%' then
    raise notice '✅ 「只有匯款能帶帳號」的約束已生效';
  else raise warning '❌ op_account_chk 內容不對:%', c; end if;

  select pg_get_constraintdef(oid) into c from pg_constraint where conname = 'op_method_chk';
  if c like '%crypto%' and c like '%credit_card%' then
    raise notice '✅ 收款方式的四個值都在';
  else raise warning '❌ op_method_chk 內容不對:%', c; end if;

  -- 既有資料沒有違反新約束（set not null / add constraint 會擋，這裡再確認一次）
  select count(*) into n from public.order_payments
   where method <> 'transfer' and account is not null;
  if n = 0 then raise notice '✅ 沒有「非匯款卻帶帳號」的收款紀錄';
  else raise warning '❌ 有 % 筆非匯款卻帶著帳號', n; end if;

  -- 附件父鍵
  select count(*) into n from information_schema.columns
   where table_schema = 'public' and table_name = 'attachments' and column_name = 'order_payment_id';
  if n = 1 then raise notice '✅ attachments.order_payment_id 已建立';
  else raise warning '❌ attachments.order_payment_id 不存在'; end if;

  select pg_get_constraintdef(oid) into c from pg_constraint where conname = 'att_one_parent';
  if c like '%order_payment_id%' then raise notice '✅ 附件的「恰好一個父鍵」已納入收款';
  else raise warning '❌ att_one_parent 沒有納入 order_payment_id:%', c; end if;

  -- 附件外鍵要 cascade：收款紀錄刪了，它的照片不該留成孤兒
  select count(*) into n from pg_constraint
   where conrelid = 'public.attachments'::regclass
     and confrelid = 'public.order_payments'::regclass and confdeltype = 'c';
  if n = 1 then raise notice '✅ 收款→附件 是 on delete cascade';
  else raise warning '❌ 附件外鍵不是 cascade'; end if;

exception when others then
  raise warning '驗證區出錯（schema 變更不受影響）:%', sqlerrm;
end $$;


-- ── 現況 ───────────────────────────────────────────

select method as 收款方式, count(*) as 筆數, sum(amount)::bigint as 金額,
       count(*) filter (where account is not null) as 有帶帳號
from public.order_payments group by 1 order by 2 desc;


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    raise notice '%', (select public.record_migration('85_payment_method_receipts'));
  else
    raise notice '尚未建立 schema_migrations（migration_70），這支沒有被記錄';
  end if;
end $$;
