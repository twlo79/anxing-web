/*
 * 查-劉姐獨做的房間已經產生的清潔費（唯讀，不改任何資料）
 * ============================================================
 * 2026-09-07。改成「時薪取代清潔費」之後留下來的尾巴。
 *
 * ★★★ 產生支出是 `upsert` ＋ `ignoreDuplicates` —— **它永遠不刪東西**。
 *   所以 8 月倒出去的那幾筆清潔費還在，而現在又會多一筆劉姐的工時支出，
 *   同一份工付兩次。
 *
 *   ★★ 兩筆的 hk_job_key 不同（`日期|房源|類型` vs `HR|日期|人|房源`），
 *     所以唯一索引擋不住，帳面上也完全看不出來 ——
 *     只是那個月的房務成本多了一截。
 *
 * ★ 這一支只列出來，**不刪**。要刪的話用底下第二段（預設註解掉），
 *   走 soft_delete 進回收桶，反悔得回來。
 *
 *
 * ============================================================
 * 【★★ 這支查詢的已知限制：房源用 code 直接對】
 *
 * `hk_work_item.property_code` 是使用者打的字樣，前端比對時會走
 * `hk_property.aliases`（`matchProperty`）。這裡只用 `code =` 直接對，
 * **所以只靠別名才對得上的房源會漏掉**。
 *
 * ★ 漏掉的方向是「少列」不是「多列」—— 列出來的每一筆都確定是,
 *   但可能還有幾筆沒被抓到。刪完之後再對一次產生預覽的清潔費筆數比較保險。
 *
 * 【怎麼跑】把期間改成你要檢查的月份，整段貼進 Supabase SQL Editor。
 */

with hourly as (
  -- 時薪人員（劉姐）
  select id, name from public.hk_staff where count_mode = 'hours'
),
jobs as (
  /*
   * 一份工 = 日期 ＋ 房源 ＋ 工作類型，跟 `estateLog()` 的 jobKey 同一個定義。
   * 順便數出「這份工有幾個人、其中幾個是時薪」。
   */
  select w.work_date,
         hp.property_id,
         w.work_type,
         count(distinct w.staff_id)                                              as n_staff,
         count(distinct w.staff_id) filter (
           where w.staff_id in (select id from hourly))                          as n_hourly,
         string_agg(distinct s.name, '、' order by s.name)                        as who
    from public.hk_work_item w
    join public.hk_property hp on hp.code = w.property_code
    left join public.hk_staff  s on s.id = w.staff_id
   where hp.property_id is not null
     -- ★ 要檢查的期間改這裡
     and w.work_date >= date '2026-08-01'
     and w.work_date <  date '2026-09-01'
   group by w.work_date, hp.property_id, w.work_type
)
select
  e.spent_on          as "支出日",
  coalesce(p.name, '?') as "房源",
  j.who               as "誰做的",
  e.item_name         as "項目",
  e.amount            as "金額",
  e.hk_job_key        as "key",
  e.id                as "expense_id"
from jobs j
join public.expenses e
  /*
   * ★★★ key 必須跟 `cleaningCosts()` 組出來的一模一樣。
   *   `work_date` 是 date，要轉成 `YYYY-MM-DD` 才對得上 ——
   *   直接 `||` 會用 session 的日期格式，換一台機器就對不上了。
   */
  on e.hk_job_key = to_char(j.work_date, 'YYYY-MM-DD')
                    || '|' || j.property_id::text
                    || '|' || j.work_type
left join public.properties p on p.id = j.property_id
where j.n_staff > 0
  and j.n_staff = j.n_hourly      -- ★ 整份工都是時薪人員做的才算
order by e.spent_on, p.name;


/*
 * ══════════════════════════════════════════════════════════
 * 第二段：確認上面那張表沒問題之後，才把這一段的註解拿掉執行
 * ══════════════════════════════════════════════════════════
 *
 * ★★ 走 `soft_delete` 不是 `delete` —— 進回收桶，刪錯了在
 *   設定 → 回收桶 救得回來，而且留得下「誰刪的」。
 *
 * ★ 一次一筆是刻意的:貼上面查出來的 expense_id，一筆一筆確認。
 *   整批跑的話手滑一次就是整個月的清潔費不見了。
 *
 * select public.soft_delete('expenses', '把 expense_id 貼這裡'::uuid,
 *                           '劉姐獨做，改由時薪支出承擔');
 */
