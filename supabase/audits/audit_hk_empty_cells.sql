/*
 * audit_hk_empty_cells —— 排班表上沒有房源的格子是怎麼來的（唯讀）
 * ============================================================
 * 2026-09-01 使用者：「怎麼有的沒房間？」
 *
 * 畫面上「Una 退房清潔」「庭玉 清潔」這種格子＝ `hk_work_item` 有這一列，
 * 但 `property_code` 是 null。它們**照樣算 1 間**，只是算不出打掃點數
 * —— 卡片上那個「⚠ N 筆未計」就是它們。
 *
 * ★★★ 對不起來的地方:例外清單只有 8 筆，而這種空格有十幾個。
 *   如果每一格都對應一個「房源沒對到」的事件，兩個數字應該接近。
 *   差這麼多代表有一類根本沒進例外清單 —— 這支就是要找出那一類。
 *
 * 「★ 為什麼沒進例外清單」那一欄會直接說原因。
 *
 * 整份照貼，全選再按 Run。
 */

select
  w.work_date                                   as "日期",
  coalesce(s.name, left(w.staff_id::text, 8))   as "誰",
  w.work_type                                   as "工作類型",
  w.source                                      as "來源",
  case when w.event_id is null then '（沒有連到事件）' else e.title end
                                                as "行事曆標題",
  e.excluded                                    as "事件被排除的原因",
  e.parsed_code                                 as "事件對到的房源",
  /*
   * ★★★ 這一欄回答「為什麼這一格沒進例外清單」。
   *   前端 exceptionEvents() 的條件是:
   *     · 標題含「協助行政／洗烘折毛巾」→ 不列
   *     · excluded = 'no_assignee'      → 列
   *     · 其餘只有 excluded 是空 **而且** parsed_code 是空才列
   */
  case
    when w.event_id is null                       then 'A 手動建的，沒有來源事件'
    when e.id is null                             then 'B 來源事件被刪了（event_id 變 null 之前的殘留）'
    when e.title like '%協助行政%'
      or e.title like '%洗烘折毛巾%'               then 'C 標題被排除在例外清單外'
    when e.parsed_code is not null                then 'D 事件對到房源了，但這一格沒跟著補'
    when e.excluded is not null
     and e.excluded <> 'no_assignee'              then 'E 事件 excluded=' || e.excluded || '，不列例外'
    else 'F 應該在例外清單上'
  end                                           as "★ 為什麼沒進例外清單"
from public.hk_work_item w
left join public.hk_event e on e.id = w.event_id
left join public.hk_staff s on s.id = w.staff_id
where w.period = '202608'
  and w.property_code is null
order by w.work_date, s.name;
