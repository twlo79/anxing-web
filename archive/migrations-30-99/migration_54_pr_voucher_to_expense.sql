-- migration_54：請款單的憑證資訊帶進支出
--
-- 補 migration_52 留下的 TODO。當時沒動這個函式是因為資料庫上的定義
-- 已經被 migration_34/38/40 改過好幾輪，跟 repo 裡的版本對不起來，
-- 照 repo 重寫會把那幾次修改整批回捲。
--
-- 這個版本是從線上撈下來的定義（pg_get_functiondef）改的，
-- 只在 insert 的欄位與 select 各加了 voucher_no / no_voucher 兩欄，
-- 其餘邏輯逐字保留。順便讓它進版控，下次不用再撈一次。

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
    note, source_item_id, created_by
  )
  select new.purchased_on, i.item_name, i.amount,
         coalesce(i.amount_original, i.amount), new.currency, new.fx_rate,
         i.account_code, i.purpose_type, i.estate_id, i.property_id,
         new.payment_method,
         new.payout_account,          -- 我方付款帳號,之前漏帶,支出頁的付款帳號一直是空的
         -- 一張請款單可能拆成多筆支出，憑證號碼會重複帶。
         -- 這是對的：同一張發票本來就對應多個項目，之後對帳靠這個號碼把它們串回去。
         new.voucher_no, coalesce(new.no_voucher, false),
         i.note, i.id, new.requester_id
    from public.purchase_request_items i
   where i.request_id = new.id
  on conflict (source_item_id) do nothing;

  new.expense_generated_at := now();
  return new;
end $function$;


-- ============================================================
-- 驗證
-- ============================================================
-- 函式裡確實有帶到憑證欄位
select position('voucher_no' in pg_get_functiondef('public.gen_expenses_from_pr()'::regprocedure)) > 0
       as 有帶憑證欄位;

-- 已經產生過支出的請款單不會回頭補（on conflict do nothing）。
-- 這些是改版前就結案的單，憑證要人工補：
select p.req_no, p.purchased_on, p.voucher_no, count(e.id) as 支出筆數
from public.purchase_requests p
join public.purchase_request_items i on i.request_id = p.id
join public.expenses e on e.source_item_id = i.id
where e.voucher_no is null and coalesce(e.no_voucher, false) = false
group by p.req_no, p.purchased_on, p.voucher_no
order by p.purchased_on desc
limit 30;
