/* ══════════════════════════════════════════════════════════════════════
 * A01／A02／A13／A18／B05 的 Airbnb 現行編號對齊 David 的清單；原現行改舊編號；舊-A6 空殼清空     2026-10-01
 *
 * 【為什麼】「查-對一下-A01到B08」那支 24 列裡 5 列 ⚠：
 *   A01  主編號對、對照表現行卻是 1146025576703198218           → 1786005308931703564 改現行
 *   A02  主編號對、對照表現行卻是 674328595364570660（那是 B05 的）→ 1457776695182019103 改現行
 *   A13  主編號與對照表都是 1690538597975023982；David 說是 833579819303898738
 *        （那個編號掛在停用空殼「舊-A6」上、127 用名字猜到 A06）   → 8335…738 改現行
 *   A18  David 給 664230264721654000 —— 結尾 000 是 Excel 砍掉第 16 位以後的結果；
 *        系統主編號 664230264721654781 前 15 位完全相同，就是它      → 664…781 進對照表、現行
 *   B05  主編號與對照表都是 948964955880487874；David 說是 674328595364570660 → 改現行
 *
 * 【做什麼】一個交易五間一起，中間失敗就全部不動；跑第二次結果一樣：
 *   1. 對照表：新編號 → 這間房、現行；這間房原本的現行 → 舊、備註加「下架」（訂單還是這間的，不刪）
 *   2. 主編號：先把別間身上的清掉，再填進這間房
 *
 * ★★ 自檢在 commit 後面 —— 看不到那張表就是整支回滾了。
 * ══════════════════════════════════════════════════════════ */

begin;

do $$
declare
  r record; v_to uuid; n int;
begin
  for r in select * from (values ('A01', '1786005308931703564'),
                                ('A02', '1457776695182019103'),
                                ('A13', '833579819303898738'),
                                ('A18', '664230264721654781'),
                                ('B05', '674328595364570660')) as t(room, lid)
  loop
    select count(*) into n from public.properties where name = r.room and active;
    if n <> 1 then
      raise exception '在職房源「%」有 % 列（要剛好 1）—— 整支停下來，一筆都沒寫', r.room, n;
    end if;
    select id into v_to from public.properties where name = r.room and active;

    -- 1. 對照表（訂單匯入、評價匯入、對帳真正看的那張）
    update public.property_listings
       set is_current = false,
           note = case when coalesce(note, '') like '%下架%' then note
                       else concat_ws('；', nullif(note, ''), '下架（2026-10-01 起現行改為 ' || r.lid || '）') end
     where property_id = v_to and is_current and listing_id <> r.lid;

    insert into public.property_listings (listing_id, property_id, is_current, note)
    values (r.lid, v_to, true, '現行（2026-10-01 對齊 David 清單）')
    on conflict (listing_id) do update
       set property_id = excluded.property_id, is_current = true, note = excluded.note;

    -- 2. 主編號（一間一格、全系統唯一）：先清別間，再填這間，順序不能反
    update public.properties set airbnb_listing_id = null
     where airbnb_listing_id = r.lid and id <> v_to;
    update public.properties set airbnb_listing_id = r.lid where id = v_to;
  end loop;
end $$;

commit;

-- ═══ 自檢（在 commit 後面 —— 看不到那張表就是整支回滾了） ═══════════
with want(room, lid) as (values ('A01', '1786005308931703564'), ('A02', '1457776695182019103'),
                                ('A13', '833579819303898738'), ('A18', '664230264721654781'),
                                ('B05', '674328595364570660'))
select 1 as 序, w.room || ' 的主編號' as 檢查,
       coalesce((select airbnb_listing_id from public.properties where name = w.room and active), '（空）') as 結果,
       case when (select airbnb_listing_id from public.properties where name = w.room and active) = w.lid then '✅' else '❌' end as 判定
  from want w
union all
select 2, w.room || ' 在對照表裡掛了哪些編號',
       (select string_agg(pl.listing_id || case when pl.is_current then '・現行' else '・舊' end, '；' order by pl.is_current desc, pl.listing_id)
          from public.property_listings pl join public.properties p on p.id = pl.property_id where p.name = w.room and p.active),
       case when (select count(*) from public.property_listings pl join public.properties p on p.id = pl.property_id
                   where p.name = w.room and p.active and pl.is_current and pl.listing_id = w.lid) = 1
             and (select count(*) from public.property_listings pl join public.properties p on p.id = pl.property_id
                   where p.name = w.room and p.active and pl.is_current) = 1
            then '✅ 只有新編號是現行' else '❌' end
  from want w
union all
select 3, w.lid || ' 還有沒有別間掛著',
       coalesce((select string_agg(name || case when active then '' else '（停用）' end, '；')
                   from public.properties where airbnb_listing_id = w.lid and not (name = w.room and active)), '沒有'),
       case when exists (select 1 from public.properties where airbnb_listing_id = w.lid and not (name = w.room and active)) then '❌' else '✅' end
  from want w
union all
select 4, '24 間裡現在還有幾間主編號 ≠ 對照表現行（要 0）',
       coalesce((select string_agg(p.name, '；' order by p.name)
                   from public.properties p
                  where p.active and p.name ~ '^[AB]\d\d$'
                    and p.airbnb_listing_id is distinct from
                        (select string_agg(pl.listing_id, '；') from public.property_listings pl where pl.property_id = p.id and pl.is_current)), '沒有'),
       case when exists (select 1 from public.properties p
                          where p.active and p.name ~ '^[AB]\d\d$'
                            and p.airbnb_listing_id is distinct from
                                (select string_agg(pl.listing_id, '；') from public.property_listings pl where pl.property_id = p.id and pl.is_current))
            then '❌ 這幾間兩張表還不一致' else '✅' end
order by 1, 2;
