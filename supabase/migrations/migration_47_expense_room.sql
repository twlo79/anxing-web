-- migration_47：支出可選填房源
--
-- 用途目前是物業層級（migration_34 改的）。實務上有些支出明確屬於某一間房
-- （例如「14B5 冷氣濾網更換」），只記到物業會失去這層資訊。
--
-- 做法是「物業必填、房源選填」：
--   物業  → 報表分類的主軸，一定要有
--   房源  → 知道就填，之後要追單一房間的花費才有依據
--
-- expenses.property_id 這個欄位早就存在（migration_34 保留沒刪），
-- 只是不再由 CHECK 約束要求。這裡把它重新啟用為選填欄位。

comment on column public.expenses.property_id is '選填。用途的細分：屬於哪一間房。物業層級看 estate_id。';
comment on column public.purchase_request_items.property_id is '選填。用途的細分：屬於哪一間房。物業層級看 estate_id。';


-- ============================================================
-- 現有的 CHECK 只管 estate_id，房源是選填不受限制 —— 確認一下
-- ============================================================
select conname, pg_get_constraintdef(oid)
from pg_constraint
where conrelid in ('public.expenses'::regclass, 'public.purchase_request_items'::regclass)
  and contype = 'c'
order by conrelid::text, conname;


-- ============================================================
-- 房源必須屬於所選物業，否則報表會出現「時兆的支出掛在正隆房間下」
-- ============================================================
alter table public.expenses drop constraint if exists exp_room_in_estate;
alter table public.expenses add constraint exp_room_in_estate check (
  property_id is null or estate_id is not null
);


-- ============================================================
-- 驗證：既有資料有沒有違反新約束的
-- ============================================================
select count(*) as 房源有值但物業空白_應為0
from public.expenses
where property_id is not null and estate_id is null;
