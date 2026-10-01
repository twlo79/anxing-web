/* ══════════════════════════════════════════════════════════════════════
 * 查（只讀）：B01／B03／B04 與三個 Airbnb 編號，現在各掛在哪                           2026-10-01
 *
 * 【為什麼】David：B01 換成 1146…152、B03 換成 8423…663、B04 換成 1178…020。
 *   其中 1178…020 剛剛還是 A15 的舊編號 —— 搬之前要看清楚它是怎麼來的（127 猜的？還是 A15 真的用過？）。
 *   搬錯一筆，那個編號的訂單全部歸錯房。一個字都不改。
 * ══════════════════════════════════════════════════════════ */
with want(room, lid) as (values ('B01', '1146137970033622152'), ('B03', '842333091302945663'), ('B04', '1178627391586613020'))
select 1 as 序, '三間房現在的主編號與對照表' as 區, w.room as 房源,
       coalesce((select p.airbnb_listing_id from public.properties p where p.name = w.room), '（空）') as 主編號,
       coalesce((select string_agg(pl.listing_id || case when pl.is_current then '・現行' else '・舊' end || coalesce('・' || pl.note, ''), '；' order by pl.is_current desc)
                   from public.property_listings pl join public.properties p on p.id = pl.property_id where p.name = w.room), '（沒有）') as 對照表,
       case when exists (select 1 from public.properties where name = w.room) then '' else '⚠ 找不到這間房' end as 備註
  from want w
union all
select 2, '三個編號現在被誰拿著', w.lid,
       coalesce((select string_agg(p.name || case when p.active then '' else '（已停用）' end, '；') from public.properties p where p.airbnb_listing_id = w.lid), '（沒人）'),
       coalesce((select string_agg(p.name || case when p.active then '' else '（已停用）' end || case when pl.is_current then '・現行' else '・舊' end || coalesce('・' || pl.note, ''), '；')
                   from public.property_listings pl join public.properties p on p.id = pl.property_id where pl.listing_id = w.lid), '（不在對照表）'),
       case when w.lid = '1178627391586613020' then '★ 剛剛還是 A15 的舊編號' else '' end
  from want w
order by 1, 3;
