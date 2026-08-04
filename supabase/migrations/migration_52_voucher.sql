-- migration_52：憑證號碼與「無憑證」註記
--
-- 支出本來就有 voucher_no，請款單沒有 —— 但發票號碼是在請款當下拿到的，
-- 等會計事後補等於要再問一次人。這裡讓請款單也能填，之後產生支出時可以帶過去。
--
-- no_voucher 是刻意跟「號碼空白」分開的兩件事：
--   voucher_no is null and no_voucher = false → 還沒填，會計要追
--   no_voucher = true                          → 確定沒有憑證，不用再追
-- 少了這個旗標，帳上一堆空白的憑證欄位分不出是漏填還是本來就沒有。

alter table public.purchase_requests
  add column if not exists voucher_no text,
  add column if not exists no_voucher boolean not null default false;

alter table public.expenses
  add column if not exists no_voucher boolean not null default false;

comment on column public.purchase_requests.no_voucher is '確定沒有憑證（非漏填）。與 voucher_no 互斥。';
comment on column public.expenses.no_voucher is '確定沒有憑證（非漏填）。與 voucher_no 互斥。';


-- ============================================================
-- 互斥：勾了無憑證就不該有號碼。
-- 寫在資料庫是因為兩個頁面都會寫這兩欄，只靠前端擋遲早有一邊漏改。
-- ============================================================
alter table public.purchase_requests drop constraint if exists pr_voucher_chk;
alter table public.purchase_requests add constraint pr_voucher_chk check (
  not (no_voucher and voucher_no is not null and voucher_no <> '')
);

alter table public.expenses drop constraint if exists exp_voucher_chk;
alter table public.expenses add constraint exp_voucher_chk check (
  not (no_voucher and voucher_no is not null and voucher_no <> '')
);


-- ============================================================
-- 待辦：gen_expenses_from_pr() 產生支出時要把 voucher_no / no_voucher 帶過去。
--
-- 這裡刻意不動那個函式 —— repo 裡的版本（migration_30）已經被
-- migration_34/38/40 改過好幾輪，資料庫上的實際定義跟 repo 對不起來。
-- 照 repo 的版本 create or replace 會把 estate_id、currency、pay_account
-- 那幾次修改整批回捲。要先把線上定義撈出來，改完再一起進版控。
--
--   select pg_get_functiondef('public.gen_expenses_from_pr()'::regprocedure);
--
-- 在那之前，請款單上填的憑證號碼只留在請款單上，
-- 會計確認出款後仍需在支出頁補一次。
-- ============================================================


-- ============================================================
-- 驗證
-- ============================================================
select table_name, column_name, data_type
from information_schema.columns
where (table_name = 'purchase_requests' and column_name in ('voucher_no','no_voucher'))
   or (table_name = 'expenses' and column_name in ('voucher_no','no_voucher'))
order by table_name, column_name;

-- 目前有多少支出的憑證欄位是空的（改版後這些要逐筆確認是漏填還是真的沒有）
select count(*) filter (where voucher_no is null or voucher_no = '') as 憑證空白,
       count(*) as 總筆數
from public.expenses;
