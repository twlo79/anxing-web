/*
 * 只查、不改：做「提前終止契約・結算退款」之前，要先看線上三件事（2026-10-13）
 *
 *   ① 契約的營收是怎麼產的（gen_contract_recognitions 那支早期函式，repo 裡沒有原始碼）
 *   ② contracts／orders 上掛了哪些觸發器（改迄日、停用時會連帶發生什麼）
 *   ③ 周羽艾那 12 張月租單的收款是怎麼記的（一筆收款攤 12 張，還是每張各一筆）、營收認列落在哪幾個月
 *
 * ★ 一張表，「內容」那一欄比較長，整張複製貼回來就好。
 */
with ct as (select id from public.contracts where room = '6B5' and tenant_name like '%周羽艾%' limit 1)
select '① 函式：' || p.proname as 項目, pg_get_functiondef(p.oid) as 內容
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in ('gen_contract_recognitions', 'trg_contract_recognitions', 'trg_contracts_sync')
union all
select '② 觸發器：' || c.relname || '.' || t.tgname, pg_get_triggerdef(t.oid)
  from pg_trigger t join pg_class c on c.oid = t.tgrelid
 where c.relname in ('contracts', 'orders', 'order_payments') and not t.tgisinternal
union all
select '③ 收款：' || o.order_key,
       coalesce((select string_agg(coalesce(op.paid_on::text, '?') || ' ' || op.amount::text, '、' order by op.paid_on)
                   from public.order_payments op where op.order_id = o.id), '（沒有收款紀錄）')
       || '　｜ orders.paid=' || o.paid::text || ' paid_amount=' || coalesce(o.paid_amount::text, 'null')
  from public.orders o join ct on ct.id = o.contract_id
union all
select '④ 營收認列：' || r.ym,
       r.source || ' ' || r.month_amount::text || '（order_id ' || coalesce(left(r.order_id::text, 8), '—')
       || '・contract_id ' || coalesce(left(r.contract_id::text, 8), '—') || '）'
  from public.revenue_recognitions r, ct
 where r.contract_id = ct.id or r.order_id in (select o.id from public.orders o where o.contract_id = ct.id)
union all
select '⑤ 押金', coalesce(string_agg(d.kind || ' ' || coalesce(d.amount::text, '') || ' 收 ' || coalesce(d.received_on::text, '未收')
                       || ' 退狀態 ' || coalesce(d.refund_status, 'none') || coalesce(' 已退 ' || d.returned_on::text, ''), '；'), '（沒有）')
  from public.deposits d, ct where d.contract_id = ct.id
order by 1;
