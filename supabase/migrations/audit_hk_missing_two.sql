/*
 * audit_hk_missing_two —— 那兩筆到底怎麼了（唯讀）
 * ============================================================
 * 2026-09-01 使用者：「8/23 8/28 不見」「有兩筆是不是被按掉了」。
 *
 * 三種可能，「★ 狀態」那一欄會直接說是哪一種:
 *
 *   A. 被按掉了            dismissed_at 有值
 *   B. 重新解析對上了房源   parsed_code 有值 → 已經進統計，不再是例外
 *   C. 兩者都有            補過（補會同時建項目並按掉）之後又被重新解析
 *
 * ★★★ 最後兩欄是關鍵:按掉了但那天**沒有**手動補的工作項目，
 *   代表那筆清掃從統計裡消失了 —— 那是要人工救回來的。
 *
 * ============================================================
 * 【★ 這一版拿掉了「誰按的」】（2026-09-01 踩過）
 *
 *   ERROR: 42703: column s.auth_uid does not exist
 *
 * 我把 `hk_staff` 當成 `staff` 了 —— 前者是房務人員主檔（`hk_work_item`
 * 靠它算工作量），後者才是有登入身分的員工。**兩張不同的表。**
 *
 * 這支要回答的是「有沒有被按掉」，不是「誰按的」——
 * 為了一個附帶欄位去 join 一張沒查證過的表，是拿整支查詢的成敗去換。
 */

select
  e.event_date                    as "日期",
  e.title                         as "標題",
  e.parsed_code                   as "對到的房源",
  e.excluded                      as "被排除的原因",
  e.dismissed_at                  as "按掉的時間",
  case
    when e.dismissed_at is not null and e.parsed_code is not null then 'C 補過又被重新解析'
    when e.dismissed_at is not null                               then 'A 被按掉了'
    when e.parsed_code  is not null                               then 'B 重新解析對上了，已進統計'
    else '還在例外清單上'
  end                             as "★ 狀態",
  /*
   * ★★★ 這兩欄回答「那筆清掃有沒有真的進到統計裡」。
   *   「手動補的」是空的而狀態又是 A —— 那天的工作量憑空少了。
   */
  (select count(*) from public.hk_work_item w
    where w.period = e.period and w.work_date = e.event_date)
                                  as "那天總共幾筆工作項目",
  coalesce((select string_agg(coalesce(w.property_code, '(無房源)'), '、')
              from public.hk_work_item w
             where w.period = e.period
               and w.work_date = e.event_date
               and w.source = 'manual'), '（沒有）')
                                  as "那天手動補的房源"
from public.hk_event e
where e.period = '202608'
  and (e.title like '%Denys%' or e.title like '%律德%')
order by e.event_date;
