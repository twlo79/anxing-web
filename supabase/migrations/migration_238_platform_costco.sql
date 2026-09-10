/*
 * migration_238  好事多 → 好市多
 * ------------------------------------------------------------
 * 2026-09-10 使用者：「改成 好市多 幫我換字」
 *
 * ★★★ 為什麼一個錯字要一支 migration
 *
 * `purchase_demand_items.platform` 是純 text、**沒有 check**
 * （migration_222 刻意的決定:多一個採購平台不該要一支 migration）。
 *
 * 代價就在這裡:前端把選項改成「好市多」之後，
 * 舊資料裡的「好事多」**不會報錯** —— 它只是不再對應到任何 <option>，
 * 於是那幾列的下拉會顯示**空白**，看起來像「沒填平台」。
 *
 * ★ 沒有約束的欄位，改選項時一定要順手改舊值。
 *   會報錯的錯很好查；不報錯、只是變空白的才是麻煩的那種。
 * ------------------------------------------------------------
 */

update public.purchase_demand_items
   set platform = '好市多'
 where platform = '好事多';

comment on column public.purchase_demand_items.platform is
  '在哪買的（migration_222）：蝦皮／酷澎／淘寶／好市多⋯。null = 還沒填。'
  ' 純 text 沒有 check —— 清單在 src/lib/purchase-demand.ts 的 PURCHASE_PLATFORMS。'
  ' 改選項時要一起改舊值（migration_238 就是這麼來的）。';

-- ── 自檢 ──────────────────────────────────────────────
select
  case when count(*) filter (where platform = '好事多') = 0
       then '✅' else '❌' end                                as "舊值清乾淨",
  count(*) filter (where platform = '好市多')                 as "好市多筆數",
  count(*) filter (where platform is not null
                     and platform not in ('蝦皮','酷澎','淘寶','好市多'))
                                                              as "不在清單裡的(會顯示空白)",
  count(*)                                                    as "母體"
from public.purchase_demand_items;
