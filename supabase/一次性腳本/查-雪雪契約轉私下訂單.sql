/*
 * 查-雪雪契約轉私下訂單.sql　2026-09-15
 * 轉之前先看清楚那兩張契約底下**還掛著什麼**
 *
 * 【怎麼跑】整份貼進 Supabase SQL Editor，把出來的表整個貼回來給我。
 *          ★ 這支**一個字都不會改**。只有 select。
 *
 * ══════════════════════════════════════════════════════════
 * 【為什麼不直接寫轉檔的那支】
 *
 * 契約不是孤單的一列。它底下可能有:
 *
 *   月租單（`gen_contract_orders` 產的 LT_…）——  有的話可能已經收過款
 *   收款紀錄（`order_payments`）　　　　　　  ——  收過就動到帳
 *   營收認列（`revenue_recognitions`）　　　  ——  已經進報表
 *   契約固定加費、發票紀錄
 *   已關帳的月份　　　　　　　　　　　　　  ——  改不動（migration_249~251）
 *
 * ★★★ 這幾樣任何一樣有東西，「刪契約、開訂單」就不是搬家而是**弄丟一段帳**。
 *   而弄丟的時候不會報錯 —— 報表上的數字只是變小，沒有人說得出少了什麼。
 *
 * ★ 所以先看，再寫改的那支。看到的東西決定那支要多做什麼:
 *   有月租單就要一起處理、有收款就要先確認那筆錢算哪一張單。
 * ══════════════════════════════════════════════════════════
 */

with c as (
  select * from public.contracts
   where room in ('14B1', '14B3')
     and coalesce(display_name, tenant_name) like '%雪雪%'
)

select v.ord, v."看什麼", v."內容" from (

  /* ① 契約本身 */
  select 1 as ord, '① 契約' as "看什麼",
         c.room || '　' || coalesce(c.display_name, c.tenant_name, '?')
           || '　' || coalesce(c.start_date::text, '?') || ' ~ ' || coalesce(c.end_date::text, '?')
           || '　每期 $' || coalesce(c.amount_per_period, 0)
           || '　' || coalesce(c.cadence, '?')
           || '　啟用=' || coalesce(c.active::text, '?')
           || '　訂金階段=' || coalesce(c.earnest_only::text, '?')
           || '　id=' || left(c.id::text, 8) as "內容"
    from c

  union all
  /* ② 這張契約產生的訂單 —— 有幾張、收了沒 */
  select 2, '② 底下的訂單',
         o.order_key || '　' || o.checkin || '~' || o.checkout
           || '　$' || o.amount
           || '　已收=' || o.paid::text
           || '　來源=' || o.source
           || '　產生方式=' || coalesce(o.imported_via, '')
    from public.orders o join c on c.id = o.contract_id

  union all
  select 3, '②b 訂單一張都沒有',
         '（沒有月租單 —— 那就只是一張契約加訂金，搬起來單純）'
   where not exists (select 1 from public.orders o join c on c.id = o.contract_id)

  union all
  /* ③ 收款紀錄 —— 有的話那筆錢已經在帳上 */
  select 4, '③ 收款紀錄',
         p.paid_on::text || '　$' || p.amount
           || '　' || coalesce(p.method, '?') || '　' || coalesce(p.account, '')
    from public.order_payments p
    join public.orders o on o.id = p.order_id
    join c on c.id = o.contract_id

  union all
  select 5, '③b 沒有收款紀錄', '（月租單一毛都還沒收）'
   where not exists (
     select 1 from public.order_payments p
      join public.orders o on o.id = p.order_id join c on c.id = o.contract_id)

  union all
  /* ④ 營收認列 —— 已經進報表的部分 */
  select 6, '④ 營收認列',
         r.ym || '　$' || r.month_amount || '　' || coalesce(r.purpose_type, '')
    from public.revenue_recognitions r
    join public.orders o on o.id = r.order_id
    join c on c.id = o.contract_id

  union all
  select 7, '④b 沒有營收認列', '（還沒進報表）'
   where not exists (
     select 1 from public.revenue_recognitions r
      join public.orders o on o.id = r.order_id join c on c.id = o.contract_id)

  union all
  /* ⑤ 訂金與押金 —— 要搬的就是這幾筆 */
  select 8, '⑤ 訂金／押金',
         coalesce(d.kind, 'deposit')
           || '　' || coalesce(d.room, '?') || '　' || coalesce(d.guest_name, '?')
           || '　應收 $' || d.amount
           || '　已收 $' || coalesce(d.received_amount, 0)
           || '　收款日=' || coalesce(d.received_on::text, '—')
           || '　退款日=' || coalesce(d.returned_on::text, '—')
           || '　掛在=' || case when d.order_id is not null then '訂單'
                                when d.contract_id is not null then '契約' else '（都沒掛）' end
           || '　id=' || left(d.id::text, 8)
    from public.deposits d join c on c.id = d.contract_id

  union all
  /* ⑥ 契約固定加費（設定，不是產生出來的費用單） */
  select 9, '⑥ 固定加費',
         f.fee_type || coalesce('－' || f.item_name, '') || '　$' || f.amount
           || '　啟用=' || coalesce(f.active::text, '?')
    from public.contract_recurring_charges f join c on c.id = f.contract_id

  union all
  select 10, '⑥b 沒有固定加費', '（沒有）'
   where not exists (
     select 1 from public.contract_recurring_charges f join c on c.id = f.contract_id)

  union all
  /* ⑦ 發票 */
  select 11, '⑦ 發票', v2.ym || '　' || v2.invoice_no || '　' || v2.invoice_date::text
    from public.invoices v2 join c on c.id = v2.contract_id

  union all
  select 12, '⑦b 沒有發票', '（沒有）'
   where not exists (select 1 from public.invoices v2 join c on c.id = v2.contract_id)

  union all
  /*
   * ⑧ ★★★ 已關帳的月份。
   *   落在關帳月份裡的東西改不動（migration_249~251），
   *   而「改不動」在轉檔那支會變成**一半搬過去、一半留在原地**。
   */
  select 13, '⑧ 關帳月份', l.ym
    from public.period_lock l
   where l.ym >= '202606'

  union all
  select 14, '⑨ 同名同房的既有訂單（避免重複開單）',
         o.order_key || '　' || o.source || '　' || o.checkin || '~' || o.checkout || '　$' || o.amount
    from public.orders o
   where o.property_raw in ('14B1', '14B3')
     and coalesce(o.guest_name, '') like '%雪雪%'
     and o.contract_id is null

) as v(ord, "看什麼", "內容")
order by v.ord, v."內容";
