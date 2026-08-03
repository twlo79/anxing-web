-- migration_46：調整會計科目
--
--   差旅交通 → 拆成「差旅」與「交通」
--   新增「交際費」「員工福利」
--
-- ⚠️ 既有支出用的是 code 不是名稱，所以只改名不會動到任何已記錄的支出。
--    現有掛在 transport 上的支出，改名後會顯示成「交通」——
--    若其中有實際上是差旅的，要手動改到新的 travel。下面有查詢可以列出來。

-- ============================================================
-- 步驟 0：先看目前有哪些支出掛在「差旅交通」上（唯讀）
--         有資料的話，改名後要人工判斷哪些該歸到「差旅」。
-- ============================================================
select e.id, e.spent_on, e.item_name, e.amount, e.note
from expenses e
where e.account_code = 'transport'
order by e.spent_on desc;


-- ============================================================
-- 步驟 1：把 transport 改名為「交通」
--         保留 code 不變，既有支出的歸屬不受影響。
-- ============================================================
update account_codes set name = '交通' where code = 'transport';


-- ============================================================
-- 步驟 2：新增三個科目
--         sort 沿用現有間距，插在交通後面。
-- ============================================================
insert into account_codes (code, name, sort, active) values
  ('travel',    '差旅',   (select sort from account_codes where code = 'transport') + 1, true),
  ('entertain', '交際費', (select sort from account_codes where code = 'transport') + 2, true),
  ('welfare',   '員工福利', (select sort from account_codes where code = 'transport') + 3, true)
on conflict (code) do update set name = excluded.name, active = true;


-- ============================================================
-- 步驟 3：把後面的科目往後推，避免 sort 撞在一起
--         （廣告行銷之後的科目原本緊接著交通）
-- ============================================================
update account_codes
set sort = sort + 3
where sort > (select sort from account_codes where code = 'transport')
  and code not in ('travel', 'entertain', 'welfare');


-- ============================================================
-- 步驟 4：驗證
-- ============================================================
select code, name, sort, active from account_codes order by sort, code;
