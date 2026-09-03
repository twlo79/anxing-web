-- A. 房務代碼「開封整棟」→ ERP 房源 → 那一列的清潔費到底是多少
--    ★ 不要只查 properties 裡叫「開封整棟」的那一列 ——
--      重點是**代碼指到的那一列**。指錯的話你設的價在另一列上
select hp.code                       as 房務代碼,
       hp.property_id                as 指到的房源id,
       p.name                        as 指到的房源名,
       p.clean_price                 as 清潔費,
       p.clean_points                as 打掃點數,
       e.name                        as 物業,
       p.active                      as 房源啟用中
  from public.hk_property hp
  left join public.properties p on p.id = hp.property_id
  left join public.estates    e on e.id = p.estate_id
 where hp.code in ('開封整棟','開封2F','復興','台視公區','時兆公區','正隆多間');

-- B. 叫這些名字的 ERP 房源有幾列（有沒有重複、價設在哪一列）
select p.id, p.name, p.clean_price, p.active, e.name as 物業
  from public.properties p
  left join public.estates e on e.id = p.estate_id
 where p.name in ('開封整棟','開封2F','復興','台視公區','時兆公區')
 order by p.name;

-- C. 08-14 庭玉的工單現在長什麼樣（三筆補登進去了沒）
select w.id, w.work_date, s.name as 人員, w.property_code as 代碼,
       w.units_override as 間數覆寫, w.source as 來源
  from public.hk_work_item w
  join public.hk_staff s on s.id = w.staff_id
 where w.period = '202608' and w.work_date = '2026-08-14'
 order by s.name, w.property_code;
