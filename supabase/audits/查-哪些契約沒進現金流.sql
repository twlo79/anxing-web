-- ============================================================
-- 唯讀。哪些生效中的契約**沒有**出現在現金流表裡，各是什麼原因。
--
-- ★ 單獨一支 —— SQL Editor 只顯示最後一個 select。
--
-- ============================================================
-- 【應收款是怎麼算出來的 —— 兩段，來源不同】
--
--   ① 金額   資料庫算的。`gen_contract_orders()` 觸發器在契約存檔時
--            **每個日曆月產生一張月租單**，金額 = `contracts.monthly_rent`。
--            現金流表讀的是那些 `orders`，不是契約本身。
--
--   ② 應繳日 **資料庫裡沒有這一欄** —— 是稽核 SQL 現算的，
--            照 `src/lib/due-date.ts`：
--                第 i 期應繳日 =（該期第一個月 − 1 個月）的 pay_day 號
--            pay_day 沒設就取 `first_payment_date` 的日數。
--
-- 所以一張契約要出現在現金流表裡，**兩段都要成立**。
--
-- ============================================================
-- 【★★★ gen_contract_orders 開頭就 return 的四種契約】
--
-- 那個函式（schema-baseline.sql:774）在這四種情況下**一張月租單都不產生**：
--
--     1. `room` 是空的
--     2. `start_date` 或 `end_date` 是空的
--     3. `active` 是 false
--     4. `monthly_rent` 是 null 或 <= 0
--
-- ★★ 第 4 種最危險：年繳契約如果只填了「每期租金」（`amount_per_period`）
--   而沒填「對應月租」（`monthly_rent`），**整張契約的錢完全不存在** ——
--   不是「算不出應繳日」，是連訂單都沒有。它不會出現在任何一份報表上，
--   包括「算不出應繳日」那一類。**少掉的東西不會叫。**
--
-- ★ 另外 `order_key` 是 `LT_{房號}_{YYYYMM}` —— 用**房號**當鍵。
--   同一個房號的新舊兩張契約會撞鍵，後建的那張會蓋掉前一張的未收月租單。
--
-- 【怎麼跑】整份貼進 SQL Editor。
-- ============================================================

with c as (
  select ct.id, ct.room, ct.display_name, ct.tenant_name, ct.cadence,
         ct.start_date, ct.end_date, ct.active,
         ct.monthly_rent, ct.amount_per_period,
         ct.pay_day, ct.first_payment_date,
         coalesce(es.name, '（沒掛物業）') as estate,
         (select count(*) from public.orders o
           where o.contract_id = ct.id
             and o.source in ('longterm','company','office'))              as 月租單數,
         (select coalesce(sum(o.amount), 0) from public.orders o
           where o.contract_id = ct.id
             and o.source in ('longterm','company','office')
             and not o.paid)                                               as 未收金額
    from public.contracts ct
    left join public.estates es on es.id = ct.estate_id
   where ct.active
     and (ct.end_date is null or ct.end_date >= current_date)
),
cls as (
  select c.*,
         case
           -- ── 完全沒有月租單（gen_contract_orders 開頭就 return）──
           when c.room is null or btrim(c.room) = ''
             then '❌ 1. 沒填房號 —— 一張月租單都不會產生'
           when c.start_date is null or c.end_date is null
             then '❌ 2. 租期沒填完整 —— 一張月租單都不會產生'
           when c.monthly_rent is null or c.monthly_rent <= 0
             then '❌ 3. 沒填「對應月租」—— 一張月租單都不會產生'
           when c.月租單數 = 0
             then '❌ 4. 條件都符合但就是沒有月租單 —— 觸發器可能沒跑過'
           -- ── 有月租單，但排不進月份 ──
           when coalesce(case when c.pay_day between 1 and 31 then c.pay_day end,
                         extract(day from c.first_payment_date)::int) is null
             then '⚠ 5. 有月租單，但沒填「幾號繳」也沒首繳日 —— 算不出應繳日'
           else '✅ 有進現金流表'
         end as 判定
    from c
)
select 判定,
       count(*)                          as 幾張契約,
       sum(未收金額)                      as 未收合計,
       -- ★ 列出房號。「3 張沒填房號」要人自己去 60 張契約裡找
       left(string_agg(coalesce(nullif(btrim(room), ''), display_name, tenant_name, '（無名）'),
                       '、' order by coalesce(nullif(btrim(room), ''), tenant_name)), 200) as 有哪些,
       -- ★★ 每期租金有填但月租沒填的，把金額印出來 —— 那是最容易漏的一種
       left(string_agg(
              case when (monthly_rent is null or monthly_rent <= 0)
                        and amount_per_period > 0
                   then coalesce(room, tenant_name) || ' 每期 ' || amount_per_period::text
              end, '、'), 200)            as 每期有填但月租沒填
  from cls
 group by 判定
 order by 判定;
