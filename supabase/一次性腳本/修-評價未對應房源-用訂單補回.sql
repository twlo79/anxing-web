-- 修：把對不到房源的評價，用訂單補回去
--
-- ============================================================
-- 【症狀】（2026-08-22）
--
-- 房源評價列表上有幾筆的房源是「未對應」、負責人是空的。
--
-- 負責人不是獨立的欄位，是算出來的:
--
--     房源 → 所屬物業 → 該物業當期的管家 = 負責人
--
-- 第一步斷掉，後面全部跟著空。所以那是**一個原因、兩個症狀**。
--
--
-- ============================================================
-- 【為什麼會對不到】
--
-- 匯入評價時有兩層對應（src/app/api/import/reviews/route.ts）:
--
--   第一層  Airbnb 的 listingId → listing_property_map
--           爬蟲有時候沒給 listingId
--
--   第二層  房客姓名 ＋ 退房日 → 回 orders 查 property_id
--           **訂單還沒匯進來的話，這層當然查不到**
--
-- 而匯入是一次性的 —— 訂單後來補上了，評價不會回頭再看一次。
--
-- 實例:Max，7/21 入住、8/20 退房。評價匯入時訂單還沒進來，
-- 現在訂單在了，`property_id` 卻還是 null。
--
--
-- ============================================================
-- 【為什麼不用名稱猜】
--
-- 匯入程式的註解寫得很清楚，這裡照抄一次免得下次有人想「優化」:
--
--   開封 2F/3F/4F/整棟 在 Airbnb 用了**完全相同的標題**，
--   全站有 23 個名稱被多間房源共用。名稱在結構上就分不出是哪一間，
--   猜了必錯，而且自學機制會把第一次的錯誤固化下來、往後一路套用。
--
-- 所以這支只走訂單，而且**只採計唯一解**。
--
--   「對不上的不猜。少填一個看得到、補得回來;填錯一個沒有人會發現。」
--
-- 同名房客在同一天退房於不同單位 → 跳過，留給人工。
--
--
-- ============================================================
-- 【比對規則】
--
--   退房日   完全相同（date = date）
--   房客     去掉前後空白之後**完全相同、不分大小寫**
--
-- ★ 不用 ilike '%name%'。「Max」會吃到「Maxine」「Maximilian」——
--   而那種錯配一旦寫進去，畫面上看起來完全正常，
--   只有那間房的評價數字悄悄多一筆。
-- ============================================================


-- ── 補回 ＋ 報告（一句話做完）─────────────────────
/*
 * ★ 為什麼 update 與報告寫在同一句。
 *
 *   reviews **沒有 updated_at 欄位**（只有 created_at），
 *   所以事後查不出「哪幾筆是剛剛補的」。
 *   用 returning 把改到的列直接帶出來，是唯一問得到的方式。
 *
 * ★ 而且 SQL Editor 只顯示最後一個 SELECT 的結果 ——
 *   拆成兩句的話，前面那句的輸出永遠看不到。
 */
with unmatched as (
  select id, guest_name, checkout_date
    from public.reviews
   where property_id is null
     and checkout_date is not null
     and guest_name is not null
),
/*
 * 每一筆未對應的評價，對得到幾間**不同的**房源。
 *
 * count(distinct property_id) 而不是 count(*) ——
 * 同一間房拆成兩筆訂單（例如續住）也是唯一解，不該被跳過。
 */
cand as (
  select u.id,
         count(distinct o.property_id)          as n,
         (array_agg(distinct o.property_id))[1] as property_id
    from unmatched u
    join public.orders o
      on o.checkout = u.checkout_date
     and o.property_id is not null
     and lower(btrim(o.guest_name)) = lower(btrim(u.guest_name))
   group by u.id
),
fixed as (
  update public.reviews r
     set property_id = c.property_id
    from cand c
   where r.id = c.id
     and c.n = 1                 -- ★ 只有唯一解才寫。多解一律跳過。
     and r.property_id is null   -- ★ 再擋一次:絕不覆蓋已經對好的
  returning r.id, r.guest_name, r.checkout_date, r.listing_name_raw, r.property_id
)
select "狀態", "旅客", "退房日", "Airbnb 標題" from (

  -- 補回來的
  select 1 as ord, '✅ 已補回 ' || p.name as "狀態",
         coalesce(f.guest_name, '（無名）') as "旅客",
         f.checkout_date as "退房日",
         left(coalesce(f.listing_name_raw, ''), 26) as "Airbnb 標題"
    from fixed f
    left join public.properties p on p.id = f.property_id

  union all

  /*
   * 還是對不到的。
   *
   * 資料異動的 CTE 看到的是**更新前的快照**，所以剛補回來的那幾筆
   * 在這裡還會是 null —— 要用 id 排掉，不然同一筆會出現兩次。
   */
  select 2,
         case when x.n is null or x.n = 0
              then '❌ 訂單裡查不到這個房客'
              else '⚠ 對到 ' || x.n || ' 間，不猜（要人工指定）' end,
         coalesce(r.guest_name, '（無名）'),
         r.checkout_date,
         left(coalesce(r.listing_name_raw, ''), 26)
    from public.reviews r
    left join lateral (
      select count(distinct o.property_id) as n
        from public.orders o
       where o.checkout = r.checkout_date
         and o.property_id is not null
         and lower(btrim(o.guest_name)) = lower(btrim(r.guest_name))
    ) x on true
   where r.property_id is null
     and r.id not in (select id from fixed)

) v order by ord, "退房日" desc nulls last
limit 60;


-- ============================================================
-- 反悔的話
-- ============================================================
/*
 * 這支只寫 property_id，沒有動別的欄位。
 * 覺得某一筆對錯了，把它清回 null 就是原狀:
 *
 *   update public.reviews set property_id = null where id = '<那筆的 id>';
 *
 * ⚠ 不要整批清 —— 那會連本來就對好的一起清掉。
 */
