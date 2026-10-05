/* ══════════════════════════════════════════════════════════════════════
 * migration_313：調價費支出 —— 無條件進位、自動帶付款方式與帳戶                       2026-10-05
 *
 * 【為什麼】David：「1.5% 計算無條件進位」「付款方式 自動繳款，帳戶 4145（正隆）／8088（非正隆）」
 *
 * 【做什麼】只換 gen_pricing_fees() 一支（預覽與產生同一支，公式還是只有一份）：
 *   · 金額 ＝ ceil(訂單 × 1.5%)　例：32,268 × 1.5% = 484.02 → 485
 *   · payment_method ＝ autopay（自動繳款）
 *   · pay_account ＝ 物業是「正隆」→ 4145，其他 → 8088
 *   · 預覽每一列多回 pay_account（畫面的「付款」欄與分帳戶小計讀它）
 *   · 4145／8088 任一個代號查不到 → 不產生、回原因（不會寫出沒有帳戶的支出）
 *
 * ★ 已經產生過的批次**不動**（還是四捨五入、沒有付款帳戶）。要換新算法：歷史紀錄撤銷那一批，再重新產生。
 * ★ 只有 Airbnb 能產生 —— 312 就擋了，這支沿用。
 * ★★ 自檢在 commit 後面 —— 看不到那張表就是整支回滾了。
 * ══════════════════════════════════════════════════════════ */

begin;

-- ④ 預覽＋產生（同一支，公式只有一份）
create or replace function public.gen_pricing_fees(p_order_ids uuid[], p_dry boolean default true)
returns jsonb language plpgsql as $fn$
declare
  v_rate  numeric;
  v_batch uuid;
  v_rows  jsonb := '[]'::jsonb;
  v_skip  jsonb := '[]'::jsonb;
  v_n     int := 0;
  v_total numeric := 0;
  v_yms   text[] := '{}';
  o       record;
  why     text;
  amt     numeric;
  k       int;
  v_acct  text;
  v_zl    uuid;
begin
  if auth.uid() is null then
    return jsonb_build_object('ok', false, 'message', '請重新登入');
  end if;
  if p_order_ids is null or cardinality(p_order_ids) = 0 then
    return jsonb_build_object('ok', false, 'message', '先勾訂單');
  end if;
  select coalesce(pricing_fee_rate, 0.015) into v_rate from public.work_settings where id = 1;
  v_rate := coalesce(v_rate, 0.015);
  -- 付款帳戶：正隆 → 4145，其他 → 8088（migration_313）。兩個代號都要在，不然整支不產生
  if (select count(*) from public.payment_accounts where code in ('4145', '8088')) <> 2 then
    return jsonb_build_object('ok', false, 'message', '付款帳戶 4145 或 8088 找不到 —— 先到帳戶管理確認代號');
  end if;
  select id into v_zl from public.estates where name = '正隆' limit 1;

  if not p_dry then
    -- 先預覽一次：一張都不能產生的話，連批次都不要建（回原因，不丟錯）
    if ((public.gen_pricing_fees(p_order_ids, true))->>'n')::int = 0 then
      return public.gen_pricing_fees(p_order_ids, true);
    end if;
    insert into public.pricing_fee_batches default values returning id into v_batch;
  end if;

  for o in
    select x.* from public.orders x where x.id = any(p_order_ids) order by x.checkin, x.property_raw
  loop
    -- 無條件進位（migration_313）。先 round 到 6 位，避免浮點尾數把剛好整除的多進 1
    amt := ceil(round(coalesce(o.amount, 0) * v_rate, 6));
    v_acct := case when o.estate_id = v_zl then '4145' else '8088' end;
    why := case
      when o.source is distinct from 'airbnb' then '不是 Airbnb 訂單'
      when coalesce(o.amount, 0) <= 0 then '訂單金額是 0'
      when o.checkin is null then '沒有入住日'
      when o.estate_id is null then '沒有物業'
      when amt <= 0 then '金額太小，算出來是 0'
      when public.is_period_locked(to_char(o.checkin, 'YYYYMM')) then to_char(o.checkin, 'YYYYMM') || ' 已關帳'
      when exists (select 1 from public.expenses e where e.auto_key = 'pricing:order:' || o.id) then '已經產生過'
      else null end;
    if why is not null then
      v_skip := v_skip || jsonb_build_object('order_id', o.id, 'order_key', o.order_key, 'room', o.property_raw,
                                             'guest', o.guest_name, 'checkin', o.checkin, 'why', why);
      continue;
    end if;

    if not p_dry then
      insert into public.expenses
        (spent_on, item_name, amount, account_code, purpose_type, estate_id, property_id, note, auto_key, pricing_batch_id,
         payment_method, pay_account)
      values
        (o.checkin, '調價軟體 ' || coalesce(nullif(o.property_raw, ''), o.order_key), amt, 'service', 'estate',
         o.estate_id, o.property_id,
         'Airbnb ' || o.order_key || '・' || coalesce(nullif(o.guest_name, ''), '—') || '・'
           || to_char(o.checkin, 'YYYY-MM-DD') || '～' || coalesce(to_char(o.checkout, 'YYYY-MM-DD'), '?')
           || '・訂單 ' || to_char(round(o.amount), 'FM999,999,999') || ' × '
           || rtrim(rtrim((v_rate * 100)::text, '0'), '.') || '%',
         'pricing:order:' || o.id, v_batch,
         'autopay', v_acct);
      get diagnostics k = row_count;
      if k <> 1 then raise exception '支出沒有寫進去（多半是權限）—— 這一批全部退回'; end if;
    end if;

    v_n := v_n + 1; v_total := v_total + amt;
    if not (to_char(o.checkin, 'YYYYMM') = any(v_yms)) then v_yms := v_yms || to_char(o.checkin, 'YYYYMM'); end if;
    v_rows := v_rows || jsonb_build_object('order_id', o.id, 'spent_on', o.checkin,
                'item', '調價軟體 ' || coalesce(nullif(o.property_raw, ''), o.order_key),
                'estate_id', o.estate_id, 'amount', amt, 'pay_account', v_acct);
  end loop;

  if not p_dry then
    if v_n = 0 then
      raise exception '勾的訂單一張都不能產生 —— 什麼都沒寫';
    end if;
    update public.pricing_fee_batches
       set n = v_n, total = v_total,
           yms = (select string_agg(y, '、' order by y desc) from unnest(v_yms) y)
     where id = v_batch;
  end if;

  return jsonb_build_object('ok', v_n > 0, 'dry', p_dry, 'batch_id', v_batch,
    'n', v_n, 'total', v_total, 'rate', v_rate, 'rows', v_rows, 'skipped', v_skip,
    'message', case when v_n = 0 then '勾的訂單一張都不能產生'
                    when p_dry then format('會產生 %s 筆，合計 %s', v_n, to_char(v_total, 'FM999,999,999'))
                    else format('已產生 %s 筆調價支出，合計 %s', v_n, to_char(v_total, 'FM999,999,999')) end);
end $fn$;
comment on function public.gen_pricing_fees(uuid[], boolean) is
  '調價軟體支出：p_dry=true 只預覽，false 寫成一批。一張訂單一筆、日期＝入住日、金額＝訂單×費率（無條件進位）、付款＝自動繳款（正隆 4145／其他 8088）；'
  '不能產生的跳過並回原因。security invoker（支出 RLS 照舊）。migration_312，313 改進位與付款帳戶。';
grant execute on function public.gen_pricing_fees(uuid[], boolean) to authenticated;

do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('313_pricing_fee_ceil_autopay');
  end if;
end $do$;

commit;

-- ═══ 自檢（在 commit 後面 —— 看不到那張表就是整支回滾了） ═══════════
select 1 as 序, '無條件進位：32,268 × 1.5%（要 485）' as 檢查,
       ceil(round(32268 * 0.015, 6))::text as 結果,
       case when ceil(round(32268 * 0.015, 6)) = 485 then '✅' else '❌' end as 判定
union all
select 2, '函式換成新版（有 ceil、有 autopay）',
       case when pg_get_functiondef('public.gen_pricing_fees(uuid[], boolean)'::regprocedure) like '%ceil(%'
             and pg_get_functiondef('public.gen_pricing_fees(uuid[], boolean)'::regprocedure) like '%autopay%' then '新版' else '★ 還是舊的' end,
       case when pg_get_functiondef('public.gen_pricing_fees(uuid[], boolean)'::regprocedure) like '%ceil(%'
             and pg_get_functiondef('public.gen_pricing_fees(uuid[], boolean)'::regprocedure) like '%autopay%' then '✅' else '❌' end
union all
select 3, '付款帳戶 4145、8088 都查得到',
       coalesce((select string_agg(code || ' ' || coalesce(name, ''), '、' order by code) from public.payment_accounts where code in ('4145', '8088')), '★ 都沒有'),
       case when (select count(*) from public.payment_accounts where code in ('4145', '8088')) = 2 then '✅' else '❌' end
union all
select 4, '物業「正隆」查得到（它的訂單走 4145）',
       (select count(*)::text || ' 筆' from public.estates where name = '正隆'),
       case when exists (select 1 from public.estates where name = '正隆') then '✅' else '❌ 全部會走 8088' end
union all
select 5, '已產生、還是舊算法的調價支出（參考 —— 要換就撤銷重產）',
       (select count(*) || ' 筆' from public.expenses where auto_key like 'pricing:order:%' and pay_account is null),
       'ℹ'
order by 1;
