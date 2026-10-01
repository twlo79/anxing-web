/* ══════════════════════════════════════════════════════════════════════
 * 查（只讀）：David 給的 24 間現行 Airbnb 編號，跟系統裡的對一遍                           2026-10-01
 *
 * 每一列：房源、你給的編號、系統主編號、對照表現行、這個編號現在被誰拿著 → 判定。
 *   ✅ 一致                          ＝ 主編號與對照表現行都是你給的
 *   ⚠ 主編號不同 / ⚠ 對照表現行不同   ＝ 要搬（下一支）
 *   ⚠ 編號被別間拿著                 ＝ 搬的時候要先從那間清掉
 *   ⚠ 找不到房源 / ⚠ 同名有兩列      ＝ 先處理房源主檔，不猜
 * 一個字都不改。
 *
 * ★ A18 的 664230264721654000 結尾三個 0 —— Excel 只留 15 位有效數字，超過的會變 0。
 *   Airbnb 編號很少剛好以 000 結尾；這一筆請到 Airbnb 後台再抄一次。
 * ══════════════════════════════════════════════════════════ */
with want(room, lid) as (values
  ('A01','1786005308931703564'), ('A02','1457776695182019103'), ('A03','937422681201823205'),
  ('A04','677089535704769382'),  ('A05','929353951357514399'),  ('A06','1690610168707884047'),
  ('A07','1378837314467026006'), ('A08','674330602907373164'),  ('A09','1282340218634367672'),
  ('A11','1328713474972448999'), ('A13','833579819303898738'),  ('A14','1219304643824755645'),
  ('A15','664944262083918209'),  ('A16','1146177038348636535'), ('A17','927825367843614642'),
  ('A18','664230264721654000'),  ('B01','1146137970033622152'), ('B02','927299940589274953'),
  ('B03','842333091302945663'),  ('B04','1178627391586613020'), ('B05','674328595364570660'),
  ('B06','1690594271053849788'), ('B07','967750328135444708'),  ('B08','1376557783431171443')),
p as (
  select w.room, w.lid,
         (select count(*) from public.properties x where x.name = w.room and x.active) as n_room,
         (select x.id from public.properties x where x.name = w.room and x.active limit 1) as pid
    from want w
),
d as (
  select p.*,
         (select airbnb_listing_id from public.properties where id = p.pid) as main_id,
         (select string_agg(pl.listing_id, '；') from public.property_listings pl where pl.property_id = p.pid and pl.is_current) as cur_ids,
         (select string_agg(x.name || case when x.active then '' else '（停用）' end, '；')
            from public.properties x where x.airbnb_listing_id = p.lid and x.id is distinct from p.pid) as main_holder,
         (select string_agg(x.name || case when x.active then '' else '（停用）' end || case when pl.is_current then '・現行' else '・舊' end, '；')
            from public.property_listings pl join public.properties x on x.id = pl.property_id
           where pl.listing_id = p.lid and pl.property_id is distinct from p.pid) as map_holder
    from p
)
select room as 房源, lid as 你給的, coalesce(main_id, '（空）') as 系統主編號, coalesce(cur_ids, '（沒有）') as 對照表現行,
       coalesce(concat_ws('；', main_holder, map_holder), '—') as 這個編號現在在別間,
       case when n_room = 0 then '⚠ 找不到在職房源'
            when n_room > 1 then '⚠ 同名有 ' || n_room || ' 列，先處理主檔'
            when main_id = lid and cur_ids = lid then '✅ 一致'
            else concat_ws('；',
                   case when main_id is distinct from lid then '⚠ 主編號不同' end,
                   case when cur_ids is distinct from lid then '⚠ 對照表現行不同' end,
                   case when main_holder is not null or map_holder is not null then '⚠ 編號被別間拿著' end)
       end as 判定
  from d
order by room;
