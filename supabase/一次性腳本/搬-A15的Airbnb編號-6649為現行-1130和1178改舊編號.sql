/* ══════════════════════════════════════════════════════════════════════
 * A15 的 Airbnb 編號：664944262083918209 改為現行；1130…、1178… 改為舊編號；舊-A16 清空     2026-10-01
 *
 * 【為什麼】David：「664944262083918209 才是現在 A15」。
 *   線上現況（查-舊A16的listing 那支）：
 *     · 6649…209 主編號掛在「舊-A16」（已停用、0 筆訂單），property_listings 指向 A16（127 用名字猜的 —— 猜錯）
 *     · A15 主編號 1130…900（標現行）、另掛 1178…020（舊）—— 這兩個是 A15 之前下架的房源
 *
 * 【做什麼】一個交易做完，中間失敗就全部不動：
 *   1. property_listings：6649 → A15、現行；1130 與 1178 留在 A15、改成舊編號（它們的訂單還是 A15 的，不能刪）
 *   2. properties：舊-A16 的主編號清空；A15 的主編號改成 6649
 *   跑第二次結果一樣。
 *
 * ★★ 自檢在 commit 後面 —— 看不到那張表就是整支回滾了。
 * ══════════════════════════════════════════════════════════ */

begin;

do $$
declare
  v_a15 uuid; v_old uuid;
begin
  select id into v_a15 from public.properties where name = 'A15';
  select id into v_old from public.properties where name = '舊-A16';
  if v_a15 is null then
    raise exception '找不到房源「A15」—— 整支停下來，一筆都沒寫';
  end if;

  -- 1. 對照表（訂單匯入、評價匯入、對帳真正看的那張）
  insert into public.property_listings (listing_id, property_id, is_current, note)
  values ('664944262083918209', v_a15, true, '現行（2026-10-01 從 舊-A16／A16 搬來；127 用名字猜成 A16 是錯的）')
  on conflict (listing_id) do update
     set property_id = excluded.property_id, is_current = true, note = excluded.note;

  update public.property_listings
     set is_current = false,
         note = case when coalesce(note, '') like '%下架%' then note
                     else concat_ws('；', nullif(note, ''), '下架（2026-10-01 起現行改為 6649…209）') end
   where property_id = v_a15 and listing_id in ('1130946734936418900', '1178627391586613020');

  -- 2. 主編號那一格（一間一格、全系統唯一）：先清舊-A16，再填 A15，順序不能反
  update public.properties set airbnb_listing_id = null
   where airbnb_listing_id = '664944262083918209' and id <> v_a15;
  update public.properties set airbnb_listing_id = '664944262083918209' where id = v_a15;
end $$;

commit;

-- ═══ 自檢（在 commit 後面 —— 看不到這張表就是整支回滾了） ═══════════
select 1 as 序, 'A15 的主編號' as 檢查,
       (select coalesce(airbnb_listing_id, '（空）') from public.properties where name = 'A15') as 結果,
       case when (select airbnb_listing_id from public.properties where name = 'A15') = '664944262083918209' then '✅' else '❌' end as 判定
union all
select 2, 'A15 在對照表裡掛了哪些編號',
       (select string_agg(pl.listing_id || case when pl.is_current then '・現行' else '・舊' end, '；' order by pl.is_current desc, pl.listing_id)
          from public.property_listings pl join public.properties p on p.id = pl.property_id where p.name = 'A15'),
       case when (select count(*) from public.property_listings pl join public.properties p on p.id = pl.property_id
                   where p.name = 'A15' and pl.listing_id in ('664944262083918209','1130946734936418900','1178627391586613020')) = 3
             and (select count(*) from public.property_listings pl join public.properties p on p.id = pl.property_id
                   where p.name = 'A15' and pl.is_current) = 1
            then '✅ 三個都在、只有一個現行' else '❌' end
union all
select 3, '6649…209 在對照表裡指向誰（訂單會進這間）',
       (select string_agg(p.name || case when p.active then '' else '（已停用）' end, '；')
          from public.property_listings pl join public.properties p on p.id = pl.property_id
         where pl.listing_id = '664944262083918209'),
       case when (select p.name from public.property_listings pl join public.properties p on p.id = pl.property_id
                   where pl.listing_id = '664944262083918209') = 'A15' then '✅' else '❌' end
union all
select 4, '舊-A16 的主編號',
       (select coalesce(airbnb_listing_id, '（空）') from public.properties where name = '舊-A16'),
       case when (select airbnb_listing_id from public.properties where name = '舊-A16') is null then '✅ 清掉了' else '❌' end
union all
select 5, '全系統還有沒有別間房掛著 6649…209',
       (select coalesce(string_agg(name, '；'), '沒有') from public.properties where airbnb_listing_id = '664944262083918209' and name <> 'A15'),
       case when exists (select 1 from public.properties where airbnb_listing_id = '664944262083918209' and name <> 'A15') then '❌' else '✅' end
order by 1;
