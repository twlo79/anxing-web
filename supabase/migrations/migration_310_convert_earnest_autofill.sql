/* ══════════════════════════════════════════════════════════════════════
 * migration_310：訂金轉押金 —— 訂單還沒填押金，就把押金設成訂金金額                      2026-10-02
 *
 * 【為什麼】309 之後，雪雪那兩張訂單按「轉押金」會跳「請先到短租訂單把押金金額填上」。
 *   David：「沒自動填入押金金額」。
 *
 * 【改了什麼】convert_earnest 只多一段：
 *   掛在訂單上、訂單還沒有押金那一列、訂金是台幣 →
 *   先把 orders.deposit 設成訂金金額（sync_order_deposits 會長出押金那一列），再照常轉。
 *   結果：押金 ＝ 訂金，整筆轉過去、押金收齊。之後要改押金，回短租訂單改。
 *
 * ★ 契約不這樣做：contracts.deposit 一改，契約那幾支同步都會跟著動 —— 那邊照舊請人先回契約填。
 * ★ 外幣訂金不這樣做：orders.deposit 是台幣欄位。
 * ★ 訂單已經有押金（即使金額跟訂金不同）就用它，不覆蓋。
 * ★ 其餘照 309 逐字搬；四步（含設押金）同一個交易，任一步失敗全部退回。
 *
 * ★★ 自檢在 commit 後面 —— 看不到那張表就是整支回滾了。
 * ══════════════════════════════════════════════════════════ */

begin;

create or replace function public.convert_earnest(p_dep uuid, p_on date)
returns jsonb language plpgsql as $fn$
declare
  d        public.deposits;
  t        public.deposits;
  n        int;
  uid      uuid := auth.uid();
  transfer numeric;
  covered  numeric;
  remaining numeric;
  host     text;
begin
  if uid is null then
    return jsonb_build_object('ok', false, 'code', 'NO_AUTH', 'message', '請重新登入');
  end if;
  if p_on is null then p_on := (now() at time zone 'Asia/Taipei')::date; end if;

  select * into d from public.deposits where id = p_dep;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'message', '找不到這筆訂金（可能剛被別人刪了）');
  end if;
  if d.kind <> 'earnest' then
    return jsonb_build_object('ok', false, 'code', 'NOT_EARNEST', 'message', '這一筆不是訂金');
  end if;
  if d.converted_to_deposit_id is not null then
    return jsonb_build_object('ok', false, 'code', 'ALREADY', 'message', '這筆訂金已經轉過押金了。');
  end if;
  if d.forfeit_order_id is not null then
    return jsonb_build_object('ok', false, 'code', 'FORFEITED', 'message', '這筆訂金已經沒收了，不能再轉押金。');
  end if;
  if d.returned_on is not null then
    return jsonb_build_object('ok', false, 'code', 'RETURNED', 'message', '這筆訂金已經退了，不能再轉押金。');
  end if;

  -- 押金那一列：契約優先（同幣別），其次訂單（一張單一列）
  if d.contract_id is not null then
    host := 'contract';
    select * into t from public.deposits
     where contract_id = d.contract_id and kind = 'deposit' and currency = d.currency
     order by created_at limit 1;
  elsif d.order_id is not null then
    host := 'order';
    select * into t from public.deposits
     where order_id = d.order_id and kind = 'deposit'
     order by created_at limit 1;
  else
    return jsonb_build_object('ok', false, 'code', 'NO_HOST',
      'message', '這筆訂金沒有掛在契約或訂單上，無法轉押金。');
  end if;
  -- ★ 310：訂單還沒有押金 → 押金設成訂金金額（只限台幣）
  if t.id is null and host = 'order' and upper(coalesce(d.currency, 'TWD')) = 'TWD'
     and coalesce(d.amount, 0) > 0 then
    update public.orders set deposit = d.amount where id = d.order_id;
    get diagnostics n = row_count;
    if n <> 1 then raise exception '訂單的押金沒有設進去（多半是權限）—— 什麼都沒寫進去'; end if;
    select * into t from public.deposits
     where order_id = d.order_id and kind = 'deposit'
     order by created_at limit 1;
    if t.id is null then raise exception '設了訂單押金，但押金那一列沒有長出來 —— 什麼都沒寫進去'; end if;
  end if;
  if t.id is null then
    return jsonb_build_object('ok', false, 'code', 'NO_DEPOSIT',
      'message', case host when 'contract'
        then '這張契約還沒有押金 —— 請先回契約把押金金額填上，再回來轉。'
        else '這張訂單還沒有押金 —— 請先到短租訂單把押金金額填上，再回來轉。' end);
  end if;

  transfer := greatest(0, coalesce(d.amount, 0));
  covered  := greatest(0, coalesce(t.received_amount, 0)) + transfer;
  remaining := greatest(0, coalesce(t.amount, 0) - covered);

  -- ① 押金記一筆收款（method = 'earnest_in'）
  insert into public.deposit_payments (deposit_id, paid_on, amount, method, note, created_by)
  values (t.id, p_on, transfer, 'earnest_in',
          format('訂金轉入（%s）', coalesce(nullif(d.guest_name, ''), d.room, '訂金')), uid);
  get diagnostics n = row_count;
  if n <> 1 then raise exception '押金的收款沒有記進去（多半是權限）—— 什麼都沒寫進去'; end if;

  -- ② 押金那一列：補 received_on（已有值不覆蓋）＋ 記來源
  update public.deposits
     set received_on = coalesce(received_on, p_on),
         converted_from_earnest_id = d.id
   where id = t.id;
  get diagnostics n = row_count;
  if n <> 1 then raise exception '押金那一列沒有更新（多半是權限）—— 收款也一起退回'; end if;

  -- ③ 訂金結案
  update public.deposits
     set converted_to_deposit_id = t.id, converted_by = uid, converted_at = now()
   where id = d.id;
  get diagnostics n = row_count;
  if n <> 1 then raise exception '訂金狀態沒有更新（多半是權限）—— 前面兩步一起退回'; end if;

  return jsonb_build_object('ok', true, 'code', 'OK', 'deposit_id', t.id,
    'transfer', transfer, 'remaining', remaining, 'settled', (remaining = 0 and coalesce(t.amount,0) > 0),
    'message', case when remaining = 0 and coalesce(t.amount,0) > 0 then '已轉押金，押金收齊了'
                    else format('已轉押金，押金尚欠 NT$ %s', to_char(remaining, 'FM999,999,999')) end);
end $fn$;
comment on function public.convert_earnest(uuid, date) is
  '訂金轉押金：記收款 ＋ 補押金欄位 ＋ 訂金結案，一個交易（292）。309 起掛在訂單上的訂金也能轉；310 起訂單還沒填押金時，押金設成訂金金額（台幣）。';
grant execute on function public.convert_earnest(uuid, date) to authenticated;

do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('310_convert_earnest_autofill');
  end if;
end $do$;

commit;

-- ═══ 自檢（在 commit 後面 —— 看不到那張表就是整支回滾了） ═══════════
select 1 as 序, '這支跑過了沒（schema_migrations）' as 檢查,
       coalesce((select name from public.schema_migrations where name = '310_convert_earnest_autofill'), '（沒記到）') as 結果,
       case when exists (select 1 from public.schema_migrations where name = '310_convert_earnest_autofill') then '✅' else '❌' end as 判定
union all
select 2, 'convert_earnest 會幫訂單填押金',
       case when (select pg_get_functiondef(p.oid) from pg_proc p join pg_namespace s on s.oid = p.pronamespace
                   where s.nspname = 'public' and p.proname = 'convert_earnest' and p.prokind in ('f','p')) ~ 'set deposit = d\.amount'
            then '有' else '沒有' end,
       case when (select pg_get_functiondef(p.oid) from pg_proc p join pg_namespace s on s.oid = p.pronamespace
                   where s.nspname = 'public' and p.proname = 'convert_earnest' and p.prokind in ('f','p')) ~ 'set deposit = d\.amount'
            then '✅' else '❌' end
union all
select 3, '★ 還是 security invoker（RLS 照舊）',
       (select case when prosecdef then 'definer' else 'invoker' end from pg_proc where proname = 'convert_earnest'),
       case when (select not prosecdef from pg_proc where proname = 'convert_earnest') then '✅' else '❌ 變 definer 了' end
union all
select 4, '掛在訂單上、還沒轉的訂金（現在可以轉了）',
       coalesce((select string_agg(coalesce(d.room, '?') || ' ' || coalesce(d.guest_name, '') || ' $' || to_char(d.amount, 'FM999,999,999')
                   || '・押金 ' || coalesce((select '$' || to_char(t.amount, 'FM999,999,999') from public.deposits t
                                              where t.order_id = d.order_id and t.kind = 'deposit' limit 1), '還沒填 → 轉的時候設成 $' || to_char(d.amount, 'FM999,999,999')),
                   '／' order by d.room)
                   from public.deposits d
                  where d.kind = 'earnest' and d.contract_id is null and d.order_id is not null
                    and d.received_on is not null and d.converted_to_deposit_id is null
                    and d.forfeit_order_id is null and d.returned_on is null), '（沒有）'),
       'ℹ 到暫收款按「轉押金」就好，不用先填'
order by 1;
