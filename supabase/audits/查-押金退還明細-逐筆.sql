-- ============================================================
-- 唯讀。押金退還 —— 逐筆。誰、多少、哪一天、日期是排的還是推的。
--
-- ★ 單獨一支 —— SQL Editor 只顯示最後一個 select。
--   彙總在另一支：查-押金退還時程.sql
--
-- ============================================================
-- 【★★★ 「日期怎麼來的」那一欄是這張表的重點】
--
--   ✅ 已排匯款日   有人真的排過（`planned_refund_on`）—— 可以拿去排現金
--   ⚠ 契約迄日推的  沒有人排過，我用 `contracts.end_date` 猜的
--   ⚠ 退房日推的    短租，用 `orders.checkout` 猜的
--   ❌ 排不出       三個都沒有 —— 這筆錢一定要退，但系統不知道哪一天
--
-- ★★ auto_renew 的契約，`end_date` 每次續約都會往後移 ——
--   用它推出來的退款日會跟著跑。那一欄會標出來。
--
-- ★ 「排不出日期」的排在最前面（`nulls first`）。
--   那幾筆是唯一**完全不在任何月份預估裡**的錢，最需要先處理。
-- ============================================================

select case when d.planned_refund_on is not null then '✅ 已排匯款日'
            when c.end_date is not null and c.auto_renew then '⚠ 契約迄日推的（會續約，日期會往後）'
            when c.end_date is not null                  then '⚠ 契約迄日推的'
            when o.checkout is not null                  then '⚠ 退房日推的'
            else '❌ 排不出日期 —— 這筆不在任何月份預估裡' end as 日期怎麼來的,

       coalesce(to_char(coalesce(d.planned_refund_on, c.end_date, o.checkout), 'YYYY/MM'), '—') as 預計月份,
       coalesce(d.planned_refund_on, c.end_date, o.checkout)  as 預計退款日,

       d.amount                                               as 退多少,

       coalesce(es.name, '（沒掛物業）')                         as 物業,
       coalesce(p.name, d.room, c.room, '（沒掛房源）')          as 房源,
       coalesce(d.guest_name, c.tenant_name, o.guest_name, '—') as 房客,

       d.received_on                                          as 當初收款日,

       -- ★ 退款流程走到哪。'none' = 還沒送審，那離真的匯出去還有三關
       case d.refund_status when 'none'     then '還沒送審'
                            when 'pending'  then '送審中'
                            when 'approved' then '已核可'
                            when 'rejected' then '已退回'
                            else d.refund_status end           as 退款狀態,

       -- ★★ 房客的收款帳戶。送審時要填 —— 空的代表這筆連怎麼退都還不知道
       case when d.payee_name is not null and d.payee_account is not null
            then d.payee_name || ' ' || d.payee_account
            else '⚠ 還沒填收款帳戶' end                          as 退給誰,

       coalesce(d.note, '')                                    as 備註

  from public.deposits d
  left join public.contracts  c  on c.id  = d.contract_id
  left join public.orders     o  on o.id  = d.order_id
  left join public.properties p  on p.id  = d.property_id
  left join public.estates    es on es.id = d.estate_id

 where d.received_on is not null      -- 收進來了
   and d.returned_on is null          -- 還沒退出去
   and not d.orphaned

 -- ★★★ 排不出日期的排最前面。那是唯一完全不在預估裡的錢
 order by coalesce(d.planned_refund_on, c.end_date, o.checkout) nulls first,
          d.amount desc;
