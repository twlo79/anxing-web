/*
 * 查-HMFCDB484W修改後.sql　2026-10-21（只讀，不改任何東西）
 * 確認 Make 送來的「Airbnb 修改通知」有寫進 ERP：日期、晚數、金額、備註
 */
select o.order_key as 訂房編號, o.property_raw as 房源, o.guest_name as 房客,
       o.checkin as 入住, o.checkout as 退房, o.nights as 晚數,
       o.amount as 金額, o.source as 來源, o.paid as 已收款,
       case when o.checkout = '2026-12-01' and o.nights = 59 then '✅ 已改成 12/1 退房、59 晚' else '❌ 還沒改到' end as 判定,
       left(o.note, 160) as 備註前段
  from public.orders o
 where o.order_key = 'HMFCDB484W';
