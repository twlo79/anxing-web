/*
 * 查：其他收支帳「新增收入」存不進去
 *   new row for relation "orders" violates check constraint "ord_stay_nights_chk"
 *
 * 2026-09-22。**只讀，不改任何東西。**
 *
 * 為什麼要先查:那條 CHECK 的定義**不在這個 repo 裡** ——
 * `grep ord_stay_nights_chk` 只找得到 migration_257 檔頭的一句註解
 * （「兩條既有 CHECK 本來就容得下 null」），`schema-baseline.sql` 也沒有。
 * 它是更早以前就存在的約束。
 *
 * ★★★ 憑印象寫既有東西的定義是這個專案踩過的坑（2026-09-03 的
 *   `record_migration` 簽章）。所以這一支先把**真正的定義**印出來，
 *   看過了再決定怎麼修。
 *
 * 前端現在寫進去的是（otherbooks/page.tsx saveIncome）:
 *   source='other_biz', checkin = checkout = 那一天, nights = 0
 */

-- ① orders 上所有的 CHECK 約束（真正的定義，不是我記得的）
select
  1                                   as 序,
  con.conname::text                   as 約束名稱,
  pg_get_constraintdef(con.oid)       as 定義
from pg_constraint con
join pg_class c on c.oid = con.conrelid
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname = 'orders' and con.contype = 'c'
order by con.conname;

-- ② 那筆資料到底違反哪一條 —— 把前端要寫的值代進每一條算一次
--    （純運算，不 insert）
with v as (
  select date '2026-07-31' as checkin, date '2026-07-31' as checkout, 0::int as nights
)
select
  2                                                        as 序,
  '前端要寫的值'                                            as 項目,
  v.checkin::text || ' ~ ' || v.checkout::text
    || '　nights=' || v.nights                             as 值,
  (v.checkout - v.checkin)                                 as 日期相差天數,
  case when v.nights = (v.checkout - v.checkin)
       then '✅ nights 跟日期是對得上的'
       else '❌ nights 跟日期對不上' end                    as 判定
from v;

-- ③ 這張表已經有幾筆 other_biz 的收入？
--    ★ 0 筆 = 這個功能從上線到現在一次都沒成功過（不是最近才壞的）
select
  3                                                                  as 序,
  count(*)                                                           as other_biz筆數,
  count(*) filter (where checkin = checkout)                         as 同一天的,
  count(*) filter (where coalesce(nights, -1) = 0)                   as nights為0的,
  min(created_at)::date                                              as 最早一筆,
  max(created_at)::date                                              as 最晚一筆,
  case when count(*) = 0
       then '⚠ 一筆都沒有 —— 這個功能從來沒成功過，下面那一列不算數'
       else '有資料，往下看它們長什麼樣' end                          as 判定
from public.orders
where source = 'other_biz';

-- ④ 已經存在的訂單裡，nights 與日期的關係有哪幾種合法形狀
--    ★ 先問「這一欄有幾種合法的樣子」再決定怎麼改（2026-09-01 的坑）
--    ★★ `序` 是常數，所以分組要在子查詢裡做 —— 外層 `group by 1`
--       指到的是那個常數，不是 `形狀`（2026-09-22 第一版就是這樣錯的）
select 4 as 序, t.形狀, t.筆數, t.來源, t.日期範圍
from (
  select
    case
      when checkin is null or checkout is null then 'a. 沒有日期（訂金單）'
      when nights is null                      then 'b. 有日期但 nights 是 null'
      when nights = 0                          then 'c. nights = 0'
      when nights = (checkout - checkin)       then 'd. nights = 日期相差'
      else                                          'e. nights 跟日期對不上'
    end                                                      as 形狀,
    count(*)                                                 as 筆數,
    string_agg(distinct source, '、' order by source)         as 來源,
    coalesce(min(checkin)::text, '—') || ' ~ '
      || coalesce(max(checkout)::text, '—')                  as 日期範圍
  from public.orders
  group by 1
) t
order by t.形狀;

-- ⑤ 同一天的訂單存不存在（存在的話代表 ord_dates_chk 容得下 checkin = checkout）
select
  5                                                                  as 序,
  count(*)                                                           as 同一天進出的訂單,
  coalesce(string_agg(distinct source, '、'), '（沒有）')              as 來源,
  coalesce(min(nights)::text, '—') || ' ~ ' || coalesce(max(nights)::text, '—') as nights範圍,
  case when count(*) = 0
       then '⚠ 一筆都沒有 —— 表示目前沒有任何「同一天」的訂單進得去'
       else '✅ 同一天是進得去的，卡住的只有 nights' end               as 判定
from public.orders
where checkin is not null and checkin = checkout;
