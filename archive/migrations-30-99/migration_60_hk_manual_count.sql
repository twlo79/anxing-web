-- migration_60：間數可手動覆寫
--
-- 原本間數一律由房源格推導，不給改（附錄 A A0 的預設）。
-- 實務上有些工作不值得為了記數字去建一個房源格 —— 但那個人確實做了事，
-- 月底的間數要算進去。
--
-- 做法是「另存不覆蓋」：
--   rooms_override 有值 → 畫面顯示它，並標成手動、附上自動值
--   rooms_override 為 null → 用房源格自動算的
--
-- 關鍵是**不覆寫自動值**。兩個數字並存，隨時看得出差異、隨時可以還原。
-- 直接改掉自動值的話，月底發現數字不對就查不出是哪裡多出來的。
--
-- 注意：手動覆寫只影響「間數」，不影響打掃次數與床單。
-- 布巾要靠房源才算得出來，沒有房源格就沒有布巾 —— 這是刻意的。

alter table public.hk_day
  add column if not exists rooms_override int;

comment on column public.hk_day.rooms_override is
  '手動覆寫的間數。null = 採用房源格自動算的值。只影響個人工作量，不影響布巾統計。';


-- ============================================================
-- 驗證
-- ============================================================
select count(*) filter (where rooms_override is not null) as 已手動覆寫,
       count(*) as 總筆數
from public.hk_day;
