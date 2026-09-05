-- ============================================================
-- 唯讀。「短租住宿」那一欄是哪些來源湊出來的，各佔多少。
--
-- ★ 現金流表的「短租住宿」= `orders` 裡
--     source in ('airbnb','agoda','private','partner')
--     且 paid = false（**只算還沒收的**）
--     依 checkin 分月
--
--   所以它**不只是 Airbnb**，還有 Agoda、私下、搭檔收款。
--
-- ★★ 已經收過的訂單不在裡面 —— 那是已經進帳的錢，不是未來的現金流。
--   所以這一欄的數字會比「這個月的短租營收」小很多。
--
-- ★★★ `partner`（搭檔收款）要特別看:那是**搭檔先收的錢**，
--   什麼時候、用什麼方式進到安幸的戶頭，跟平台撥款不是同一條路。
--   混在同一欄裡看不出來。
-- ============================================================

select to_char(date_trunc('month', o.checkin), 'YYYY/MM')  as 月份,

       sum(case when o.source = 'airbnb'  then o.amount else 0 end) as Airbnb,
       sum(case when o.source = 'agoda'   then o.amount else 0 end) as Agoda,
       sum(case when o.source = 'private' then o.amount else 0 end) as 私下,
       sum(case when o.source = 'partner' then o.amount else 0 end) as 搭檔收款,
       sum(o.amount)                                                as 合計,

       count(*)                                                     as 幾筆,
       -- ★ 佔比放最後。先看金額
       round(100.0 * sum(case when o.source = 'airbnb' then o.amount else 0 end)
             / nullif(sum(o.amount), 0), 1)                         as Airbnb佔比

  from public.orders o
 where not o.paid
   and o.source in ('airbnb','agoda','private','partner')
   and o.checkin >= date_trunc('month', current_date)
   and o.checkin <  date_trunc('month', current_date) + interval '12 months'
 group by date_trunc('month', o.checkin)

union all

-- ★★ 合計列。分月看不出「整整一年 Airbnb 佔幾成」
select '＝ 12 個月合計',
       sum(case when o.source = 'airbnb'  then o.amount else 0 end),
       sum(case when o.source = 'agoda'   then o.amount else 0 end),
       sum(case when o.source = 'private' then o.amount else 0 end),
       sum(case when o.source = 'partner' then o.amount else 0 end),
       sum(o.amount),
       count(*),
       round(100.0 * sum(case when o.source = 'airbnb' then o.amount else 0 end)
             / nullif(sum(o.amount), 0), 1)
  from public.orders o
 where not o.paid
   and o.source in ('airbnb','agoda','private','partner')
   and o.checkin >= date_trunc('month', current_date)
   and o.checkin <  date_trunc('month', current_date) + interval '12 months'

order by 1;
