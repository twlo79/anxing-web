/*
 * 只查、不改：6B5 兩張契約（周羽艾 停用／台灣美創）各自的月租單，同一個月有沒有算兩次營收（2026-10-13）
 *
 *   周羽艾那張停用了，但 2026-02 ～ 2027-01 十二張月租單都還「有效」。
 *   如果台灣美創是同一個租約換抬頭重建的，那兩邊的月租單每個月都會各算一次 —— 營收多一倍。
 *
 * ★ 一張表：① 6B5 所有契約　② 每個月兩邊各有幾張、多少錢（兩邊都有的那幾列標 ⚠）
 */
with c as (
  select id, tenant_name, start_date, end_date, active, cadence, amount_per_period, created_at
    from public.contracts where room = '6B5'
), m as (
  select to_char(o.checkin, 'YYYY-MM') as ym, c.tenant_name, c.active,
         count(*) as n, sum(coalesce(o.amount, 0)) as amt
    from public.orders o join c on c.id = o.contract_id
   where o.cancelled_on is null
   group by 1, 2, 3
)
select '① 契約' as 區塊, c.tenant_name as 名稱,
       c.start_date::text || ' ~ ' || c.end_date::text as 期間或月份,
       case when c.active then '使用中' else '停用' end as 狀態,
       c.cadence || ' 每期 ' || coalesce(c.amount_per_period::text, '—') as 金額,
       '建立於 ' || to_char(c.created_at, 'YYYY-MM-DD') as 備註
  from c
union all
select '② 月租單・' || m.ym, m.tenant_name, m.ym,
       case when m.active then '使用中契約' else '停用契約' end,
       m.n::text || ' 張・' || m.amt::text,
       case when (select count(distinct m2.tenant_name) from m m2 where m2.ym = m.ym) > 1
            then '⚠ 這個月兩張契約都有月租單' else '' end
  from m
order by 1, 3, 2;
