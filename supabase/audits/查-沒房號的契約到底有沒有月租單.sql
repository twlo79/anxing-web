-- ============================================================
-- 唯讀。那 28 張「沒填房號」的契約，到底有沒有月租單。
--
-- ============================================================
-- 【★★★ 為什麼要這一支 —— 我上一支的判定自相矛盾】
--
-- 上一支（查-哪些契約沒進現金流.sql）把它們判成
-- 「❌ 1. 沒填房號 —— 一張月租單都不會產生」，
-- 而**同一列的「未收合計」是 148,526**。
--
-- 一張月租單都沒有的話，未收不可能是 148,526。
-- 我照 `gen_contract_orders()` 的**程式碼**寫判定，卻沒有拿
-- 同一列的**資料**回頭檢查 —— 兩個數字在同一行互相打臉而我沒看見。
--
-- ★ 而且使用者的畫面上「予春覓覓洋行」明明顯示「本月未收」，
--   那代表本月**確實有一張月租單**。
--
-- 判定要照資料算，不是照我讀程式碼的理解算。
--
-- ============================================================
-- 【要分清楚的三種「沒房號」】
--
--   room is null        `gen_contract_orders` 第一行就 return
--   room = ''（空字串）  **不會 return** —— null 檢查過得去，
--                       然後 order_key 變成 'LT__YYYYMM'，
--                       所有空字串的契約**撞同一個鍵**
--   room = '　'（全形空白等）同上，但鍵長得不一樣
--
-- 這三種在畫面上都是空的，行為完全不同。
-- ============================================================

select coalesce(es.name, '（沒掛物業）')                as 物業,
       ct.tenant_name                                as 租戶,
       ct.type                                       as 類別,

       -- ★★★ 把三種「空」分開。畫面上長得一樣，行為不一樣
       case when ct.room is null      then 'NULL'
            when ct.room = ''         then '空字串'
            when btrim(ct.room) = ''  then '只有空白字元'
            else '「' || ct.room || '」' end          as 房號實際內容,

       ct.start_date                                 as 租期起,
       ct.end_date                                   as 租期迄,
       ct.monthly_rent                               as 對應月租,
       ct.amount_per_period                          as 每期租金,
       ct.pay_day                                    as 幾號繳,

       -- ── 實際有幾張月租單 ────────────────────────────────
       (select count(*) from public.orders o
         where o.contract_id = ct.id
           and o.source in ('longterm','company','office'))          as 月租單數,
       (select count(*) from public.orders o
         where o.contract_id = ct.id
           and o.source in ('longterm','company','office')
           and not o.paid)                                            as 未收筆數,
       (select coalesce(sum(o.amount), 0) from public.orders o
         where o.contract_id = ct.id
           and o.source in ('longterm','company','office')
           and not o.paid)                                            as 未收金額,

       -- ★★ 鍵長什麼樣子。撞鍵的話這裡會看到好幾張契約共用同一個字串
       (select string_agg(distinct o.order_key, '、')
          from public.orders o
         where o.contract_id = ct.id
           and o.source in ('longterm','company','office')
         limit 1)                                                    as 訂單鍵範例,

       -- ★ 是不是契約產生的。'contract' 以外的是手動建或匯入的
       (select string_agg(distinct coalesce(o.imported_via, '（空）'), '、')
          from public.orders o
         where o.contract_id = ct.id
           and o.source in ('longterm','company','office'))           as 訂單怎麼來的,

       -- ── 照資料判定，不照我對程式碼的理解 ──────────────────
       case when (select count(*) from public.orders o
                   where o.contract_id = ct.id
                     and o.source in ('longterm','company','office')) = 0
            then '❌ 真的一張都沒有'
            else '✅ 有月租單 —— 上一支判錯了' end                      as 判定

  from public.contracts ct
  left join public.estates es on es.id = ct.estate_id
 where ct.active
   and (ct.end_date is null or ct.end_date >= current_date)
   and (ct.room is null or btrim(ct.room) = '')
 order by 判定, 未收金額 desc, ct.tenant_name;
