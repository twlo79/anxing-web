-- 查：儀表板某物業/某月營收顯示 0，但訂單明明有
--
-- 貼進 Supabase SQL Editor，一段一段跑。只讀不寫。
--
-- 儀表板的營收讀 revenue_recognitions（訂單營收認列），不是 orders.amount，
-- 也不是收款日期 —— 這是刻意的：跨月訂單只有認列表知道 3 萬元裡
-- 有多少落在 8 月、多少落在 9 月。
--
-- 顯示 0 只有三種可能：
--   A. 那些訂單根本沒產生認列
--   B. 認列產生了，但 estate_id 是空的 → 被物業篩選擋掉
--   C. 認列的 ym 跟你想的月份不同


-- ═══ 1. 那個月、那個物業，訂單與認列各有多少 ═══
-- 把 '正隆' 換成你要查的物業名稱，'2026-08' 換成月份
with tgt as (select id from estates where name = '正隆')
select
  (select count(*) from orders o, tgt
     where o.estate_id = tgt.id
       and to_char(o.checkin, 'YYYY-MM') = '2026-08')            as 訂單筆數,
  (select coalesce(sum(o.amount), 0) from orders o, tgt
     where o.estate_id = tgt.id
       and to_char(o.checkin, 'YYYY-MM') = '2026-08')            as 訂單金額,
  (select count(*) from revenue_recognitions r, tgt
     where r.estate_id = tgt.id and r.ym = '2026-08')            as 認列筆數,
  (select coalesce(sum(r.month_amount), 0) from revenue_recognitions r, tgt
     where r.estate_id = tgt.id and r.ym = '2026-08')            as 認列金額;


-- ═══ 2.【最可能】認列有產生，但 estate_id 是空的 ═══
-- 儀表板依 estate_id 篩物業。這欄是空的話，那筆營收會從物業視角消失。
select ym as 月份,
       count(*)                                    as 總筆數,
       count(*) filter (where estate_id is null)   as 沒有物業,
       count(*) filter (where property_id is null) as 沒有房源,
       sum(month_amount)                                   as 總金額,
       sum(month_amount) filter (where estate_id is null)  as 沒物業的金額
from revenue_recognitions
group by ym order by ym desc limit 12;


-- ═══ 3. 那個月的認列長什麼樣（不篩物業）═══
select source as 來源, count(*) as 筆數, sum(month_amount) as 金額,
       count(*) filter (where estate_id is null) as 沒物業
from revenue_recognitions
where ym = '2026-08'
group by source order by 3 desc;


-- ═══ 4.【A 的檢查】有訂單卻沒有對應認列 ═══
-- 回傳有東西 = gen_recognitions() 沒跑到那些訂單。
-- 常見原因：那些列是舊資料，或匯入時繞過了觸發器。
select o.source as 來源, count(*) as 沒認列的訂單數, sum(o.amount) as 金額,
       min(o.checkin) as 最早, max(o.checkin) as 最晚
from orders o
where not exists (select 1 from revenue_recognitions r where r.order_id = o.id)
  and o.amount > 0
group by o.source order by 2 desc;


-- ═══ 5. 長租的月租單有沒有產生認列 ═══
-- 51 筆長租訂單卻 0 元營收的話，答案在這裡。
select to_char(o.checkin, 'YYYY-MM') as 入住月,
       count(*)                                  as 月租單數,
       sum(o.amount)                             as 訂單金額,
       count(r.id)                               as 有認列的,
       coalesce(sum(r.month_amount), 0)          as 認列金額
from orders o
left join revenue_recognitions r on r.order_id = o.id
where o.imported_via = 'contract'
group by 1 order by 1 desc limit 12;


-- ═══ 6. 修法（確認原因之後才跑）═══
--
-- 若是 A（沒產生認列）：rebuild_recognitions() 會全刪重建，
-- 一次重算所有訂單的認列。這支是 SECURITY DEFINER，跑得動。
--
--   select rebuild_recognitions();      -- ⚠ 會先清空整張 revenue_recognitions
--
-- 跑之前先記下現在的總額，跑完比對：
--
--   select count(*), sum(month_amount) from revenue_recognitions;
--
-- 若是 B（estate_id 空）：那要看 orders 那邊的 estate_id 是不是也空的。
-- 是的話問題在訂單，補訂單的物業歸屬之後再 rebuild。
select count(*) as 訂單沒有物業歸屬
from orders where estate_id is null and amount > 0;
