-- ============================================================
-- 唯讀。房務支出到底存在不存在？
--
-- 【為什麼要查】
-- migration_210 的自檢第 1 列回 0 —— 房務支出一筆都沒有。
-- 而那讓後面五條檢查**全部自動通過**（分母是空的，什麼都成立）。
--
-- ★★★ 六個綠勾等於沒有檢查到任何東西。
--   這比紅字更危險:紅字會讓人停下來，假綠勾讓人往下走。
--
-- 兩種可能，處理方式完全不同:
--   A. 還沒按過「產生本月支出」 → 沒事，210 只是沒有東西要補
--   B. 產生過了，但 tags 沒寫進去 → 210 漏補了，而且支出頁的
--      「非房務」開關會把它們當成非房務，房務標籤也不會顯示
--
-- 下面五張表分辨這兩種。
-- ============================================================

-- ── 1. 有沒有任何「產生」留下的痕跡 ──────────────────────────
-- ★ 認 hk_job_key / hk_labor_key，**不認 tags** ——
--   正在懷疑的就是 tags，拿它當條件會問到同一個空集合
select '1. 有 hk_job_key 或 hk_labor_key 的支出' as 檢查,
       count(*)                                  as 筆數,
       coalesce(sum(amount), 0)                  as 金額,
       case when count(*) = 0
            then '→ 還沒產生過。210 沒有東西要補是正常的'
            else '→ 產生過了。往下看第 2 張表'
       end                                       as 意思
  from public.expenses
 where hk_job_key is not null or hk_labor_key is not null;

-- ── 2. 這些支出的 tags 長什麼樣 ──────────────────────────────
select '2. 產生出來的支出，tags 是什麼' as 檢查,
       coalesce(tags::text, '（null）')  as tags,
       count(*)                         as 筆數
  from public.expenses
 where hk_job_key is not null or hk_labor_key is not null
 group by tags
 order by count(*) desc;

-- ── 3. estate_id 補到了沒 ────────────────────────────────────
select '3. 產生出來的支出，物業填了沒' as 檢查,
       case when estate_id is null then '❌ 沒有物業' else '✅ 有物業' end as 物業,
       case when property_id is null then '（沒有房源・人事費整個物業）' else '有房源' end as 房源,
       count(*) as 筆數
  from public.expenses
 where hk_job_key is not null or hk_labor_key is not null
 group by 2, 3
 order by 4 desc;

-- ── 4. 會計科目對不對 ────────────────────────────────────────
select '4. 會計科目' as 檢查,
       coalesce(account_code, '（空的）') as 科目代碼,
       count(*) as 筆數
  from public.expenses
 where hk_job_key is not null or hk_labor_key is not null
 group by account_code;

-- ── 5. 前十筆長什麼樣 ────────────────────────────────────────
-- ★ 眼睛看一次。上面四張都是聚合，聚合看不出「這一筆的名字很怪」
select spent_on          as 支出日,
       item_name         as 項目,
       amount            as 金額,
       tags              as 標籤,
       estate_id is not null as 有物業,
       property_id is not null as 有房源,
       coalesce(hk_job_key, hk_labor_key) as key
  from public.expenses
 where hk_job_key is not null or hk_labor_key is not null
 order by spent_on desc, item_name
 limit 10;
