/*
 * audit_nanjing_recognition —— 南京 8 月為什麼只認列 2 筆（唯讀）
 * ============================================================
 * 2026-09-01 使用者：「為何沒有南京 認列營收」
 *
 * 契約清單有 5 張有效的長租，但營收表 202608 只出現 2 筆
 * （南京10-2 的 $540 其他收入、南京6 的 $46,000 長租）。
 *
 * ============================================================
 * 【鏈條有三段，斷在哪一段決定怎麼修】
 *
 *     契約 contracts
 *       ↓ gen_contract_orders          產生每期的月租單
 *     訂單 orders（source='longterm'）
 *       ↓ 認列                          按月拆成認列
 *     認列 revenue_recognitions（營收表讀這張）
 *
 * ★★ `revenue_recognitions` 只有 `order_id`（migration_174:338 的註解）——
 *   也就是說**沒有月租單就不可能有認列**。所以要先看第二段在不在。
 *
 * ★ 「本月未收」那一欄是契約頁自己算的，**不代表月租單存在** ——
 *   所以畫面上看起來正常，帳上卻是空的。
 *
 * 「★ 斷在哪」那一欄會直接說。整份照貼，全選再按 Run。
 */

select
  c.room                                        as "房源",
  c.tenant_name                                 as "租戶",
  c.active                                      as "啟用",
  c.start_date                                  as "起",
  c.end_date                                    as "訖",
  c.amount_per_period                           as "每期金額",
  c.cadence                                     as "繳別",
  c.earnest_only                                as "訂金階段",
  -- ① 這張契約總共產生了幾張月租單
  (select count(*) from public.orders o
    where o.contract_id = c.id)                 as "月租單總數",
  -- ② 其中涵蓋 2026-08 的有幾張
  (select count(*) from public.orders o
    where o.contract_id = c.id
      and o.checkin <= '2026-08-31' and o.checkout >= '2026-08-01')
                                                as "涵蓋8月的月租單",
  -- ③ 202608 的認列有幾筆
  (select count(*) from public.revenue_recognitions r
     join public.orders o on o.id = r.order_id
    where o.contract_id = c.id and r.ym = '202608')
                                                as "8月認列筆數",
  /*
   * ★ 欄位是 `month_amount` 不是 `amount`（2026-09-01 踩過）——
   *   一列 = 一個月的認列，名字寫明「這個月認多少」。
   *   欄位名對回 `dashboard/page.tsx` 的 `Rev` 型別確認過。
   */
  (select coalesce(sum(r.month_amount), 0) from public.revenue_recognitions r
     join public.orders o on o.id = r.order_id
    where o.contract_id = c.id and r.ym = '202608')
                                                as "8月認列金額",
  case
    when c.earnest_only                                    then 'A 還在訂金階段 —— 本來就不產生月租單'
    when not c.active                                      then 'B 契約已停用'
    when c.start_date is null or c.end_date is null
      or coalesce(c.amount_per_period, 0) = 0              then 'C 起訖或金額沒填 —— 產生器開頭就 return'
    when (select count(*) from public.orders o
           where o.contract_id = c.id) = 0                 then '⚠⚠ D 一張月租單都沒有 —— 產生器沒跑過'
    when (select count(*) from public.orders o
           where o.contract_id = c.id
             and o.checkin <= '2026-08-31'
             and o.checkout >= '2026-08-01') = 0           then '⚠⚠ E 有月租單但沒有涵蓋 8 月的'
    when (select count(*) from public.revenue_recognitions r
            join public.orders o on o.id = r.order_id
           where o.contract_id = c.id and r.ym = '202608') = 0
                                                           then '⚠⚠⚠ F 有 8 月的月租單卻沒有認列 —— 斷在最後一段'
    else '✅ 正常，有認列'
  end                                           as "★ 斷在哪"
from public.contracts c
join public.estates e on e.id = c.estate_id
where e.name = '南京'
order by c.room;
