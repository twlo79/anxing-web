-- ============================================================
-- 唯讀。收了還沒退的押金：什麼時候要退、退多少、退給誰。
--
-- ★ 單獨一支 —— SQL Editor 只顯示**最後一個 select** 的結果，
--   一個檔案裡放五張表的話前四張會被蓋掉（2026-09-03 踩過）。
--
-- 【退款日怎麼來的】三段退回，畫面上會標出是哪一種：
--   1. planned_refund_on  已經排過匯款日 —— 最準
--   2. 契約 end_date      約滿退，推算的
--   3. 訂單 checkout      短租退房退，推算的
--   都沒有 → 排不進月份，會出現在最後那張彙總的「排不出日期」。
--
-- ★★ auto_renew 的契約 end_date 每次續約都會往後 ——
--   用它推出來的退款日會跟著移。拿去排現金要知道。
-- ============================================================

with d as (
  select d.id, d.amount, d.received_on, d.refund_status,
         coalesce(d.planned_refund_on, c.end_date, o.checkout) as refund_on,
         case when d.planned_refund_on is not null then '✅ 已排匯款日'
              when c.end_date is not null and c.auto_renew    then '⚠ 契約迄日推的（會續約，日期會往後）'
              when c.end_date is not null                     then '⚠ 契約迄日推的'
              when o.checkout is not null                     then '⚠ 退房日推的'
              else '❌ 排不出日期' end                          as 日期怎麼來的,
         coalesce(d.guest_name, c.tenant_name, o.guest_name, '—') as 房客,
         coalesce(es.name, '—')                                as 物業,
         coalesce(d.room, c.room, '—')                         as 房源
    from public.deposits d
    left join public.contracts c  on c.id = d.contract_id
    left join public.orders    o  on o.id = d.order_id
    left join public.estates   es on es.id = d.estate_id
   where d.received_on is not null
     and d.returned_on is null
     and not d.orphaned
)
-- ── 逐月彙總，外加三個「不在月份裡」的桶 ─────────────────────
select v.排序, v.月份, v.筆數, v.要退多少, v.說明 from (

  -- ★★★ 已經過期的排最前面。那是**現在**的義務，不是未來的現金流
  select 0 as 排序, '⚠ 退款日已過，還沒退' as 月份,
         count(*) as 筆數, sum(amount) as 要退多少,
         '★★ 隨時可能要付。這一列不是 0 的話，先看下面的逐筆' as 說明
    from d where refund_on < current_date

  union all
  select 1, to_char(refund_on, 'YYYY/MM'), count(*), sum(amount),
         string_agg(distinct 日期怎麼來的, '／')
    from d
   where refund_on >= current_date
     and refund_on < date_trunc('month', current_date) + interval '12 months'
   group by to_char(refund_on, 'YYYY/MM')

  union all
  select 2, '12 個月以後', count(*), sum(amount),
         '★ 不影響這一年的現金，但它是負債'
    from d
   where refund_on >= date_trunc('month', current_date) + interval '12 months'

  union all
  -- ★★★ 這一列不能是空的就跳過。排不出日期的押金遲早要付，
  --   而它不會出現在任何一個月份裡 —— 只看月份表就會漏掉
  select 3, '❌ 排不出退款日', count(*), sum(amount),
         '★★★ 這筆錢一定要退，但系統不知道哪一天。去補契約迄日或排匯款日'
    from d where refund_on is null

  union all
  select 4, '＝ 合計（收了還沒退的全部）', count(*), sum(amount),
         '★ 這是押金總負債。上面幾列加起來要等於它'
    from d

) v
 where v.筆數 > 0
 order by v.排序, v.月份;
