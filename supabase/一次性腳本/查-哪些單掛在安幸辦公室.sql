/*
 * 只查、不改：營收頁「物業＝安幸辦公室」為什麼出現 9A5、2F-2 這些（2026-10-08）
 *
 *   「安幸辦公室」不是一棟樓，是 orders.purpose_type = 'office' 這個標記（migration_247）：
 *   物業、房源照舊掛真的（正隆 9A5、時兆 2F-2），只有「這筆錢算誰的」換成安幸。
 *
 *   會掛上去的來源：
 *     · 公司登記、辦公室租金  —— 本來就是安幸自己的生意（正常）
 *     · 契約勾了「收入屬安幸辦公室」 —— 月租、加費、折讓全部跟著走
 *     · 訂單自己勾了「收入屬安幸辦公室」
 *     · 一次性收入選了「安幸辦公室」
 *
 *   這支把**公司登記、辦公室租金以外**的全部列出來，看是哪一個勾的。
 */
select o.source as 來源,
       coalesce(e.name, '（沒有物業）') as 物業,
       coalesce(o.property_raw, '—') as 房源,
       o.guest_name as 房客租戶,
       coalesce(o.fee_type, '') as 科目,
       count(*) as 筆數,
       min(o.checkin)::text as 最早, max(o.checkout)::text as 最晚,
       case when bool_or(o.contract_id is not null) then '契約上勾的（改要到契約頁）'
            when bool_or(o.imported_via = 'recurring') then '定期收費（migration_326）'
            else '訂單自己勾的（改要到短租訂單頁）' end as 從哪來
  from public.orders o
  left join public.estates e on e.id = o.estate_id
 where o.purpose_type = 'office'
   and o.source not in ('company', 'office')
 group by 1, 2, 3, 4, 5
 order by 9, 2, 3, 4;
