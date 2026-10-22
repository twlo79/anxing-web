/*
 * 查-HMSQZ88BQM取消後.sql　2026-10-21（只讀，不改任何東西）
 * 確認 Make 送來的「Airbnb 取消通知」有寫進 ERP：來源改成 airbnb_cancelled、金額 0
 * 一筆都沒有＝系統裡本來就沒有這張（Make 那邊會回 not_found）
 */
select o.order_key as 訂房編號, o.property_raw as 房源, o.guest_name as 房客,
       o.checkin as 入住, o.checkout as 退房, o.amount as 金額, o.source as 來源, o.paid as 已收款,
       case when o.source = 'airbnb_cancelled' and coalesce(o.amount, 0) = 0 then '✅ 已標成 Airbnb 取消、金額 0'
            when o.paid then '⚠ 已收款，沒有自動作廢（要人確認）'
            else '❌ 還沒改到' end as 判定,
       left(o.note, 160) as 備註前段
  from public.orders o
 where o.order_key = 'HMSQZ88BQM';
