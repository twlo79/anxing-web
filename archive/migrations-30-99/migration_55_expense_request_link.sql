-- migration_55：支出連回請款單，憑證照片跟著沿用
--
-- 需求是「請款單上傳的憑證照片，變成支出後也看得到」。
--
-- 沒有把檔案複製一份到 exp/{expense_id}/ 底下：
--   一張請款單常常拆成好幾筆支出，複製會讓同一張發票在 storage 裡出現 N 份，
--   之後有人在支出頁刪掉其中一張，其他幾筆還留著，對帳時分不出哪張才算數。
--   照片只存一份，用「這筆支出來自哪張請款單」把它連回去。
--
-- expenses.request_id 除了照片以外本身就有用 ——
-- 現在只能靠 source_item_id 一路 join 回去才知道支出的來歷。

alter table public.expenses
  add column if not exists request_id uuid references public.purchase_requests(id) on delete set null;

comment on column public.expenses.request_id is
  '這筆支出由哪張請款單產生（手動建立的支出為 null）。憑證照片沿用請款單上的，不另外複製檔案。';

create index if not exists exp_request_idx on public.expenses (request_id);


-- ============================================================
-- 回填既有資料
-- ============================================================
update public.expenses e
   set request_id = i.request_id
  from public.purchase_request_items i
 where e.source_item_id = i.id
   and e.request_id is null;


-- ============================================================
-- 產生支出時一併寫入。
-- 其餘邏輯與 migration_54 完全相同，只多了 request_id 一欄。
-- ============================================================
create or replace function public.gen_expenses_from_pr()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
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


-- ============================================================
-- can_see_receipt：會計以上看得到全部，這條不用改。
-- 一般使用者原本就只看得到自己送的請款單底下的附件 ——
-- 支出頁本來就對管家關閉，所以沿用的照片不會外流。
-- ============================================================


-- ============================================================
-- 驗證
-- ============================================================
select count(*) filter (where request_id is not null) as 來自請款單,
       count(*) filter (where request_id is null)     as 手動建立,
       count(*) as 總筆數
from public.expenses;

-- 有 source_item_id 卻沒回填到 request_id 的（應為 0）
select count(*) as 回填遺漏_應為0
from public.expenses
where source_item_id is not null and request_id is null;
