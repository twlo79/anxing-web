/* ══════════════════════════════════════════════════════════════════════
 * 查：非月繳契約，「契約寫的每期金額」跟「月租單加起來」差多少        只讀，不改
 *
 * 【為什麼會差】
 *   存契約時 monthly_rent = round(amount_per_period ÷ 期數)   ← 四捨五入
 *   月租單一個月一張，金額 = monthly_rent                       （gen_contract_orders，migration_135）
 *   收款頁「第 N 期應收」= 那一期 12（或 3、6）張月租單相加 = monthly_rent × 期數
 *
 *   所以每期金額除不盡的契約，畫面上的應收會比契約多或少幾塊（最多 ±6）。
 *   8A3 薛凱封：2,001,272 ÷ 12 = 166,772.67 → 166,773 × 12 = 2,001,276（多 4）
 *   8A5 鄭麗玉：1,867,576 ÷ 12 = 155,631.33 → 155,631 × 12 = 1,867,572（少 4）
 *
 * 【這支列出所有受影響的契約】看完再決定要不要修產生器。
 * ══════════════════════════════════════════════════════════ */

with step as (
  select c.*,
         case c.cadence when 'monthly' then 1 when 'quarterly' then 3
                        when 'halfyear' then 6 when 'yearly' then 12 else 1 end as n
    from public.contracts c
   where c.active and c.amount_per_period is not null and c.cadence <> 'monthly'
)
select
  s.room                                   as "房源",
  s.tenant_name                            as "租戶",
  s.cadence                                as "繳別",
  s.amount_per_period                      as "契約每期",
  s.monthly_rent                           as "存的月租",
  s.monthly_rent * s.n                     as "月租×期數（畫面應收）",
  s.monthly_rent * s.n - s.amount_per_period as "差（＋＝畫面多收）",
  (select count(*) from public.orders o
    where o.contract_id = s.id and o.imported_via = 'contract' and o.paid) as "已收的月租單張數",
  case when s.monthly_rent * s.n = s.amount_per_period then '✅ 剛好整除'
       else '⚠ 每一期都差 ' || (s.monthly_rent * s.n - s.amount_per_period)::text || ' 元' end as "判定"
from step s
order by abs(s.monthly_rent * s.n - s.amount_per_period) desc, s.room;
