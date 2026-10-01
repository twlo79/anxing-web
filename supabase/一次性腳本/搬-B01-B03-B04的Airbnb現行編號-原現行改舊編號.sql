/* ══════════════════════════════════════════════════════════════════════
 * B01／B03／B04 的 Airbnb 現行編號換掉；原本的現行改舊編號；舊-XX 空殼清空                 2026-10-01
 *
 * 【為什麼】David：B01 換成 1146137970033622152、B03 換成 842333091302945663、B04 換成 1178627391586613020。
 *   線上現況（查-B01-B03-B04 那支）：三個編號分別掛在「舊-B3」「舊-A13」「舊-A15」（都已停用）的主編號上，
 *   對照表裡被 127 用名字猜成 B03／A13／A15 的舊編號 —— 三筆都是猜的，沒有一筆是真的帶入。
 *   三間房現在的現行（1690…168、1172…415、1328…449）是下架的，留著改成舊編號，訂單還是這間房的。
 *
 * 【做什麼】一個交易三間一起，中間失敗就全部不動；跑第二次結果一樣：
 *   1. 對照表：新編號 → 這間房、現行；這間房原本的現行 → 舊、備註加「下架」
 *   2. 主編號：先把別間（舊-XX）身上的清掉，再填進這間房
 *
 * ★ 跑之前再看一眼 B01 那個數字：1146**137970033622152**（原 舊-B3）。
 *   B01 自己名下另有一個很像的 1146**167098851404692**（原 舊-B1）—— 兩個差在中間幾碼。
 *
 * ★★ 自檢在 commit 後面 —— 看不到那張表就是整支回滾了。
 * ══════════════════════════════════════════════════════════ */

begin;

do $$
declare
  r record; v_to uuid;
begin
  for r in select * from (values ('B01', '1146137970033622152'),
                                ('B03', '842333091302945663'),
                                ('B04', '1178627391586613020')) as t(room, lid)
  loop
    select id into v_to from public.properties where name = r.room and active;
    if v_to is null then
      raise exception '找不到在職房源「%」—— 整支停下來，一筆都沒寫', r.room;
    end if;

    -- 1. 對照表（訂單匯入、評價匯入、對帳真正看的那張）
    update public.property_listings
       set is_current = false,
           note = case when coalesce(note, '') like '%下架%' then note
                       else concat_ws('；', nullif(note, ''), '下架（2026-10-01 起現行改為 ' || r.lid || '）') end
     where property_id = v_to and is_current and listing_id <> r.lid;

    insert into public.property_listings (listing_id, property_id, is_current, note)
    values (r.lid, v_to, true, '現行（2026-10-01 David 指定；127 用名字猜到別間是錯的）')
    on conflict (listing_id) do update
       set property_id = excluded.property_id, is_current = true, note = excluded.note;

    -- 2. 主編號（一間一格、全系統唯一）：先清別間，再填這間，順序不能反
    update public.properties set airbnb_listing_id = null
     where airbnb_listing_id = r.lid and id <> v_to;
    update public.properties set airbnb_listing_id = r.lid where id = v_to;
  end loop;
end $$;

commit;

-- ═══ 自檢（在 commit 後面 —— 看不到這張表就是整支回滾了） ═══════════
with want(room, lid) as (values ('B01', '1146137970033622152'), ('B03', '842333091302945663'), ('B04', '1178627391586613020'))
select 1 as 序, w.room || ' 的主編號' as 檢查,
       coalesce((select airbnb_listing_id from public.properties where name = w.room), '（空）') as 結果,
       case when (select airbnb_listing_id from public.properties where name = w.room) = w.lid then '✅' else '❌' end as 判定
  from want w
union all
select 2, w.room || ' 在對照表裡掛了哪些編號',
       (select string_agg(pl.listing_id || case when pl.is_current then '・現行' else '・舊' end, '；' order by pl.is_current desc, pl.listing_id)
          from public.property_listings pl join public.properties p on p.id = pl.property_id where p.name = w.room),
       case when (select count(*) from public.property_listings pl join public.properties p on p.id = pl.property_id
                   where p.name = w.room and pl.is_current and pl.listing_id = w.lid) = 1
             and (select count(*) from public.property_listings pl join public.properties p on p.id = pl.property_id
                   where p.name = w.room and pl.is_current) = 1
            then '✅ 只有新編號是現行' else '❌' end
  from want w
union all
select 3, w.lid || ' 還有沒有別間房掛著（主編號）',
       coalesce((select string_agg(name, '；') from public.properties where airbnb_listing_id = w.lid and name <> w.room), '沒有'),
       case when exists (select 1 from public.properties where airbnb_listing_id = w.lid and name <> w.room) then '❌' else '✅' end
  from want w
union all
select 4, '舊-B3／舊-A13／舊-A15 的主編號（要全空）',
       (select string_agg(name || '：' || coalesce(airbnb_listing_id, '空'), '；' order by name) from public.properties where name in ('舊-B3', '舊-A13', '舊-A15')),
       case when (select count(*) from public.properties where name in ('舊-B3', '舊-A13', '舊-A15') and airbnb_listing_id is not null) = 0 then '✅' else '❌' end
order by 1, 2;
