/* ══════════════════════════════════════════════════════════════════════
 * migration_332：取消訂單・結算退款 —— 房費、押金分開算                               2026-10-13
 *
 * 【為什麼】David：
 *   「這邊分成押金跟房費分開計算可以嗎？」
 *   「房費應該不是沒入，是要不要退，不會沒入」「不要用折讓，因為是取消 → 訂單金額複寫成保留的金額」
 *   「押金沒入的一次性營收，名目『其他收入』」「保留的房費：照原本住宿的月份」
 *
 * 【規則】（畫面上的試算在 lib/cancel-settle.ts 的 splitRefund／splitError，跟這裡同一套）
 *   房費　保留 0～已收房費；退還 ＝ 已收房費 − 保留
 *         ★ 保留的直接寫成訂單金額 —— 照原本住宿的月份認列（gen_recognitions 改一行：
 *           已取消「而且金額 0」才不認列；有保留的照算）
 *   押金　沒入 0～押金可結算；退還 ＝ 押金可結算 − 沒入
 *         ★ 沒入的記一筆一次性收入：名目「其他收入」（→ 科目 other_income）、項目「押金沒入」、日期＝生效那天
 *   退還合計 0 → 結案；< 3,000 → 免審；≥ 3,000 → 送審（兩票），核可時押金沒入才記 —— 跟 319 一樣
 *   訂單：標已取消（房源狀態空出那幾晚）；★ 送審的話，訂單金額在送出時就改好（駁回可以重新結算）
 *
 * 【不動的】已經結算過的訂單（舊的 cancel_settle 沒有 dep_forfeit，套用時照舊版規則走）、
 *          擋下來的條件（已結算過／押金在退／訂金沒處理／關帳）、退款承載列、核可觸發器
 *
 * ★ 要先跑 319、320。
 * ★★ 自檢在 commit 後面 —— 看不到那張表就是整支回滾了。
 * ══════════════════════════════════════════════════════════ */

begin;

-- ① 名目「其他收入」→ 科目 other_income；② 已取消但有保留房費的照認列（兩支都線上原文 replace，恰好一處才改）
do $do$
declare t text; old_s text; new_s text; n int;
begin
  t := pg_get_functiondef('public.order_account_code(text, text)'::regprocedure);
  if position('''其他收入''' in t) = 0 then
    old_s := 'when ''取消入住'' then ''other_income''';
    new_s := 'when ''取消入住'' then ''other_income''
        when ''其他收入'' then ''other_income''   -- migration_332：取消結算的押金沒入';
    n := (length(t) - length(replace(t, old_s, ''))) / length(old_s);
    if n <> 1 then raise exception 'order_account_code 裡「%」出現 % 次（要剛好 1 次）—— 停下來', old_s, n; end if;
    execute replace(t, old_s, new_s);
  end if;

  t := pg_get_functiondef('public.gen_recognitions(public.orders)'::regprocedure);
  if position('migration_332' in t) = 0 then
    old_s := 'if o.cancelled_on is not null then return; end if;';
    new_s := 'if o.cancelled_on is not null and coalesce(o.amount, 0) = 0 then return; end if;  -- migration_332：保留的房費照原本住宿月份認列';
    n := (length(t) - length(replace(t, old_s, ''))) / length(old_s);
    if n <> 1 then raise exception 'gen_recognitions 裡「%」出現 % 次（要剛好 1 次）—— 停下來', old_s, n; end if;
    execute replace(t, old_s, new_s);
  end if;
end $do$;


-- ③ 套用（RPC 與核可觸發器共用，冪等）
create or replace function public.cancel_settle_apply(p_order uuid, p_on date)
returns uuid language plpgsql security definer set search_path = public as $fn$
declare
  o   public.orders;
  st  jsonb;
  fid uuid;
  amt numeric;
  is_split boolean;
begin
  select * into o from public.orders where id = p_order for update;
  st := coalesce(o.cancel_settle, '{}'::jsonb);
  if st->>'forfeit_order_id' is not null or st ? 'applied_on' then
    return nullif(st->>'forfeit_order_id', '')::uuid;          -- 冪等：核可觸發兩次也只有一筆
  end if;
  is_split := st ? 'dep_forfeit';                               -- 332 之後的結算；舊的照 319 規則
  amt := coalesce((st->>(case when is_split then 'dep_forfeit' else 'forfeit' end))::numeric, 0);

  if amt > 0 then
    insert into public.orders
      (order_key, source, fee_type, item_name, amount, checkin, checkout, nights,
       estate_id, property_id, property_raw, guest_name, note, paid, parent_order_id, imported_via)
    values
      (format('CXL_%s_%s', left(o.id::text, 8), (extract(epoch from clock_timestamp()) * 1000)::bigint),
       'oneoff',
       case when is_split then '其他收入' else '取消入住' end,
       case when is_split then '押金沒入' else '取消入住' end,
       amt, p_on, p_on, 0,
       o.estate_id, o.property_id, o.property_raw, o.guest_name,
       case when is_split then
         format('取消結算（%s）：押金 %s，沒入 %s、退還 %s；房費 %s，保留 %s、退還 %s',
                coalesce(o.cancel_reason, '取消'),
                to_char((st->>'deposit')::numeric, 'FM999,999,990'), to_char(amt, 'FM999,999,990'),
                to_char((st->>'dep_refund')::numeric, 'FM999,999,990'),
                to_char((st->>'order')::numeric, 'FM999,999,990'), to_char((st->>'keep_fee')::numeric, 'FM999,999,990'),
                to_char((st->>'fee_refund')::numeric, 'FM999,999,990'))
       else
         format('取消結算（%s）：已收 %s（押金 %s＋房費 %s），沒入 %s、退還 %s',
                coalesce(o.cancel_reason, '取消'),
                to_char((st->>'total')::numeric, 'FM999,999,990'), to_char((st->>'deposit')::numeric, 'FM999,999,990'),
                to_char((st->>'order')::numeric, 'FM999,999,990'), to_char(amt, 'FM999,999,990'),
                to_char((st->>'refund')::numeric, 'FM999,999,990'))
       end,
       true, o.id, 'manual')
    returning id into fid;
    if fid is null then raise exception '沒入的收入單沒有建起來（多半是權限）'; end if;
  end if;
  update public.orders
     set cancel_settle = st || jsonb_build_object('forfeit_order_id', fid, 'applied_on', p_on,
                                                  'status', case when (st->>'path') = 'review' then 'approved' else 'done' end)
   where id = o.id;
  return fid;
end $fn$;
revoke all on function public.cancel_settle_apply(uuid, date) from public;


-- ④ 取消結算（新簽名：房費保留、押金沒入分開給）
drop function if exists public.cancel_order_settle(uuid, numeric, text, text, text, text, date, text, text);

create or replace function public.cancel_order_settle(
  p_order uuid, p_keep_fee numeric, p_dep_forfeit numeric, p_reason text,
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
  kf    numeric := round(coalesce(p_keep_fee, -1));
  df    numeric := round(coalesce(p_dep_forfeit, -1));
  fee_refund numeric; dep_refund numeric; refund numeric;
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

  -- 關帳：今天（押金沒入入帳的月份）與訂單住宿的月份（訂單金額會改）
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

  -- 訂金沒處理完的先擋
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

  if paid + dep_avail <= 0 then
    return jsonb_build_object('ok', false, 'message', '這張訂單一毛都還沒收到 —— 沒有東西可以保留或退還，直接刪掉訂單就好');
  end if;
  if kf < 0 or df < 0 then return jsonb_build_object('ok', false, 'message', '保留／沒入不能是負的'); end if;
  if kf > paid then
    return jsonb_build_object('ok', false, 'message',
      format('房費保留 %s 超過已收房費 %s', to_char(kf, 'FM999,999,990'), to_char(paid, 'FM999,999,990')));
  end if;
  if df > dep_avail then
    return jsonb_build_object('ok', false, 'message',
      format('押金沒入 %s 超過押金可結算 %s', to_char(df, 'FM999,999,990'), to_char(dep_avail, 'FM999,999,990')));
  end if;
  fee_refund := paid - kf;
  dep_refund := dep_avail - df;
  refund := fee_refund + dep_refund;
  path := case when refund = 0 then 'close' when refund < 3000 then 'direct' else 'review' end;
  if refund > 0 and (coalesce(btrim(p_payee_name), '') = '' or coalesce(btrim(p_payee_account), '') = '') then
    return jsonb_build_object('ok', false, 'message', '要退還的話，房客戶名與收款帳號要填');
  end if;

  -- 訂單：已取消、金額＝保留的房費（原金額留在 cancel_settle）→ 照原本住宿月份認列保留的那部分
  st := jsonb_build_object('deposit', dep_avail, 'order', paid, 'total', dep_avail + paid,
          'keep_fee', kf, 'fee_refund', fee_refund, 'dep_forfeit', df, 'dep_refund', dep_refund, 'refund', refund,
          'path', path, 'status', case when path = 'review' then 'review' else 'done' end,
          'orig_amount', coalesce((st->>'orig_amount')::numeric, o.amount), 'settled_on', today, 'settled_by', uid);
  update public.orders
     set cancelled_on = today, cancel_reason = nullif(btrim(coalesce(p_reason, '')), ''), cancel_settle = st, amount = kf
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

  -- 押金沒入變收入：不用審的現在就做（direct 時上面改成 approved 觸發器已經做了，這裡冪等）
  if path <> 'review' then
    fid := public.cancel_settle_apply(o.id, today);
  end if;

  -- 不用退錢：押金結案「已沒入」
  if path = 'close' and d.id is not null and dep_avail > 0 then
    update public.deposits set forfeited_on = today, forfeit_order_id = fid, forfeited_by = uid, cancel_order_id = o.id
     where id = d.id;
  end if;

  return jsonb_build_object('ok', true, 'path', path, 'refund', refund, 'keep_fee', kf, 'dep_forfeit', df,
    'message', concat_ws('；',
      '已取消',
      case when kf > 0 then format('房費保留 %s（照原本住宿月份算營收）', to_char(kf, 'FM999,999,990')) end,
      case when df > 0 then format('押金沒入 %s 記成其他收入%s', to_char(df, 'FM999,999,990'),
                                    case when path = 'review' then '（核可後才記）' else '' end) end,
      case path when 'direct' then format('退還 %s 未滿 3,000，直接排匯款', to_char(refund, 'FM999,999,990'))
                when 'review' then format('退還 %s 已送審', to_char(refund, 'FM999,999,990')) end));
end $fn$;
comment on function public.cancel_order_settle(uuid, numeric, numeric, text, text, text, text, date, text, text) is
  '私下訂單取消結算（migration_332）：房費保留→改寫成訂單金額照住宿月份認列；押金沒入→其他收入。退還 0 結案、<3000 免審、≥3000 送審。';
revoke all on function public.cancel_order_settle(uuid, numeric, numeric, text, text, text, text, date, text, text) from public;
grant execute on function public.cancel_order_settle(uuid, numeric, numeric, text, text, text, text, date, text, text) to authenticated;

do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('332_cancel_settle_split');
  end if;
end $do$;

commit;

-- ═══ 自檢（在 commit 後面 —— 看不到那張表就是整支回滾了） ═══════════
select 1 as 序, '結算函式只剩新簽名（10 個參數：房費保留、押金沒入分開）' as 檢查,
       (select string_agg(pronargs::text, '、') from pg_proc where proname = 'cancel_order_settle') || ' 個參數' as 結果,
       case when (select count(*) from pg_proc where proname = 'cancel_order_settle') = 1
             and (select pronargs from pg_proc where proname = 'cancel_order_settle') = 10 then '✅' else '❌' end as 判定
union all
select 2, '已取消但有保留房費的照認列（gen_recognitions）',
       case when pg_get_functiondef('public.gen_recognitions(public.orders)'::regprocedure) like '%cancelled_on is not null and coalesce(o.amount, 0) = 0 then return%'
            then '新版' else '★ 舊的' end,
       case when pg_get_functiondef('public.gen_recognitions(public.orders)'::regprocedure) like '%cancelled_on is not null and coalesce(o.amount, 0) = 0 then return%'
            then '✅' else '❌' end
union all
select 3, '名目「其他收入」→ 科目', public.order_account_code('oneoff', '其他收入'),
       case when public.order_account_code('oneoff', '其他收入') = 'other_income' then '✅' else '❌' end
union all
select 4, '舊名目「取消入住」還在（舊的結算照舊）', public.order_account_code('oneoff', '取消入住'),
       case when public.order_account_code('oneoff', '取消入住') = 'other_income' then '✅' else '❌' end
union all
select 5, '取消結算、還在等核可的舊單（參考，核可時照舊規則記）',
       (select count(*)::text || ' 筆' from public.orders where cancelled_on is not null
          and cancel_settle->>'status' = 'review' and not (cancel_settle ? 'dep_forfeit')),
       'ℹ'
order by 1;
