/* 查（只讀）：14B1／14B3 陳月明 的訂金轉押金了沒                                   2026-10-02
 * 每一列是一筆暫收款（訂金或押金），加上它的收款紀錄。一個字都不改。
 */
select d.room as 房源,
       case d.kind when 'earnest' then '訂金' else '押金' end as 種類,
       to_char(d.amount, 'FM999,999,999') as 金額,
       coalesce(to_char(d.received_amount, 'FM999,999,999'), '—') as 已收,
       case when d.contract_id is not null then '契約' when d.order_id is not null then '訂單' else '（都沒有）' end as 掛在,
       case when d.kind = 'earnest' then
              case when d.converted_to_deposit_id is not null then '✅ 已轉押（' || to_char(d.converted_at at time zone 'Asia/Taipei', 'MM-DD HH24:MI') || '）'
                   when d.forfeit_order_id is not null then '已沒收'
                   when d.returned_on is not null then '已退'
                   else '❌ 還沒轉' end
            else case when d.converted_from_earnest_id is not null then '✅ 訂金轉來的' else '—' end end as 轉押狀態,
       coalesce((select string_agg(p.paid_on || ' ' || coalesce(p.method, '?') || ' $' || to_char(p.amount, 'FM999,999,999'), '；' order by p.paid_on)
                   from public.deposit_payments p where p.deposit_id = d.id), '（沒有收款紀錄）') as 收款紀錄
  from public.deposits d
 where d.room in ('14B1', '14B3') and coalesce(d.guest_name, '') like '%陳月明%'
 order by d.room, d.kind desc;
