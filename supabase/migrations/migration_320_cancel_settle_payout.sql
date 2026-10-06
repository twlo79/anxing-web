/* ══════════════════════════════════════════════════════════════════════
 * migration_320：取消結算 —— 送審時一起填安幸出款帳號、預計退款日；確認匯款後結算標完成        2026-10-06
 *
 * 【為什麼】David：「這邊做分隔，然後最後有安幸出款帳號、預計退款日可以填；確認匯款後押金變到已退」
 *
 * 【做什麼】
 *   ① cancel_order_settle() 多三個參數：預計退款日、安幸出款方式、安幸出款帳號 → 寫到押金那一列
 *      （跟一般退款申請同一組欄位 planned_refund_on / returned_method / returned_account，請款審核頁照舊看得到、照舊可改）
 *   ② 押金確認匯款（returned_on 填上）時，訂單的取消結算標 done、記 returned_on
 *      押金本身照原本的規則變「已退款」—— 不用另外做
 *   舊簽名的函式拿掉（兩個同名不同參數的留著，前端呼叫會對不到）
 *
 * ★★ 自檢在 commit 後面 —— 看不到那張表就是整支回滾了。
 * ══════════════════════════════════════════════════════════ */

begin;

drop function if exists public.cancel_order_settle(uuid, numeric, text, text, text, text);

-- ④ 取消結算
create or replace function public.cancel_order_settle(
  p_order uuid, p_forfeit numeric, p_reason text,
  p_payee_name text default null, p_payee_bank_code text default null, p_payee_account text default null,
  p_planned_on date default null, p_returned_method text default null, p_returned_account text default null)
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare
  uid   uuid := auth.uid();
  o     public.orders;
  d     public.deposits;
  today date := (now() at time zone 'Asia/Taipei')::date;
  dep_avail numeric := 0;
  paid  numeric := 0;
  total numeric;
  fo    numeric := round(coalesce(p_forfeit, -1));
  refund numeric;
  path  text;
  st    jsonb;
  fid   uuid;
  ym    text;
  k     int;
begin
  if uid is null then return jsonb_build_object('ok', false, 'message', '請重新登入'); end if;
  if coalesce(public.current_role_of(), '') not in ('housekeeper', 'accountant', 'manager', 'super_admin') then
    return jsonb_build_object('ok', false, 'message', '沒有權限取消訂單');
  end if;

  select * into o from public.orders where id = p_order for update;
  if not found then return jsonb_build_object('ok', false, 'message', '找不到這張訂單（可能剛被刪了）'); end if;
  if o.source <> 'private' then
    return jsonb_build_object('ok', false, 'message', '只有私下訂單在這裡取消結算 —— Airbnb／Agoda 的取消照平台同步');
  end if;
  st := coalesce(o.cancel_settle, '{}'::jsonb);
  if o.cancelled_on is not null and coalesce(st->>'status', '') <> 'rejected' then
    return jsonb_build_object('ok', false, 'message', '這張訂單已經取消結算過了');
  end if;

  -- 關帳：今天（沒入入帳的月份）與訂單住宿的月份
  if public.is_period_locked(to_char(today, 'YYYYMM')) then
    return jsonb_build_object('ok', false, 'message', to_char(today, 'YYYYMM') || ' 已關帳，結算不了。要做請會計先開帳。');
  end if;
  if o.checkin is not null then
    ym := to_char(o.checkin, 'YYYYMM');
    while ym <= to_char(coalesce(o.checkout - 1, o.checkin), 'YYYYMM') loop
      if public.is_period_locked(ym) then
        return jsonb_build_object('ok', false, 'message', '訂單所在的 ' || ym || ' 已關帳，取消不了。要做請會計先開帳。');
      end if;
      ym := to_char(to_date(ym || '01', 'YYYYMMDD') + interval '1 month', 'YYYYMM');
    end loop;
  end if;

  -- 訂金沒處理完的先擋（轉押金或沒收之後再來）
  if exists (select 1 from public.deposits
              where order_id = o.id and kind = 'earnest' and received_on is not null
                and returned_on is null and forfeited_on is null and converted_to_deposit_id is null) then
    return jsonb_build_object('ok', false, 'message', '這張訂單還有已收的訂金 —— 先到暫收付管理把訂金「轉押金」或「沒收」，再來結算');
  end if;

  -- 押金
  select * into d from public.deposits where order_id = o.id and kind = 'deposit' limit 1;
  if d.id is not null then
    if d.returned_on is not null then
      return jsonb_build_object('ok', false, 'message', '這張訂單的押金已經退了 —— 結算不了，請找會計手動處理');
    end if;
    if d.forfeited_on is not null then
      return jsonb_build_object('ok', false, 'message', '這張訂單的押金已經沒入了');
    end if;
    if coalesce(d.refund_status, 'none') in ('pending', 'approved') and d.cancel_order_id is distinct from o.id then
      return jsonb_build_object('ok', false, 'message', '押金正在走退款 —— 先到暫收付管理撤銷那筆退款申請，再來結算');
    end if;
    if d.received_on is not null then
      dep_avail := coalesce(d.received_amount, d.amount, 0)
                 - coalesce((select sum(f.amount) from public.orders f where f.deposit_id = d.id and f.source = 'oneoff'), 0);
    end if;
  end if;
  dep_avail := greatest(0, round(dep_avail));
  paid  := greatest(0, round(coalesce(o.paid_amount, 0)));
  total := dep_avail + paid;

  if fo < 0 then return jsonb_build_object('ok', false, 'message', '沒入不能是負的'); end if;
  if fo > total then
    return jsonb_build_object('ok', false, 'message',
      format('沒入 %s 超過已收合計 %s', to_char(fo, 'FM999,999,990'), to_char(total, 'FM999,999,990')));
  end if;
  refund := total - fo;
  path := case when refund = 0 then 'close' when refund < 3000 then 'direct' else 'review' end;
  if refund > 0 and (coalesce(btrim(p_payee_name), '') = '' or coalesce(btrim(p_payee_account), '') = '') then
    return jsonb_build_object('ok', false, 'message', '要退還的話，房客戶名與收款帳號要填');
  end if;

  -- 訂單：已取消、金額歸 0（原金額留著）
  st := jsonb_build_object('deposit', dep_avail, 'order', paid, 'total', total, 'forfeit', fo, 'refund', refund,
          'path', path, 'status', case when path = 'review' then 'review' else 'done' end,
          'orig_amount', coalesce((st->>'orig_amount')::numeric, o.amount), 'settled_on', today, 'settled_by', uid);
  update public.orders
     set cancelled_on = today, cancel_reason = nullif(btrim(coalesce(p_reason, '')), ''), cancel_settle = st, amount = 0
   where id = o.id;
  get diagnostics k = row_count;
  if k <> 1 then raise exception '訂單沒有更新（多半是權限）'; end if;

  -- 退款承載列
  if refund > 0 then
    if d.id is null then
      insert into public.deposits (order_id, kind, estate_id, property_id, room, guest_name, amount, received_on, note, is_manual)
      values (o.id, 'deposit', o.estate_id, o.property_id, o.property_raw, o.guest_name, 0, coalesce(o.paid_at, today),
              '取消退款（這張訂單沒有押金，房費的退款掛在這一列）', true)
      returning * into d;
    end if;
    update public.deposits
       set cancel_order_id = o.id, refund_amount = refund,
           payee_name = btrim(p_payee_name), payee_bank_code = nullif(btrim(coalesce(p_payee_bank_code, '')), ''),
           payee_account = btrim(p_payee_account),
           -- 安幸這邊：預計退款日、出款方式、出款帳號（migration_320）。現金沒有帳號
           planned_refund_on = p_planned_on,
           returned_method = nullif(btrim(coalesce(p_returned_method, '')), ''),
           returned_account = case when coalesce(p_returned_method, '') in ('', 'cash') then null else nullif(btrim(coalesce(p_returned_account, '')), '') end,
           refund_requested_by = uid, refund_requested_at = now(),
           manager_approved_by = null, manager_approved_at = null, admin_approved_by = null, admin_approved_at = null,
           rejected_by = null, rejected_at = null, reject_reason = null,
           refund_status = case when path = 'direct' then 'approved' else 'pending' end
     where id = d.id;
    get diagnostics k = row_count;
    if k <> 1 then raise exception '押金那一列沒有更新（多半是權限）'; end if;
    update public.orders set cancel_settle = cancel_settle || jsonb_build_object('deposit_id', d.id) where id = o.id;
  end if;

  -- 沒入變營收：不用審的現在就做（direct 的話上面改成 approved 時觸發器已經做了，這裡冪等）
  if path <> 'review' then
    fid := public.cancel_settle_apply(o.id, today);
  end if;

  -- 全部沒入：押金結案「已沒入」
  if path = 'close' and d.id is not null and dep_avail > 0 then
    update public.deposits set forfeited_on = today, forfeit_order_id = fid, forfeited_by = uid, cancel_order_id = o.id
     where id = d.id;
  end if;

  return jsonb_build_object('ok', true, 'path', path, 'total', total, 'forfeit', fo, 'refund', refund,
    'message', case path
      when 'close'  then format('已取消，沒入 %s 計入營收，押金結案', to_char(fo, 'FM999,999,990'))
      when 'direct' then format('已取消，沒入 %s 計入營收；退還 %s 未滿 3,000，直接排匯款', to_char(fo, 'FM999,999,990'), to_char(refund, 'FM999,999,990'))
      else format('已取消；退還 %s 已送審，核可後沒入 %s 才計入營收', to_char(refund, 'FM999,999,990'), to_char(fo, 'FM999,999,990')) end);
end $fn$;
comment on function public.cancel_order_settle(uuid, numeric, text, text, text, text, date, text, text) is
  '私下訂單取消結算：已收合計（押金可結算＋房費已收）分成沒入與退還。退還 0 結案、<3000 免審、≥3000 送審。migration_319；320 加安幸出款帳號與預計退款日。';
revoke all on function public.cancel_order_settle(uuid, numeric, text, text, text, text, date, text, text) from public;
grant execute on function public.cancel_order_settle(uuid, numeric, text, text, text, text, date, text, text) to authenticated;


-- ② 核可／駁回／確認匯款 → 同步到訂單的取消結算
create or replace function public.trg_dep_cancel_settle() returns trigger
language plpgsql security definer set search_path = public as $fn$
begin
  if new.cancel_order_id is null then return new; end if;
  if new.refund_status is distinct from old.refund_status then
    if new.refund_status = 'approved' then
      perform public.cancel_settle_apply(new.cancel_order_id, (now() at time zone 'Asia/Taipei')::date);
    elsif new.refund_status = 'rejected' then
      update public.orders set cancel_settle = coalesce(cancel_settle, '{}'::jsonb) || '{"status":"rejected"}'::jsonb
       where id = new.cancel_order_id and coalesce(cancel_settle->>'status', '') = 'review';
    end if;
  end if;
  -- 確認匯款（migration_320）：退還的錢真的出去了 → 結算完成
  if new.returned_on is not null and old.returned_on is null then
    update public.orders
       set cancel_settle = coalesce(cancel_settle, '{}'::jsonb) || jsonb_build_object('status', 'done', 'returned_on', new.returned_on)
     where id = new.cancel_order_id;
  end if;
  return new;
end $fn$;
drop trigger if exists trg_dep_cancel_settle on public.deposits;
create trigger trg_dep_cancel_settle after update of refund_status, returned_on on public.deposits
  for each row execute function public.trg_dep_cancel_settle();

do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('320_cancel_settle_payout');
  end if;
end $do$;

commit;

-- ═══ 自檢（在 commit 後面 —— 看不到那張表就是整支回滾了） ═══════════
select 1 as 序, '結算函式只剩新簽名（9 個參數）' as 檢查,
       (select string_agg(pronargs::text, '、') from pg_proc where proname = 'cancel_order_settle') || ' 個參數' as 結果,
       case when (select count(*) from pg_proc where proname = 'cancel_order_settle') = 1
             and (select pronargs from pg_proc where proname = 'cancel_order_settle') = 9 then '✅' else '❌' end as 判定
union all
select 2, '觸發器看 returned_on（確認匯款 → 結算 done）',
       case when pg_get_functiondef('public.trg_dep_cancel_settle()'::regprocedure) like '%migration_320%'
             and exists (select 1 from pg_trigger t where t.tgname = 'trg_dep_cancel_settle'
                           and pg_get_triggerdef(t.oid) like '%returned_on%') then '新版' else '★ 舊的' end,
       case when pg_get_functiondef('public.trg_dep_cancel_settle()'::regprocedure) like '%migration_320%'
             and exists (select 1 from pg_trigger t where t.tgname = 'trg_dep_cancel_settle'
                           and pg_get_triggerdef(t.oid) like '%returned_on%') then '✅' else '❌' end
union all
select 3, '取消結算、還在等匯款的（參考）',
       (select count(*)::text || ' 筆' from public.deposits where cancel_order_id is not null and returned_on is null and refund_status in ('pending', 'approved')),
       'ℹ'
order by 1;
