/* ══════════════════════════════════════════════════════════════════════
 * 查（只讀）：掛在「舊-A16」上的 Airbnb 編號，訂單匯入現在會進哪一間房？          2026-10-01
 *
 * 【為什麼】房源設定頁問「要搬到 A15 嗎？舊-A16 的對照會被清空」。
 *   那顆「搬」只改 properties.airbnb_listing_id（主編號，一間一格）；
 *   而訂單匯入、評價匯入、對帳讀的是另一張表 property_listings（migration_127，一間可以好幾個編號）。
 *   所以要先看那張表裡這個編號指著誰 —— 搬了主編號，訂單不一定跟著走。
 *
 * 一個字都不改。
 * ══════════════════════════════════════════════════════════ */
with old_p as (
  select id, name, active, airbnb_listing_id as lid from public.properties where name = '舊-A16'
)
select 1 as 序, '「舊-A16」身上的主編號' as 項目,
       coalesce((select lid from old_p), '（這間房沒填編號，或名字不是「舊-A16」）') as 內容
union all
select 2, 'property_listings 裡這個編號指向誰（訂單匯入真正看的）',
       coalesce((select string_agg(p.name || case when p.active then '' else '（已停用）' end
                                   || case when pl.is_current then '・現行' else '・舊編號' end
                                   || coalesce('・' || pl.note, ''), '；')
                   from public.property_listings pl join public.properties p on p.id = pl.property_id
                  where pl.listing_id = (select lid from old_p)),
                '⚠ 不在表裡 —— 這個編號的訂單目前整筆進不了系統')
union all
select 3, 'A15 現在的主編號',
       coalesce((select airbnb_listing_id from public.properties where name = 'A15'), '（空）')
union all
select 4, 'A15 在 property_listings 裡掛了哪些編號',
       coalesce((select string_agg(pl.listing_id || case when pl.is_current then '・現行' else '・舊' end, '；')
                   from public.property_listings pl join public.properties p on p.id = pl.property_id
                  where p.name = 'A15'), '（沒有）')
union all
select 5, '「舊-A16」身上有幾筆訂單（搬編號不會動它們）',
       (select count(*)::text from public.orders o where o.property_id = (select id from old_p))
order by 1;
