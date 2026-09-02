/*
 * audit_oneoff_item_name —— 一次性收入哪幾筆沒填「項目」（唯讀）
 * ============================================================
 * 2026-09-02 使用者：「一次性費用 為何後面有空」「甚麼項目沒填到」
 *
 * 匯出的分類欄長成「其他收入・管理費・**—**」，那個破折號代表
 * 那一筆的 `item_name` 是空的（會計科目有，細項沒有）。
 *
 * ============================================================
 * 【★ 空的未必是錯的】
 *
 *   管理費、停車費、網路費   本來就沒有細項 —— 空的是**正常**
 *   清潔費                   底下有洗衣機／烘衣機／垃圾代收費 —— 空的才可疑
 *
 * ★ 所以這支不判斷對錯，只把「哪些科目常常空著」列出來讓你看。
 *   自動補一個項目名是最糟的做法:補錯了報表上會多一個
 *   沒有人認得的細目，而金額是對的所以不會有人發現。
 *
 * 整份照貼。只有 select。
 */

-- ① 各科目：填了與沒填的比例（全部期間）
select
  coalesce(r.fee_type, '⚠ 連科目都沒有')          as "會計科目",
  count(*)                                       as "筆數",
  count(*) filter (where coalesce(r.item_name, '') = '') as "項目沒填",
  count(*) filter (where coalesce(r.item_name, '') <> '') as "項目有填",
  coalesce(string_agg(distinct r.item_name, '、')
             filter (where coalesce(r.item_name, '') <> ''), '（都沒填）')
                                                 as "填過哪些項目",
  sum(r.month_amount)                            as "金額合計",
  case
    when count(*) filter (where coalesce(r.item_name, '') <> '') = 0
      then '這個科目從來沒填過項目 —— 多半是它本來就沒有細項'
    when count(*) filter (where coalesce(r.item_name, '') = '') = 0
      then '✅ 全部都有填'
    else '⚠ 有填有沒填 —— 同一個科目兩種寫法，報表上會分成兩列'
  end                                            as "★ 判斷"
from public.revenue_recognitions r
where r.source = 'oneoff'
group by r.fee_type
order by count(*) filter (where coalesce(r.item_name, '') = '') desc, r.fee_type;


-- ② 逐筆列出沒填項目的（近三個月）
/*
 * ★ 限近三個月 —— 歷史全撈會有幾百列，而要補也是從最近的補起。
 *   要看更早的把 `>=` 那個日期往前調。
 */
select
  r.ym                                           as "認列月份",
  coalesce(r.estate_name, '（無物業）')            as "物業",
  coalesce(r.property_raw, '—')                  as "房源",
  coalesce(r.fee_type, '⚠ 沒有科目')              as "會計科目",
  coalesce(r.guest_name, '—')                    as "客戶",
  r.month_amount                                 as "金額",
  /*
   * ★★ 訂單的備註常常寫著那筆到底是什麼（「洗衣機」「代收垃圾」）——
   *   要補項目的話，答案多半在這裡，不用去問人。
   */
  coalesce(left(o.note, 40), '')                 as "訂單備註",
  coalesce(o.order_key, '')                      as "訂單編號"
from public.revenue_recognitions r
left join public.orders o on o.id = r.order_id
where r.source = 'oneoff'
  and coalesce(r.item_name, '') = ''
  and r.ym >= to_char(now() - interval '3 months', 'YYYYMM')
order by r.ym desc, r.estate_name, r.fee_type;
