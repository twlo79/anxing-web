/*
 * 查：`parent_property_id`（舊、畫面上的「上層」下拉在寫）
 *   與 `parent_id`（新、migration_287 加的，住房率在讀）對不對得上。
 * **只讀。**
 */
select
  count(*)                                                              as 房源總數,
  count(*) filter (where parent_property_id is not null)                as 舊欄位有值,
  count(*) filter (where parent_id is not null)                         as 新欄位有值,
  count(*) filter (where parent_property_id is distinct from parent_id) as 兩邊不一樣,
  case when count(*) filter (where parent_property_id is distinct from parent_id) = 0
       then '✅ 兩邊一致' else '❌ 有列對不上 —— 住房率讀的跟畫面上設的不是同一個' end as 判定
from public.properties;

select coalesce(e.name,'—') as 物業, p.name as 房源,
  (select x.name from public.properties x where x.id = p.parent_property_id) as 畫面上的上層_舊,
  (select x.name from public.properties x where x.id = p.parent_id)          as 住房率用的上層_新
from public.properties p left join public.estates e on e.id = p.estate_id
where p.parent_property_id is distinct from p.parent_id
order by 1, 2;
