/* ══════════════════════════════════════════════════════════════════════
 * 查（只讀）：發票功能體檢 —— 契約的發票設定分布、年繳約的開票狀況、待開發票照月份分             2026-10-01
 *
 * 給設計用的數字：
 *   ① 在職契約依物業：幾張要開、幾張不開、幾張年／季繳、幾張設了「收費後開」
 *   ② 要開發票的年繳／季繳契約（這些是「一期一張 vs 每月一張」會撞到的）
 *   ③ 已開的發票：張數、最早／最晚月份、掛在月租單／加費單／沒掛單
 *   ④ 待開：要開發票的在職契約，2026-06 起每個月的月租單裡還沒有對應發票的，照月份數
 *      （跟畫面的算法一樣：同契約同月份有一張發票就算開了）
 * 一個字都不改。
 * ══════════════════════════════════════════════════════════ */
with c as (
  select ct.*, e.name as estate_name from public.contracts ct left join public.estates e on e.id = ct.estate_id where ct.active
),
need as (select * from c where invoice_required and not coalesce(tax_free, false)),
pend as (
  select n.id as contract_id, n.estate_name, n.room, n.cadence, to_char(o.checkin, 'YYYYMM') as ym, o.paid
    from need n
    join public.orders o on o.contract_id = n.id and o.source in ('longterm', 'company', 'office')
   where o.checkin >= date '2026-06-01' and o.checkin < date '2026-11-01'
     and not exists (select 1 from public.invoices v where v.contract_id = n.id and v.ym = to_char(o.checkin, 'YYYYMM') and v.status = 'issued')
)
select 1 as 序, '① ' || coalesce(estate_name, '（沒物業）') as 項目,
       count(*) || ' 張在職・要開 ' || count(*) filter (where invoice_required) || '・不開 ' || count(*) filter (where not invoice_required)
       || '・未稅 ' || count(*) filter (where coalesce(tax_free, false)) as 內容,
       '非月繳 ' || count(*) filter (where cadence <> 'monthly') || '・收費後開 ' || count(*) filter (where invoice_required and invoice_after_paid)
       || '・沒填開票日 ' || count(*) filter (where invoice_required and invoice_day is null) as 補充
  from c group by estate_name
union all
select 2, '② 要開發票的非月繳契約',
       coalesce(string_agg(room || '・' || coalesce(invoice_title, tenant_name) || '・' || cadence || '・' || start_date || '～' || end_date, '；' order by room), '沒有'),
       count(*)::text || ' 張'
  from need where cadence <> 'monthly'
union all
select 3, '③ 已開的發票',
       count(*) || ' 張・' || coalesce(min(ym), '—') || ' ～ ' || coalesce(max(ym), '—'),
       '掛月租單 ' || count(*) filter (where o.source in ('longterm','company','office')) || '・掛加費單 ' || count(*) filter (where o.source = 'oneoff')
       || '・沒掛單 ' || count(*) filter (where v.order_id is null) || '・沒填金額 ' || count(*) filter (where v.amount is null)
  from public.invoices v left join public.orders o on o.id = v.order_id where v.status = 'issued'
union all
select 4, '④ 待開 ' || ym, count(*) || ' 張',
       '已收款 ' || count(*) filter (where paid) || '・未收 ' || count(*) filter (where not paid)
       || '・年繳約 ' || count(*) filter (where cadence = 'yearly') || '・' || string_agg(distinct estate_name, '/')
  from pend group by ym
order by 1, 2;
