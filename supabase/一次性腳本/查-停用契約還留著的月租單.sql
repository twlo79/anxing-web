/*
 * 只查、不改：停用的契約，為什麼房源狀態還畫出月租單（2026-10-13）
 *
 *   6B5 周羽艾的契約停用了，房源狀態上 11/01～11/30 還有一條「周羽艾」，跟台灣美創撞在一起。
 *   那條是契約當初產好的**月租單**（orders.contract_id 指著它）—— 契約停用時沒有一起收掉。
 *
 * ★ 一張表：上半是 6B5 周羽艾那張契約與它的月租單，下半是「所有停用契約、今天以後還有月租單」的總表。
 *   月租單會算進營收 —— 停用之後還留著的話，那幾個月的營收是多的。
 */
with ct as (
  select id, room, tenant_name, start_date, end_date, active, cadence, amount_per_period
    from public.contracts
   where tenant_name like '%周羽艾%'
)
select '① 契約' as 區塊, ct.room as 房源, ct.tenant_name as 租戶,
       ct.start_date::text || ' ~ ' || ct.end_date::text as 期間,
       case when ct.active then '使用中' else '停用' end as 狀態,
       ct.cadence || ' 每期 ' || coalesce(ct.amount_per_period::text, '—') as 金額,
       ct.id::text as id
  from ct
union all
select '② 它的月租單', o.property_raw, o.guest_name,
       o.checkin::text || ' ~ ' || o.checkout::text,
       case when o.cancelled_on is not null then '已取消' else '有效' end,
       coalesce(o.amount::text, '0') || '（' || coalesce(o.order_key, '') || '）',
       o.id::text
  from public.orders o join ct on ct.id = o.contract_id
union all
select '③ 停用契約・今天以後還有月租單', c.room, c.tenant_name,
       min(o.checkin)::text || ' ~ ' || max(o.checkout)::text,
       count(*)::text || ' 張',
       sum(coalesce(o.amount, 0))::text,
       c.id::text
  from public.contracts c
  join public.orders o on o.contract_id = c.id
 where c.active = false and o.checkout > current_date and o.cancelled_on is null
 group by c.id, c.room, c.tenant_name
order by 1, 4;
