/*
 * 只查、不改：停用的契約，營收認列是不是整張被清掉了（2026-10-13）
 *
 *   gen_contract_recognitions() 第一步「刪掉這張契約全部的認列」，接著
 *       if not ct.active then return;
 *   也就是說：契約一停用（包含按「結束租約」），它**從頭到尾**的營收都會從報表消失，
 *   連已經住完、已經收錢的月份也一樣。周羽艾 6B5 就是這樣：認列 0 筆。
 *
 * ★ 一張表：每一張停用契約 —— 起訖、月租、收到多少錢、現在有幾筆認列、照租期估算應該有多少營收
 *   最下面一列是合計。「約」是用天數粗估的，只是讓你看量級；真正的數字等修好重算後看營收頁。
 */
with c as (
  select c.id, c.room, c.tenant_name, c.start_date, c.end_date, c.monthly_rent, c.cadence,
         (select coalesce(sum(o.paid_amount), 0) from public.orders o where o.contract_id = c.id) as paid,
         (select count(*) from public.revenue_recognitions r where r.contract_id = c.id) as recog_n,
         round(coalesce(c.monthly_rent, 0) * greatest(0, (c.end_date - c.start_date + 1)) / 30.44) as est
    from public.contracts c
   where c.active = false and c.start_date is not null and c.end_date is not null
)
select * from (
select 0 as 序, c.room as 房源, c.tenant_name as 租戶,
       c.start_date::text || ' ~ ' || c.end_date::text as 租期,
       coalesce(c.monthly_rent::text, '—') || '／月（' || c.cadence || '）' as 月租,
       to_char(c.paid, 'FM999,999,990') as 已收,
       c.recog_n::text as 現在的認列筆數,
       '約 ' || to_char(c.est, 'FM999,999,990') as 照目前租期應有營收,
       case when c.recog_n = 0 and c.paid > 0 then '⚠ 收了錢、營收是 0'
            when c.recog_n = 0 then '營收是 0（也沒收到錢）'
            else '' end as 判定
  from c
union all
select 1, '合計', count(*)::text || ' 張停用契約',
       sum(case when recog_n = 0 and paid > 0 then 1 else 0 end)::text || ' 張「收了錢、營收是 0」',
       '', to_char(sum(paid), 'FM999,999,990'), sum(recog_n)::text,
       '約 ' || to_char(sum(est), 'FM999,999,990'), ''
  from c
) t
order by 序, 房源, 租期;
