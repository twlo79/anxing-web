/* ══════════════════════════════════════════════════════════════════════
 * 查（只讀）：127 用名字猜出來的 Airbnb 對照，全部列出來給人過一遍                      2026-10-01
 *
 * 【為什麼】今天連抓到四筆猜錯的（舊-A16→A16 其實是 A15、舊-B3→B03 其實是 B01、
 *   舊-A13→A13 其實是 B03、舊-A15→A15 其實是 B04）。剩下那批沒有理由一定對 ——
 *   猜錯一筆，那個編號之後進來的訂單、評價全部歸錯房，而且沒有地方會叫。
 *
 * 三區：
 *   ① 127 猜的對照（備註開頭「舊編號（原 」）—— 每一列：編號、現在指到哪間、是從哪個「舊-」空殼猜來的
 *   ② 停用房源身上還掛著主編號的 —— 這些編號的訂單現在要嘛進停用房、要嘛整筆進不來
 *   ③ 在職房源一個編號都沒登記的 —— 不走 Airbnb 的是正常，走 Airbnb 的就是漏了
 * 一個字都不改。你過完告訴我「哪個編號其實是哪間」，我寫一支搬的。
 * ══════════════════════════════════════════════════════════ */
select '① 127 猜的' as 區, pl.listing_id as 編號,
       p.name || case when p.active then '' else '（已停用）' end as 現在指到,
       case when pl.is_current then '現行' else '舊' end as 狀態,
       pl.note as 備註,
       '請確認：這個編號在 Airbnb 上現在是哪間？' as 要你看的
  from public.property_listings pl join public.properties p on p.id = pl.property_id
 where pl.note like '舊編號（原 %'
union all
select '② 停用房源還掛著主編號', p.airbnb_listing_id, p.name || '（已停用）',
       coalesce((select case when x.is_current then '現行' else '舊' end || '→' || q.name
                   from public.property_listings x join public.properties q on q.id = x.property_id
                  where x.listing_id = p.airbnb_listing_id), '⚠ 不在對照表，訂單整筆進不來'),
       null,
       '這個編號現在是哪間房的？還是真的沒在用了？'
  from public.properties p
 where not p.active and p.airbnb_listing_id is not null
union all
select '③ 在職房源沒有任何編號', null, p.name, null, null,
       '有在 Airbnb 上就是漏登記'
  from public.properties p
 where p.active and p.airbnb_listing_id is null
   and not exists (select 1 from public.property_listings x where x.property_id = p.id)
   and coalesce(p.ptype, '') <> 'common_area'
order by 1, 3, 2;
