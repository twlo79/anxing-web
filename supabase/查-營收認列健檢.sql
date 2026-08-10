-- 營收認列健檢
--
-- ============================================================
-- 【怎麼用】
--
-- 整份貼進 Supabase SQL Editor 執行。**只讀，不改任何資料。**
-- 最後一段是總表：**每一欄都是 0 就代表全部正確**，不是 0 才往上看明細。
--
-- 建議每月結帳前跑一次。
--
--
-- ============================================================
-- 【為什麼要用 SQL 而不是對匯出的 Excel】
--
-- 2026-08 用匯出的 Excel 對過一次，出現 5 筆差 ±1 元。
-- 那不是錯 —— Airbnb 的訂單金額有小數（49,526.64），
-- 匯出檔的「訂單總額」欄四捨五入成整數，拿整數回推當然對不回
-- 用小數算出來的結果。
--
-- 直接查資料庫沒有那層雜訊，差多少就是真的差多少。
--
--
-- ============================================================
-- 【驗的是什麼規則】
--
--   1. 每筆訂單的認列總和 = 訂單金額        ← 最強的一條，錯什麼都會被它抓到
--   2. 跨月按天數分攤，最後一期補餘額
--   3. 認列區間 = 訂單期間 ∩ 該月
--   4. 一筆訂單一個月只有一列
--   5. 有訂單卻沒有認列（漏產）
--   6. 有認列卻找不到訂單（孤兒）
--   7. 一次性收入整筆記在當月，不跨月
--
-- 規則出處：gen_recognitions()，見 migration_53 / 75 / 76。


-- ============================================================
-- 【要檢查哪段期間】—— 改這裡
--
-- 預設近 13 個月。要全查就把 where 那行註解掉（資料多會跑比較久）。
-- ============================================================

drop table if exists _chk_scope;
create temp table _chk_scope as
select o.*
from public.orders o
where o.checkout >= (current_date - interval '13 months')::date;   -- ← 改這裡


-- ============================================================
-- 1. 【最重要】每筆訂單的認列總和 = 訂單金額
--
-- 這一條涵蓋面最廣：分攤算錯、少產一個月、多產一個月、
-- 訂單改了金額但認列沒重算 —— 全部都會在這裡露出來。
-- ============================================================

select
  o.order_key                                   as 訂單鍵,
  o.source                                      as 來源,
  o.property_raw                                as 房源,
  o.guest_name                                  as 客戶,
  o.checkin                                     as 入住,
  o.checkout                                    as 退房,
  o.amount                                      as 訂單金額,
  coalesce(sum(r.month_amount), 0)              as 認列總和,
  o.amount - coalesce(sum(r.month_amount), 0)   as 差額,
  count(r.id)                                   as 認列列數
from _chk_scope o
left join public.revenue_recognitions r on r.order_id = o.id
where o.amount is not null and o.amount <> 0
group by o.id, o.order_key, o.source, o.property_raw, o.guest_name, o.checkin, o.checkout, o.amount
having abs(o.amount - coalesce(sum(r.month_amount), 0)) > 0.005
order by abs(o.amount - coalesce(sum(r.month_amount), 0)) desc
limit 100;


-- ============================================================
-- 2. 逐月分攤金額是否正確
--
-- 重算一次 gen_recognitions 的算式再比對：
--
--     非最後一期： trunc(金額 × 當月天數 ÷ 總晚數)
--     最後一期：   金額 − 前面各期合計       （餘數全給最後一期，migration_53）
--
-- 「最後一期」= **退房日前一天所在的月份**。
-- 退房 8/1 的訂單最後一期是 7 月不是 8 月 —— 這點很容易搞錯，
-- 用「退房日所在月份」去判斷會讓一堆正確的資料看起來像錯的。
-- ============================================================

with base as (
  select o.id, o.order_key, o.source, o.guest_name, o.amount, o.nights,
         o.checkin, o.checkout,
         date_trunc('month', o.checkout - 1)::date as last_ms,
         gs.ms::date as ms,
         greatest(0, least(o.checkout, (gs.ms + interval '1 month')::date)
                   - greatest(o.checkin, gs.ms::date))::int as n
  from _chk_scope o
  cross join lateral generate_series(
    date_trunc('month', o.checkin), o.checkout - 1, interval '1 month') gs(ms)
  where o.source not in ('oneoff', 'airbnb_cancelled')
    and o.checkin is not null and o.checkout is not null
    and o.nights > 0 and o.amount is not null
),
acc as (
  select *,
    -- 前面各期的 trunc 合計（不含自己）
    coalesce(sum(trunc(amount * n / nights)) over (
      partition by id order by ms rows between unbounded preceding and 1 preceding), 0) as prior
  from base where n > 0
),
expect as (
  select id, order_key, source, guest_name, checkin, checkout, amount, n, ms,
         to_char(ms, 'YYYYMM') as ym,
         case when ms = last_ms then amount - prior
              else trunc(amount * n / nights) end as exp_amt
  from acc
)
select e.order_key as 訂單鍵, e.guest_name as 客戶, e.ym as 月份,
       e.checkin as 入住, e.checkout as 退房, e.amount as 訂單金額,
       e.n as 當月天數, e.exp_amt as 應認列, r.month_amount as 實際認列,
       r.month_amount - e.exp_amt as 差額
from expect e
left join public.revenue_recognitions r on r.order_id = e.id and r.ym = e.ym
where r.id is null or abs(r.month_amount - e.exp_amt) > 0.005
order by abs(coalesce(r.month_amount, 0) - e.exp_amt) desc
limit 100;


-- ============================================================
-- 3. 認列區間是否等於「訂單期間 ∩ 該月」
-- ============================================================

select r.ym as 月份, o.order_key as 訂單鍵, o.guest_name as 客戶,
       o.checkin as 入住, o.checkout as 退房,
       r.period_start as 認列起, r.period_end as 認列迄,
       greatest(o.checkin, to_date(r.ym, 'YYYYMM'))                       as 應為起,
       least(o.checkout, (to_date(r.ym, 'YYYYMM') + interval '1 month')::date) as 應為迄,
       r.month_nights as 記錄天數,
       (least(o.checkout, (to_date(r.ym, 'YYYYMM') + interval '1 month')::date)
        - greatest(o.checkin, to_date(r.ym, 'YYYYMM')))::int              as 應為天數
from public.revenue_recognitions r
join _chk_scope o on o.id = r.order_id
where o.source not in ('oneoff', 'airbnb_cancelled')
  and (r.period_start <> greatest(o.checkin, to_date(r.ym, 'YYYYMM'))
    or r.period_end <> least(o.checkout, (to_date(r.ym, 'YYYYMM') + interval '1 month')::date)
    or r.month_nights <> (least(o.checkout, (to_date(r.ym, 'YYYYMM') + interval '1 month')::date)
                          - greatest(o.checkin, to_date(r.ym, 'YYYYMM')))::int)
limit 100;


-- ============================================================
-- 4. 一筆訂單一個月只有一列
--
-- migration_82 加了唯一索引擋這件事。這裡再驗一次 ——
-- 索引可能被誤刪，而重複認列的症狀是「營收莫名變多」，沒有人查得出來。
-- ============================================================

select r.order_id, o.order_key as 訂單鍵, o.guest_name as 客戶,
       r.ym as 月份, count(*) as 列數,
       sum(r.month_amount) as 這個月合計
from public.revenue_recognitions r
join _chk_scope o on o.id = r.order_id
group by r.order_id, o.order_key, o.guest_name, r.ym
having count(*) > 1
order by count(*) desc
limit 50;


-- ============================================================
-- 5. 有訂單卻沒有任何認列（漏產）
--
-- 排除金額為 0 的：Airbnb 取消單、平台代收未結算的，那些本來就沒有營收。
-- ============================================================

select o.order_key as 訂單鍵, o.source as 來源, o.property_raw as 房源,
       o.guest_name as 客戶, o.checkin as 入住, o.checkout as 退房,
       o.amount as 訂單金額, o.imported_via as 來源方式
from _chk_scope o
where o.amount is not null and o.amount <> 0
  and not exists (select 1 from public.revenue_recognitions r where r.order_id = o.id)
order by o.checkin desc
limit 100;


-- ============================================================
-- 6. 有認列卻找不到訂單（孤兒）
--
-- migration_81 把外鍵改成 CASCADE 並清掉 757 筆孤兒之後理論上不會再有。
-- 這一條是那次事故的哨兵 —— 孤兒認列會讓營收永遠算得出來但對不到來源。
-- ============================================================

select r.ym as 月份, r.source as 來源, r.property_raw as 房源,
       r.guest_name as 客戶, r.month_amount as 認列金額, r.order_id
from public.revenue_recognitions r
where r.order_id is not null
  and not exists (select 1 from public.orders o where o.id = r.order_id)
limit 100;


-- ============================================================
-- 7. 一次性收入：整筆記在 checkin 當月，不跨月
-- ============================================================

select o.order_key as 訂單鍵, o.source as 來源, o.fee_type as 名目,
       o.guest_name as 客戶, o.checkin as 日期, o.amount as 訂單金額,
       count(r.id) as 認列列數,
       sum(r.month_amount) as 認列合計,
       min(r.ym) as 認列月份,
       to_char(o.checkin, 'YYYYMM') as 應為月份
from _chk_scope o
left join public.revenue_recognitions r on r.order_id = o.id
where o.source in ('oneoff', 'airbnb_cancelled') and o.amount <> 0
group by o.id, o.order_key, o.source, o.fee_type, o.guest_name, o.checkin, o.amount
having count(r.id) <> 1
    or abs(coalesce(sum(r.month_amount), 0) - o.amount) > 0.005
    or min(r.ym) <> to_char(o.checkin, 'YYYYMM')
limit 100;


-- ============================================================
-- 【總表】每一欄都是 0 就是全部正確
-- ============================================================

with s1 as (
  select count(*) n from (
    select o.id from _chk_scope o
    left join public.revenue_recognitions r on r.order_id = o.id
    where o.amount is not null and o.amount <> 0
    group by o.id, o.amount
    having abs(o.amount - coalesce(sum(r.month_amount), 0)) > 0.005) x
), s4 as (
  select count(*) n from (
    select r.order_id from public.revenue_recognitions r
    join _chk_scope o on o.id = r.order_id
    group by r.order_id, r.ym having count(*) > 1) x
), s5 as (
  select count(*) n from _chk_scope o
   where o.amount is not null and o.amount <> 0
     and not exists (select 1 from public.revenue_recognitions r where r.order_id = o.id)
), s6 as (
  select count(*) n from public.revenue_recognitions r
   where r.order_id is not null
     and not exists (select 1 from public.orders o where o.id = r.order_id)
), s7 as (
  select count(*) n from (
    select o.id from _chk_scope o
    left join public.revenue_recognitions r on r.order_id = o.id
    where o.source in ('oneoff','airbnb_cancelled') and o.amount <> 0
    group by o.id, o.amount, o.checkin
    having count(r.id) <> 1
        or abs(coalesce(sum(r.month_amount),0) - o.amount) > 0.005
        or min(r.ym) <> to_char(o.checkin,'YYYYMM')) x
)
select
  (select count(*) from _chk_scope)                     as 檢查範圍訂單數,
  s1.n as "①認列總和≠訂單金額",
  s4.n as "④同月重複認列",
  s5.n as "⑤有訂單沒認列",
  s6.n as "⑥孤兒認列",
  s7.n as "⑦一次性收入異常",
  case when s1.n + s4.n + s5.n + s6.n + s7.n = 0
       then '✅ 全部通過' else '❌ 有問題,往上看明細' end as 結論
from s1, s4, s5, s6, s7;
