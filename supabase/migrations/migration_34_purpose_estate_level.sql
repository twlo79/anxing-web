-- migration_34：請款/支出的「用途」從房源層級改成物業層級
--
-- 變更（2026-08-01 David 指定）：
--   用途下拉原本列 211 間房源，改成列 7 個物業 + 安幸辦公室。
--   purpose_type: 'property' → 'estate'，新增 estate_id 欄。
--
-- 為什麼現在做：目前只有 1 張請款單、0 筆支出，歷史包袱最小。
-- 等資料多了再改，就得處理大量房源→物業的歸屬爭議。
--
-- property_id 欄位保留不刪（改為可空、不再由 CHECK 要求），理由是
-- 避免 migration 與程式部署之間的空窗期把頁面打掛。舊資料仍留著可追。

-- ============================================================
-- 步驟 0：先看會動到哪些列（唯讀）
-- ============================================================
select 'purchase_request_items' as 表, i.id, i.item_name, i.purpose_type,
       p.name as 原房源, e.name as 將歸屬物業
from purchase_request_items i
left join properties p on p.id = i.property_id
left join estates e on e.id = p.estate_id
union all
select 'expenses', x.id, x.item_name, x.purpose_type,
       p.name, e.name
from expenses x
left join properties p on p.id = x.property_id
left join estates e on e.id = p.estate_id;


-- ============================================================
-- 步驟 1：加 estate_id 欄
-- ============================================================
alter table purchase_request_items add column if not exists estate_id uuid references estates(id);
alter table expenses               add column if not exists estate_id uuid references estates(id);

create index if not exists pri_estate_idx on purchase_request_items (estate_id);
create index if not exists exp_estate_idx on expenses (estate_id);


-- ============================================================
-- 步驟 2：舊資料上捲 —— 房源的所屬物業填進 estate_id
-- ============================================================
update purchase_request_items i
set estate_id = p.estate_id
from properties p
where p.id = i.property_id and i.estate_id is null;

update expenses x
set estate_id = p.estate_id
from properties p
where p.id = x.property_id and x.estate_id is null;


-- ============================================================
-- 步驟 3：purpose_type 'property' → 'estate'
--         先放掉舊 CHECK，改完值再上新 CHECK，順序不能顛倒
-- ============================================================
alter table purchase_request_items drop constraint if exists pri_purpose_chk;
alter table expenses               drop constraint if exists exp_purpose_chk;

update purchase_request_items set purpose_type = 'estate' where purpose_type = 'property';
update expenses               set purpose_type = 'estate' where purpose_type = 'property';

alter table purchase_request_items alter column purpose_type set default 'estate';
alter table expenses               alter column purpose_type set default 'estate';

-- 房源欄不再是必填（保留欄位供追溯，但不再由約束要求）
alter table purchase_request_items add constraint pri_purpose_chk check (
  (purpose_type = 'office' and estate_id is null) or
  (purpose_type = 'estate' and estate_id is not null)
);
alter table expenses add constraint exp_purpose_chk check (
  (purpose_type = 'office' and estate_id is null) or
  (purpose_type = 'estate' and estate_id is not null)
);


-- ============================================================
-- 步驟 4：gen_expenses_from_pr() 要把 estate_id 一起帶過去
--         沒改的話，請款核可後產生的支出會缺 estate_id 而被 CHECK 擋下
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
    return new;                       -- 日期沒變,不重複產生
  end if;

  insert into public.expenses (
    spent_on, item_name, amount, account_code, purpose_type, estate_id, property_id,
    payment_method, note, source_item_id, created_by
  )
  select new.purchased_on, i.item_name, i.amount, i.account_code, i.purpose_type,
         i.estate_id, i.property_id,
         new.payment_method, i.note, i.id, new.requester_id
    from public.purchase_request_items i
   where i.request_id = new.id
  on conflict (source_item_id) do nothing;

  new.expense_generated_at := now();
  return new;
end $$;


-- ============================================================
-- 步驟 5：驗證，應回傳 0 列
-- ============================================================
select 'purchase_request_items' as 表, id, item_name, purpose_type, estate_id
from purchase_request_items
where (purpose_type = 'estate' and estate_id is null)
   or purpose_type not in ('estate','office')
union all
select 'expenses', id, item_name, purpose_type, estate_id
from expenses
where (purpose_type = 'estate' and estate_id is null)
   or purpose_type not in ('estate','office');
