-- ============================================================
-- 唯讀。202608 有哪幾份工**沒有**變成支出，各是什麼原因。
--
-- 【為什麼要這支】
-- 使用者:「有的沒進去」。排班表上看得到「Una 台視公區」「庭玉 復興」
-- 「劉姐 18B5」「Una 退房清潔」，但支出頁只有時兆那一批 $730。
--
-- ★★★ 產生預覽底下那句「N 份工算不出錢」只講了**兩種**原因
--   （沒有房源、沒設單價）。實際上一份工掉出去的路有五條，
--   而其他三條**畫面上完全不會提**:
--
--     1. 房務代碼是空的                → 預覽有講
--     2. 代碼對不到 hk_property        → 預覽沒講（顯示成「未識別房源」在例外清單）
--     3. 對到了但沒指向 ERP 房源       → 預覽沒講
--     4. 有 ERP 房源但沒設 clean_price → 預覽有講
--     5. 執行的人不是按間數計酬        → **預覽完全沒講**
--
-- ★★ 第 5 條最危險:劉姐是時薪制（`count_mode = 'hours'`），
--   她掃的那幾間**從來不會產生清潔費**，而排班表上看起來跟別人一樣。
--   這一支會把她的工單獨列出來讓人決定。
--
-- 【怎麼跑】整份貼進 SQL Editor。第一張是分類統計，第二張是逐筆。
-- ============================================================

-- ── 0. 母體 ──────────────────────────────────────────────────
-- ★ 先確認有東西可查。母體是 0 的話下面兩張表都會是空的，
--   而空表看起來跟「全部都正常」一模一樣（2026-09-03 才踩過）。
select '202608 的工單總數' as 檢查,
       count(*)::text     as 結果,
       case when count(*) = 0
            then '⚠ 這個月沒有工單 —— 下面兩張表不算數'
            else '✅ 有母體' end as 判定
  from public.hk_work_item where period = '202608';


-- ── 1. 分類統計 ──────────────────────────────────────────────
with j as (
  select w.id, w.work_date, w.work_type, w.property_code,
         s.name  as staff_name,
         s.count_mode,
         hp.id   as hk_prop_id,
         hp.property_id,
         p.name  as erp_name,
         p.clean_price
    from public.hk_work_item w
    left join public.hk_staff    s  on s.id = w.staff_id
    left join public.hk_property hp on hp.code = w.property_code
    left join public.properties  p  on p.id = hp.property_id
   where w.period = '202608'
),
cls as (
  select *,
         case
           when count_mode is distinct from 'rooms'
             then '5. 執行的人不是按間數計酬（時薪／不計）'
           when property_code is null or btrim(property_code) = ''
             then '1. 房務代碼是空的'
           when hk_prop_id is null
             then '2. 代碼對不到房務主檔'
           when property_id is null
             then '3. 對到房務主檔，但沒指向 ERP 房源'
           when clean_price is null
             then '4. 有 ERP 房源，但沒設清潔費'
           else '✅ 應該會產生支出'
         end as 原因
    from j
)
select 原因,
       count(*)                              as 份工,
       count(distinct property_code)          as 幾種代碼,
       string_agg(distinct coalesce(property_code, '（空的）'), '、'
                  order by coalesce(property_code, '（空的）')) as 有哪些代碼
  from cls
 group by 原因
 order by 原因;


-- ── 2. 逐筆（只列沒進去的） ──────────────────────────────────
-- ★ 逐筆是拿來**做決定**的:哪幾間要補價、哪幾個代碼要對應、
--   劉姐那幾份要不要算錢。聚合看不出「這一筆其實是打錯字」。
with j as (
  select w.work_date, w.work_type, w.property_code, w.note,
         s.name as staff_name, s.count_mode,
         hp.id as hk_prop_id, hp.property_id,
         p.name as erp_name, p.clean_price
    from public.hk_work_item w
    left join public.hk_staff    s  on s.id = w.staff_id
    left join public.hk_property hp on hp.code = w.property_code
    left join public.properties  p  on p.id = hp.property_id
   where w.period = '202608'
)
select work_date          as 日期,
       staff_name         as 人員,
       property_code      as 房務代碼,
       coalesce(erp_name, '—') as ERP房源,
       work_type          as 工作類型,
       case
         when count_mode is distinct from 'rooms' then '人不按間數計酬（' || coalesce(count_mode, 'null') || '）'
         when property_code is null or btrim(property_code) = '' then '沒填房源'
         when hk_prop_id is null   then '代碼對不到房務主檔'
         when property_id is null  then '沒指向 ERP 房源'
         when clean_price is null  then '沒設清潔費'
       end                as 為什麼沒進去,
       note               as 備註
  from j
 where count_mode is distinct from 'rooms'
    or property_code is null or btrim(property_code) = ''
    or hk_prop_id is null
    or property_id is null
    or clean_price is null
 order by 為什麼沒進去, property_code, work_date;


-- ── 3. 缺價的代碼一覽（拿來補設定的） ────────────────────────
-- ★ 一個代碼一列，不是一份工一列 —— 要補的是**設定**不是那幾份工。
-- ★★★ 這裡要用 `w.property_code`（工單上寫的），不是 `hp.code`（主檔的）。
--   對不到主檔時 hp 整列是 null，寫 hp.code 會把**每一個對不到的代碼**
--   都顯示成「（沒填代碼）」—— 而那正是最需要看到名字的一群。
--   「正隆多間」就是這樣被藏起來的（2026-09-03 踩過）。
select coalesce(nullif(btrim(w.property_code), ''), '（真的沒填）') as 房務代碼,
       coalesce(p.name, '—')            as ERP房源,
       case when hp.id is null          then '❌ 代碼不在房務主檔'
            when hp.property_id is null then '❌ 沒對應 ERP 房源（房務管理 → 設定）'
            when p.clean_price is null  then '❌ 沒設清潔費（權限管理 → 清潔計算）'
       end                              as 要補什麼,
       count(*)                         as 這個月幾份工
  from public.hk_work_item w
  left join public.hk_property hp on hp.code = w.property_code
  left join public.properties  p  on p.id = hp.property_id
 where w.period = '202608'
   and (hp.id is null or hp.property_id is null or p.clean_price is null)
 group by 1, 2, 3
 order by count(*) desc;
