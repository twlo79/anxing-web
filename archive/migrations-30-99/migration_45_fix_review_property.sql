-- migration_45：用訂單校正評價的房源歸屬
--
-- 問題：開封 2F / 3F / 4F / 整棟 在 Airbnb 用了完全相同的標題
--       「Modern Minimalist German Design/5 Minutes to Ximen」。
--       抓取端沒帶 listingId 時，匯入程式退回第二層的名稱比對，
--       而那個名稱四個單位共用 —— 於是全部被歸到同一間（開封3F）。
--
-- 解法：訂單知道房客實際住哪一間。評價有房客與退房日，訂單也有，
--       用這兩個欄位把評價接回訂單，取訂單的 property_id 為準。
--
-- 為什麼可信：
--   ‧ 訂單的房源來自 Airbnb 訂單匯入（以 code → order_key 對應），
--     跟評價走的是不同管道，不會一起錯
--   ‧ 同名房客在同一天退房於不同單位，機率極低；下面的 n = 1 條件會擋掉
--
-- 這支可以重複執行。資料已對齊時再跑一次不會有任何變動。

-- ============================================================
-- 步驟 0：預覽全部會被修改的評價（唯讀）
--         先看清楚再跑步驟 1。
-- ============================================================
with uniq as (
  select r.airbnb_review_id,
         min(o.property_id::text)::uuid   as correct_id,
         count(distinct o.property_id)    as n
  from reviews r
  join orders o
    on o.guest_name = r.guest_name
   and o.checkout   = r.checkout_date
   and o.property_id is not null
  where r.checkout_date is not null and r.guest_name is not null
  group by r.airbnb_review_id
)
select r.airbnb_review_id, r.guest_name, r.checkin_date, r.checkout_date,
       r.listing_name_raw,
       pOld.name as 目前記的,
       pNew.name as 訂單實際的
from reviews r
join uniq u on u.airbnb_review_id = r.airbnb_review_id and u.n = 1
left join properties pOld on pOld.id = r.property_id
left join properties pNew on pNew.id = u.correct_id
where r.property_id is distinct from u.correct_id
order by r.checkout_date desc;


-- ============================================================
-- 步驟 1：校正
--
--   n = 1                              只在能唯一對到一間房源時才動
--   property_id is distinct from ...    已經正確的不重寫，避免無謂的異動
-- ============================================================
with uniq as (
  select r.airbnb_review_id,
         min(o.property_id::text)::uuid   as correct_id,
         count(distinct o.property_id)    as n
  from reviews r
  join orders o
    on o.guest_name = r.guest_name
   and o.checkout   = r.checkout_date
   and o.property_id is not null
  where r.checkout_date is not null and r.guest_name is not null
  group by r.airbnb_review_id
)
update reviews r
set property_id = u.correct_id
from uniq u
where u.airbnb_review_id = r.airbnb_review_id
  and u.n = 1
  and r.property_id is distinct from u.correct_id;


-- ============================================================
-- 步驟 2：驗證 —— 再跑一次步驟 0 的查詢，應回傳 0 列
-- ============================================================
with uniq as (
  select r.airbnb_review_id,
         min(o.property_id::text)::uuid   as correct_id,
         count(distinct o.property_id)    as n
  from reviews r
  join orders o
    on o.guest_name = r.guest_name
   and o.checkout   = r.checkout_date
   and o.property_id is not null
  where r.checkout_date is not null and r.guest_name is not null
  group by r.airbnb_review_id
)
select count(*) as 仍不一致_應為0
from reviews r
join uniq u on u.airbnb_review_id = r.airbnb_review_id and u.n = 1
where r.property_id is distinct from u.correct_id;


-- ============================================================
-- 步驟 3：檢查還有哪些評價的名稱是「多個房源共用」的
--         這些是未來還會出錯的高風險名稱。
-- ============================================================
select listing_name_raw,
       count(distinct property_id) as 對到幾個房源,
       string_agg(distinct (select name from properties where id = r.property_id), ' / ') as 房源
from reviews r
where property_id is not null and listing_name_raw is not null
group by listing_name_raw
having count(distinct property_id) > 1
order by 2 desc;
