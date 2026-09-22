/*
 * 查：哪幾間房刪不掉、被哪張表卡住（2026-09-22）
 * **只讀。** 12 張會擋住的表是從 pg_constraint 查出來的，不是我憑印象列的。
 */
with b as (
  select p.id, coalesce(e.name,'（沒有物業）') as est, p.name,
    (select count(*) from public.cleaning_records       x where x.property_id = p.id) as 清潔,
    (select count(*) from public.deposits               x where x.property_id = p.id) as 押金,
    (select count(*) from public.expenses               x where x.property_id = p.id) as 支出,
    (select count(*) from public.hk_property            x where x.property_id = p.id) as 房務房源,
    (select count(*) from public.hk_work_split          x where x.property_id = p.id) as 房務拆帳,
    (select count(*) from public.orders                 x where x.property_id = p.id) as 訂單,
    (select count(*) from public.properties             x where x.parent_id = p.id)          as 子房源_新,
    (select count(*) from public.properties             x where x.parent_property_id = p.id) as 子房源_舊,
    (select count(*) from public.purchase_request_items x where x.property_id = p.id) as 請款項目,
    (select count(*) from public.recurring_charges      x where x.property_id = p.id) as 定期收費,
    (select count(*) from public.reviews                x where x.property_id = p.id) as 評價,
    (select count(*) from public.tax_invoice            x where x.property_id = p.id) as 發票
  from public.properties p left join public.estates e on e.id = p.estate_id
)
select est as 物業, name as 房源,
  (清潔+押金+支出+房務房源+房務拆帳+訂單+子房源_新+子房源_舊+請款項目+定期收費+評價+發票) as 卡住的總列數,
  concat_ws('、',
    nullif('清潔 '||清潔,'清潔 0'), nullif('押金 '||押金,'押金 0'),
    nullif('支出 '||支出,'支出 0'), nullif('房務房源 '||房務房源,'房務房源 0'),
    nullif('房務拆帳 '||房務拆帳,'房務拆帳 0'), nullif('訂單 '||訂單,'訂單 0'),
    nullif('子房源(新) '||子房源_新,'子房源(新) 0'), nullif('子房源(舊) '||子房源_舊,'子房源(舊) 0'),
    nullif('請款項目 '||請款項目,'請款項目 0'), nullif('定期收費 '||定期收費,'定期收費 0'),
    nullif('評價 '||評價,'評價 0'), nullif('發票 '||發票,'發票 0')) as 被誰卡住,
  case when (清潔+押金+支出+房務房源+房務拆帳+訂單+子房源_新+子房源_舊+請款項目+定期收費+評價+發票) = 0
       then '✅ 刪得掉' else '❌ 刪不掉' end as 判定
from b
where name in ('B18','B01','B02')      -- ★ 要查別間就改這一行；整段拿掉就是全部 180 間
order by est, name;
