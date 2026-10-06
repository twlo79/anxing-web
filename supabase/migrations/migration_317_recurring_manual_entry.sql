/* ══════════════════════════════════════════════════════════════════════
 * migration_317：定期收費改成「月結時記一筆」—— 選月份、填金額、送出                    2026-10-06
 *
 * 【為什麼】David：「為何需要觸發產生新的月份？讓填的人選新的月份，然後送出資料就好了啊」
 *   原本先產生空的月份（$0）等人填，靠排程或按鈕長出新月份 —— 營收表上一堆 $0，流程也多一步。
 *
 * 【做什麼】
 *   ① 新 RPC record_recurring(物業, 房源, 項目, 科目, 月份, 金額, 備註)：
 *      · 項目沒有就自動建（不用先「設定」）；有就用它（科目不同時更新成這次選的）
 *      · 那個月沒有就新增一筆、有就改金額 —— 同一個項目同一個月永遠只有一筆
 *      · 日期＝月底、客戶＝項目、房源＝整棟規則（migration_314）、科目＝項目的科目
 *      · 已收款的月份不改、已關帳的月份不收、金額要 > 0
 *      · 誰能用 ＝ 訂單編輯同一組（管家／會計／主管／總經理，roles.ts 的 ORDER_EDIT_ROLES）
 *   ② 不再自動產生：
 *      · 拿掉每天的排程（316 建的 recurring_orders_daily）
 *      · recurring_charges 的觸發器改成：新增不產生任何月份；改項目名稱／科目／物業／房源 → 同步到已記的月份（已收款、已關帳的不動）
 *      · ★★ 刪掉項目**不再刪任何月份** —— 記進去的就是真的收入；要拿掉某個月，到那張訂單刪
 *   ③ 清掉還沒記金額的空月份（金額 0、沒收款、沒關帳）—— 自檢列出幾筆
 *
 * ★ 已記的金額一筆都不動。
 * ★★ 自檢在 commit 後面 —— 看不到那張表就是整支回滾了。
 * ══════════════════════════════════════════════════════════ */

create temp table if not exists _cl (what text, n int) on commit preserve rows;

begin;
delete from _cl;

-- ② 排程拿掉
do $$ begin
  perform cron.unschedule(jobid) from cron.job where jobname = 'recurring_orders_daily';
exception when others then null;
end $$;

-- ② 觸發器：不再產生；只同步名稱類欄位；刪項目不刪月份
create or replace function public.trg_recurring_sync() returns trigger
 language plpgsql security definer as $fn$
declare v_pid uuid; v_praw text;
begin
  if tg_op = 'DELETE' then
    return old;      -- migration_317：記進去的月份是真的收入，項目刪了也留著
  end if;
  if tg_op = 'UPDATE' and (new.item_name, new.fee_type, new.estate_id, new.property_id)
                is distinct from (old.item_name, old.fee_type, old.estate_id, old.property_id) then
    v_pid := coalesce(new.property_id, public.recurring_whole_property(new.estate_id));
    select name into v_praw from public.properties where id = v_pid;
    update public.orders
       set item_name = new.item_name, guest_name = new.item_name, fee_type = new.fee_type,
           estate_id = new.estate_id, property_id = v_pid, property_raw = v_praw
     where imported_via = 'recurring' and order_key like 'RC_' || new.id || '_%'
       and paid = false and not public.is_period_locked(right(order_key, 6));
  end if;
  return new;
end $fn$;

-- ① 記一筆
create or replace function public.record_recurring(
  p_estate uuid, p_property uuid, p_item text, p_fee_type text, p_ym text, p_amount numeric, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare
  v_item text := btrim(coalesce(p_item, ''));
  v_rc   public.recurring_charges;
  v_o    public.orders;
  v_key  text;
  v_me   date;
  v_pid  uuid;
  v_praw text;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  k      int;
begin
  if auth.uid() is null then return jsonb_build_object('ok', false, 'message', '請重新登入'); end if;
  if coalesce(public.current_role_of(), '') not in ('housekeeper', 'accountant', 'manager', 'super_admin') then
    return jsonb_build_object('ok', false, 'message', '沒有權限記定期收費');
  end if;
  if p_estate is null then return jsonb_build_object('ok', false, 'message', '先選物業'); end if;
  if v_item = '' then return jsonb_build_object('ok', false, 'message', '先填項目'); end if;
  if coalesce(p_ym, '') !~ '^[0-9]{4}(0[1-9]|1[0-2])$' then return jsonb_build_object('ok', false, 'message', '先選月份'); end if;
  if coalesce(p_amount, 0) <= 0 then return jsonb_build_object('ok', false, 'message', '收入金額要大於 0'); end if;
  if public.is_period_locked(p_ym) then
    return jsonb_build_object('ok', false, 'message', p_ym || ' 已關帳，記不進去。要記請會計先開帳。');
  end if;

  -- 項目：同物業、同房源（都空＝整棟）、同名 → 用它；沒有就建
  select * into v_rc from public.recurring_charges
   where estate_id = p_estate and property_id is not distinct from p_property and item_name = v_item
   order by active desc limit 1;
  if not found then
    insert into public.recurring_charges (estate_id, property_id, property_raw, fee_type, item_name, amount, start_ym, active)
    values (p_estate, p_property, (select name from public.properties where id = p_property),
            coalesce(nullif(p_fee_type, ''), '清潔費'), v_item, 0, p_ym, true)
    returning * into v_rc;
  else
    if nullif(p_fee_type, '') is not null and p_fee_type <> v_rc.fee_type then
      update public.recurring_charges set fee_type = p_fee_type where id = v_rc.id returning * into v_rc;
    end if;
    if not v_rc.active then
      update public.recurring_charges set active = true where id = v_rc.id returning * into v_rc;
    end if;
  end if;

  v_pid := coalesce(v_rc.property_id, public.recurring_whole_property(v_rc.estate_id));
  select name into v_praw from public.properties where id = v_pid;
  v_key := 'RC_' || v_rc.id || '_' || p_ym;
  v_me  := (to_date(p_ym || '01', 'YYYYMMDD') + interval '1 month' - interval '1 day')::date;

  select * into v_o from public.orders where order_key = v_key;
  if found then
    if v_o.paid then
      return jsonb_build_object('ok', false, 'message', v_item || ' ' || p_ym || ' 已收款，金額不能改。要改請先取消收款。');
    end if;
    update public.orders
       set amount = p_amount, note = coalesce(v_note, note),
           checkin = v_me, checkout = v_me, guest_name = v_rc.item_name, item_name = v_rc.item_name,
           fee_type = v_rc.fee_type, estate_id = v_rc.estate_id, property_id = v_pid, property_raw = v_praw
     where id = v_o.id;
    get diagnostics k = row_count;
    if k <> 1 then raise exception '沒存到（多半是權限）'; end if;
    return jsonb_build_object('ok', true, 'updated', true, 'rc_id', v_rc.id,
      'message', format('已改 %s %s：$%s', v_item, p_ym, to_char(p_amount, 'FM999,999,999')));
  end if;

  insert into public.orders (order_key, source, estate_id, property_id, property_raw, guest_name,
    checkin, checkout, nights, amount, deposit, fee_type, item_name, note, imported_via, paid)
  values (v_key, 'oneoff', v_rc.estate_id, v_pid, v_praw, v_rc.item_name,
    v_me, v_me, 0, p_amount, 0, v_rc.fee_type, v_rc.item_name, v_note, 'recurring', false);
  return jsonb_build_object('ok', true, 'updated', false, 'rc_id', v_rc.id,
    'message', format('已記 %s %s：$%s', v_item, p_ym, to_char(p_amount, 'FM999,999,999')));
end $fn$;
comment on function public.record_recurring(uuid, uuid, text, text, text, numeric, text) is
  '定期收費記一筆：項目沒有就建、那個月沒有就新增有就改金額（同項目同月只有一筆）。日期月底、客戶＝項目。'
  '已收款不改、已關帳不收、金額 > 0。管家／會計／主管／總經理。migration_317。';
revoke all on function public.record_recurring(uuid, uuid, text, text, text, numeric, text) from public;
grant execute on function public.record_recurring(uuid, uuid, text, text, text, numeric, text) to authenticated;

-- ③ 清掉空月份
with d as (
  delete from public.orders
   where imported_via = 'recurring' and coalesce(amount, 0) = 0 and paid = false
     and not public.is_period_locked(right(order_key, 6))
  returning 1)
insert into _cl select '刪掉的空月份（金額 0、沒收款）', count(*) from d;

do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('317_recurring_manual_entry');
  end if;
end $do$;

commit;

-- ═══ 自檢（在 commit 後面 —— 看不到那張表就是整支回滾了） ═══════════
select 1 as 序, '每天的自動產生排程拿掉了' as 檢查,
       case when exists (select 1 from cron.job where jobname = 'recurring_orders_daily') then '★ 還在' else '拿掉了' end as 結果,
       case when exists (select 1 from cron.job where jobname = 'recurring_orders_daily') then '❌' else '✅' end as 判定
union all
select 2, '記一筆的函式在',
       coalesce((select 'record_recurring・' || case when prosecdef then 'definer' else 'invoker' end
                   from pg_proc where proname = 'record_recurring' limit 1), '★ 沒有'),
       case when exists (select 1 from pg_proc where proname = 'record_recurring') then '✅' else '❌' end
union all
select 3, '觸發器新版（刪項目不刪月份）',
       case when pg_get_functiondef('public.trg_recurring_sync()'::regprocedure) like '%migration_317%' then '新版' else '★ 舊的' end,
       case when pg_get_functiondef('public.trg_recurring_sync()'::regprocedure) like '%migration_317%' then '✅' else '❌' end
union all
select 4, (select what from _cl), (select n::text || ' 筆' from _cl), 'ℹ'
union all
select 5, '還留著的定期收費月份（有金額的，參考）',
       (select count(*) || ' 筆・$' || to_char(coalesce(sum(amount), 0), 'FM999,999,999') from public.orders where imported_via = 'recurring'),
       'ℹ'
order by 1;
