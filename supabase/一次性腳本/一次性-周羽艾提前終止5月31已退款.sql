/*
 * 一次性：6B5 周羽艾 提前終止結算 —— 5/31 退租、錢 5/31 已經退了，補登，不走請款審核（2026-10-13）
 *
 * 【David】「這是 5/31 的，就不用寫請款了，可以幫我直接處理嗎」
 *
 * 【這支做什麼】跟按「提前終止契約・結算退款」同一支函式（terminate_contract_settle，migration_331），然後：
 *   · 退款那一列直接標「已核可」＋「已匯出 5/31」—— 不會出現在請款審核頁
 *   · 契約：迄日 2026-05-31、停用、營收補回 2～5 月（共 441,000）；6 月以後的月租單刪掉
 *   · 沒收 0（全退）→ 不會產生其他收入
 *
 * 【金額照你畫面上選的「全退」】預收沒住 882,000 ＋ 押金 210,000 ＝ 退 1,092,000。
 *   ★ 實際退的不是這樣的話，改下面 ① 那三個數字再跑（沒收的部分會記成其他收入）。
 *
 * 【跑之前】2026-02 ～ 2026-05 要先開帳（營收補回那幾個月）。沒開的話會直接停下來、講是哪幾個月，什麼都不會改。
 *
 * ★ SQL Editor 沒有登入身分 —— 這支用總經理的身分去呼叫函式（跟你在畫面上按是同一件事）。
 * ★★ 自檢在 commit 後面 —— 看不到那張表就是整支回滾了。
 */

begin;

do $do$
declare
  -- ① 照實際填
  v_end          date    := '2026-05-31';   -- 終止日（最後一天）
  v_rent_forfeit numeric := 0;              -- 沒收的預收租金（全退＝0）
  v_dep_forfeit  numeric := 0;              -- 沒收的押金（全退＝0）
  v_returned_on  date    := '2026-05-31';   -- 錢實際退出去那天

  c   public.contracts;
  me  uuid;
  r   jsonb;
  did uuid;
  k   int;
begin
  select * into c from public.contracts
   where room = '6B5' and tenant_name like '%周羽艾%' and terminated_on is null
   limit 1;
  if not found then
    raise exception '找不到還沒終止的 6B5 周羽艾契約 —— 可能已經結算過了，看下面自檢表';
  end if;

  select id into me from public.profiles where role = 'super_admin' limit 1;
  if me is null then raise exception '找不到總經理的帳號'; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', me, 'role', 'authenticated')::text, true);

  r := public.terminate_contract_settle(
         c.id, v_end, v_rent_forfeit, v_dep_forfeit, '雙方協議解約',
         '周羽艾', null, '（' || to_char(v_returned_on, 'MM/DD') || ' 已退，補登）',
         v_returned_on, null, null);
  if not coalesce((r->>'ok')::boolean, false) then
    raise exception '沒結算：%', r->>'message';
  end if;

  -- 退款：已經退了 → 直接標已核可＋已匯出（不進請款審核）
  select (terminate_settle->>'deposit_id')::uuid into did from public.contracts where id = c.id;
  if did is not null and coalesce((r->>'refund')::numeric, 0) > 0 then
    update public.deposits
       set refund_status = 'approved',
           manager_approved_by = me, manager_approved_at = now(),
           admin_approved_by = me, admin_approved_at = now(),
           returned_on = v_returned_on,
           note = coalesce(note || '；', '') || '提前終止退款 ' || to_char(v_returned_on, 'YYYY-MM-DD') || ' 已匯出（補登，沒走請款審核）'
     where id = did;
    get diagnostics k = row_count;
    if k <> 1 then raise exception '押金那一列沒有更新'; end if;
  end if;
end $do$;

commit;

-- ══════ 自檢（看不到這張表就是整支回滾了）══════
with c as (select * from public.contracts where room = '6B5' and tenant_name like '%周羽艾%' limit 1)
select 1 as 序, '契約' as 項目,
       '迄日 ' || c.end_date || '・' || case when c.active then '使用中' else '停用' end
       || '・終止日 ' || coalesce(c.terminated_on::text, '（沒有）') as 結果,
       case when c.terminated_on = '2026-05-31' and c.end_date = '2026-05-31' then '✅' else '❌' end as 判定
  from c
union all
select 2, '結算', coalesce(c.terminate_settle->>'status', '—') || '・退 ' || coalesce(c.terminate_settle->>'refund', '—')
       || '（租金 ' || coalesce(c.terminate_settle->>'rent_refund', '—') || '＋押金 ' || coalesce(c.terminate_settle->>'dep_refund', '—') || '）',
       case when c.terminate_settle->>'status' = 'done' then '✅' else '❌' end
  from c
union all
select 3, '營收補回（應該 4 個月、441,000）',
       count(r.*)::text || ' 個月・' || coalesce(to_char(sum(r.month_amount), 'FM999,999,990'), '0'),
       case when count(r.*) = 4 and sum(r.month_amount) = 441000 then '✅' else 'ℹ 看一下' end
  from c left join public.revenue_recognitions r on r.contract_id = c.id
union all
select 4, '剩下的月租單（應該 2～5 月 4 張，收款 1,323,000 還在 2 月那張）',
       count(o.*)::text || ' 張・' || coalesce(string_agg(to_char(o.checkin, 'MM'), '、' order by o.checkin), '')
       || '・已收合計 ' || coalesce(to_char(sum(o.paid_amount), 'FM999,999,990'), '0'),
       case when count(o.*) = 4 and sum(o.paid_amount) = 1323000 then '✅' else 'ℹ 看一下' end
  from c left join public.orders o on o.contract_id = c.id and o.imported_via = 'contract'
union all
select 5, '押金那一列（退款）',
       coalesce(string_agg('退 ' || d.refund_amount || '・' || d.refund_status || '・匯出 ' || coalesce(d.returned_on::text, '（沒有）'), '；'), '（沒有）'),
       case when bool_and(d.returned_on is not null and d.refund_status = 'approved') then '✅' else '❌' end
  from c join public.deposits d on d.terminate_contract_id = c.id
order by 1;
