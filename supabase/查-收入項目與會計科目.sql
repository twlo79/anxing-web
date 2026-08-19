-- 收入的「項目」與支出的「會計科目」，兩邊攤開來看
--
-- ============================================================
-- 【為什麼要查這個】（2026-08-19）
--
-- 使用者要在契約固定加費加三個項目:
--
--     項目：電費   → 會計科目：水電瓦斯
--     項目：飲用水 → 會計科目：管理費
--     項目：其它   → 會計科目：其它
--
-- 而現在的資料模型只有兩層,而且名字取反了:
--
--     orders.fee_type    程式裡叫「會計科目」,裝的卻是**項目**
--                        （水費／電費／瓦斯費／清潔費…）
--     orders.item_name   細目（冰箱／洗烘衣機…）
--     account_codes      真正的會計科目表 —— **目前只有支出在用**
--
-- 所以「水電瓦斯」這個科目在收入側根本沒有地方放。
--
-- 要決定怎麼接之前，得先看清楚:
--   ① 支出的會計科目表裡有哪些
--   ② 收入側現在實際用了哪些 fee_type，各幾筆
--
-- **兩邊擺在一起才講得清楚哪個對到哪個。**


-- ── ① 支出的會計科目表 ─────────────────────────────
select
  code            as "代碼",
  name            as "科目名稱",
  kind            as "類型",
  sort            as "排序",
  case when active then '' else '（停用）' end as "狀態"
from public.account_codes
order by kind, sort, code;


-- ── ② 收入側現在實際用了哪些「項目」 ────────────────
/*
 * fee_type 是欄位名，但它裝的是項目層級的值。
 * 這裡看每一種各用了幾筆、金額多少 —— 少於幾筆的多半是誤填。
 */
select
  coalesce(fee_type, '（沒填）')                as "項目（fee_type）",
  count(*)                                     as "筆數",
  sum(amount)                                  as "金額",
  min(checkin)                                 as "最早",
  max(checkin)                                 as "最晚"
from public.orders
where source = 'oneoff' or fee_type is not null
group by fee_type
order by count(*) desc;


-- ── ③ 契約固定加費用了哪些（contract_recurring_charges）───
select
  coalesce(fee_type, '（沒填）')   as "項目（fee_type）",
  coalesce(item_name, '（沒填）')  as "細目（item_name）",
  count(*)                        as "幾張契約在用",
  sum(amount)                     as "每月合計"
from public.contract_recurring_charges
where active
group by fee_type, item_name
order by count(*) desc, 1, 2;
