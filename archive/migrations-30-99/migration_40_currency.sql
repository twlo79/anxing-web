-- migration_40：請款單支援外幣
--
-- 設計取捨：項目的 amount 欄「維持台幣」，另存一個 amount_original 記原幣別金額。
--
-- 直覺的做法是 amount 存原幣、總額再乘匯率，但那會連帶要改 sync_pr_total()
-- 與 pr_apply_status()（免核門檻的判斷依據），而且匯率一改就得重算所有子表。
-- 改成「amount 一律台幣，換算在前端做」之後：
--   total_amount = sum(amount) 仍然成立，觸發器不用動
--   $3,000 免核門檻自動就是台幣判斷，不會有 100 USD 被當小額放行
--   支出頁與營收報表的金額欄位語意不變
-- 代價是前端存檔時要負責換算，這在同一次送出裡完成，不會有不一致的中間狀態。

alter table public.purchase_requests
  add column if not exists currency text not null default 'TWD',
  add column if not exists fx_rate  numeric not null default 1;

alter table public.purchase_request_items
  add column if not exists amount_original numeric;

alter table public.expenses
  add column if not exists currency        text not null default 'TWD',
  add column if not exists fx_rate         numeric not null default 1,
  add column if not exists amount_original numeric;

comment on column public.purchase_requests.fx_rate is '1 原幣 = ? 台幣。台幣單一律為 1。';
comment on column public.purchase_request_items.amount_original is '原幣別金額。amount 一律是換算後的台幣。';
comment on column public.expenses.amount_original is '原幣別金額。amount 一律是台幣，報表與統計都用 amount。';

alter table public.purchase_requests drop constraint if exists pr_fx_chk;
alter table public.purchase_requests add constraint pr_fx_chk check (
  fx_rate > 0 and (currency <> 'TWD' or fx_rate = 1)
);


-- ============================================================
-- 既有資料回填：全部都是台幣
-- ============================================================
update public.purchase_request_items set amount_original = amount where amount_original is null;
update public.expenses set amount_original = amount where amount_original is null;


-- ============================================================
-- gen_expenses_from_pr()：把幣別資訊一併帶到支出
-- ============================================================
create or replace function public.gen_expenses_from_pr() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status <> 'approved' or new.purchased_on is null then
    return new;
  end if;
  if old.purchased_on is not null and old.purchased_on = new.purchased_on then
    return new;
  end if;
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
    payment_method, pay_account, note, source_item_id, created_by
  )
  select new.purchased_on, i.item_name, i.amount,
         coalesce(i.amount_original, i.amount), new.currency, new.fx_rate,
         i.account_code, i.purpose_type, i.estate_id, i.property_id,
         new.payment_method,
         new.payout_account,          -- 我方付款帳號,之前漏帶,支出頁的付款帳號一直是空的
         i.note, i.id, new.requester_id
    from public.purchase_request_items i
   where i.request_id = new.id
  on conflict (source_item_id) do nothing;

  new.expense_generated_at := now();
  return new;
end $$;


-- ============================================================
-- 驗證
-- ============================================================
select column_name, data_type, column_default
from information_schema.columns
where table_name in ('purchase_requests','purchase_request_items','expenses')
  and column_name in ('currency','fx_rate','amount_original')
order by table_name, column_name;

-- 應回傳 0 列
select count(*) as 未回填_應為0 from public.purchase_request_items where amount_original is null;
