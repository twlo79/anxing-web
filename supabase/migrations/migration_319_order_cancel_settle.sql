/* ══════════════════════════════════════════════════════════════════════
 * migration_319：私下訂單「取消訂單・結算退款」                                       2026-10-06
 *
 * 【為什麼】David：「沒入應該是計算所有已收後退 ——
 *   ① 押金已收多少 ② 訂單金額已收多少 ③ 從已收金額看沒入多少、退還多少；退還的要走請款，退還不到 3000 直接過
 *   ④ 沒入的部分變營收、押金狀態修改、訂單變取消」「全部沒入不用送審」「退還不能多於全部金額」
 *
 * 【規則】（畫面上的試算在 lib/cancel-settle.ts，跟這裡同一套）
 *   已收合計 ＝ 押金可結算（已收 − 已從押金扣的加費）＋ 訂單已收（paid_amount）
 *   退還     ＝ 已收合計 − 沒入；沒入要在 0～已收合計之間（不然直接回原因）
 *   退還 0         → 不用請款：沒入當下變營收，押金「已沒入」結案
 *   退還 < 3,000   → 免審：沒入當下變營收，退款直接「已核可待匯款」
 *   退還 ≥ 3,000   → 送審（兩票）：核可時沒入才變營收；駁回可以重新結算
 *   不論哪一條：訂單當下標「已取消」、金額歸 0（原金額留在 cancel_settle）→ 不再認列、房源狀態空出來
 *   沒入的收入單：名目「取消入住」（→ 其他收入，migration_318）、日期＝生效那天、paid、掛在原訂單底下
 *   退款一律掛在這張訂單的押金那一列（沒有押金就建一列 0 元的承載列）—— 請款審核頁照舊看得到
 *
 * 【擋下來的】不是私下訂單／已經結算過／押金正在退款或已退／還有沒處理的訂金／訂單月份或今天已關帳
 *
 * ★ 要先跑 migration_318（名目「取消入住」的科目在那支）。
 * ★★ 自檢在 commit 後面 —— 看不到那張表就是整支回滾了。
 * ══════════════════════════════════════════════════════════ */

begin;

-- ① 欄位
alter table public.orders add column if not exists cancelled_on date;
alter table public.orders add column if not exists cancel_reason text;
alter table public.orders add column if not exists cancel_settle jsonb;
comment on column public.orders.cancelled_on is '私下訂單取消日（migration_319）。有值＝已取消：不認列、房源狀態不畫';
comment on column public.orders.cancel_settle is
  '取消結算：{deposit, order, total, forfeit, refund, path(close/direct/review), status(done/review/approved/rejected), orig_amount, deposit_id, forfeit_order_id}';
create index if not exists orders_cancelled_idx on public.orders (cancelled_on) where cancelled_on is not null;

alter table public.deposits add column if not exists cancel_order_id uuid references public.orders(id) on delete set null;
comment on column public.deposits.cancel_order_id is '這一列承載哪張訂單的取消結算（migration_319）。有值時退款金額＝取消結算的退還，不是押金原額';

-- ② 已取消的訂單不認列
create or replace function public.gen_recognitions(o orders)
 returns void
 language plpgsql
 security definer
as $function$
declare
  ms date; me date; n int; ename text; pname text;
  last_ms date; acc numeric := 0; amt numeric;
begin
  -- 長租且掛在契約上的:認列由 gen_contract_recognitions 依契約產生
  -- ★★★ 這一條不能刪 —— 刪掉的話長租的認列會被產生兩次，營收翻倍
  if o.source = 'longterm' and o.contract_id is not null then return; end if;
  -- ★ migration_319：已取消的訂單不認列（沒入的錢是另一筆「取消入住」收入單）
  if o.cancelled_on is not null then return; end if;

  select e.name into ename from estates e where e.id = o.estate_id;
  select p.name into pname from properties p where p.id = o.property_id;
  pname := coalesce(pname, o.property_raw);

  if o.source in ('oneoff', 'airbnb_cancelled') then
    if o.checkin is null or o.amount is null then return; end if;
    ms := date_trunc('month', o.checkin)::date;
    insert into revenue_recognitions(order_id, ym, period_start, period_end, source, estate_id, property_id,
      estate_name, property_raw, guest_name, checkin, checkout, total_amount, total_nights, month_nights, month_amount, fee_type,
      item_name, purpose_type)   -- ★ migration_235 新增 purpose_type
    values (o.id, to_char(o.checkin,'YYYYMM'), ms, (ms + interval '1 month')::date, 'oneoff', o.estate_id, o.property_id,
      ename, pname, o.guest_name, o.checkin, o.checkout, o.amount, coalesce(o.nights,0), 0, o.amount, coalesce(o.fee_type,'取消費'),
      o.item_name, o.purpose_type);
    return;
  end if;

  if o.checkin is null or o.checkout is null or o.nights is null or o.nights <= 0 then return; end if;
  last_ms := date_trunc('month', o.checkout - 1)::date;
  ms := date_trunc('month', o.checkin)::date;
  while ms < o.checkout loop
    me := (ms + interval '1 month')::date;
    n := greatest(0, least(o.checkout, me) - greatest(o.checkin, ms));
    if n > 0 then
      if ms = last_ms then amt := o.amount - acc;
      else amt := trunc(o.amount * n / o.nights); acc := acc + amt; end if;
      insert into revenue_recognitions(order_id, ym, period_start, period_end, source, estate_id, property_id,
        estate_name, property_raw, guest_name, checkin, checkout, total_amount, total_nights, month_nights, month_amount, fee_type,
        item_name, purpose_type)
      values (o.id, to_char(ms,'YYYYMM'), greatest(o.checkin, ms), least(o.checkout, me),
        case when o.source = 'partner' then 'airbnb' else o.source end,
        o.estate_id, o.property_id,
        ename, pname, o.guest_name, o.checkin, o.checkout, o.amount, o.nights, n, amt, null,
        null, o.purpose_type);   -- ★ 項目長租沒有；用途照帶
    end if;
    ms := me;
  end loop;
end $function$;


-- ③ 沒入變營收（RPC 與核可觸發器共用）
create or replace function public.cancel_settle_apply(p_order uuid, p_on date)
returns uuid language plpgsql security definer set search_path = public as $fn$
declare
  o   public.orders;
  st  jsonb;
  fid uuid;
  amt numeric;
begin
  select * into o from public.orders where id = p_order for update;
  st := coalesce(o.cancel_settle, '{}'::jsonb);
  if st->>'forfeit_order_id' is not null then
    return (st->>'forfeit_order_id')::uuid;          -- 冪等：核可觸發兩次也只有一筆
  end if;
  amt := coalesce((st->>'forfeit')::numeric, 0);
  if amt > 0 then
    insert into public.orders
      (order_key, source, fee_type, item_name, amount, checkin, checkout, nights,
       estate_id, property_id, property_raw, guest_name, note, paid, parent_order_id, imported_via)
    values
      (format('CXL_%s_%s', left(o.id::text, 8), (extract(epoch from clock_timestamp()) * 1000)::bigint),
       'oneoff', '取消入住', '取消入住', amt, p_on, p_on, 0,
       o.estate_id, o.property_id, o.property_raw, o.guest_name,
       format('取消結算（%s）：已收 %s（押金 %s＋房費 %s），沒入 %s、退還 %s',
              coalesce(o.cancel_reason, '取消'),
              to_char((st->>'total')::numeric, 'FM999,999,990'), to_char((st->>'deposit')::numeric, 'FM999,999,990'),
              to_char((st->>'order')::numeric, 'FM999,999,990'), to_char(amt, 'FM999,999,990'),
              to_char((st->>'refund')::numeric, 'FM999,999,990')),
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

-- ④ 取消結算
create or replace function public.cancel_order_settle(
  p_order uuid, p_forfeit numeric, p_reason text,
  p_payee_name text default null, p_payee_bank_code text default null, p_payee_account text default null)
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
comment on function public.cancel_order_settle(uuid, numeric, text, text, text, text) is
  '私下訂單取消結算：已收合計（押金可結算＋房費已收）分成沒入與退還。退還 0 結案、<3000 免審、≥3000 送審。migration_319。';
revoke all on function public.cancel_order_settle(uuid, numeric, text, text, text, text) from public;
grant execute on function public.cancel_order_settle(uuid, numeric, text, text, text, text) to authenticated;

-- ⑤ 退款核可／駁回時，同步取消結算
create or replace function public.trg_dep_cancel_settle() returns trigger
language plpgsql security definer set search_path = public as $fn$
begin
  if new.cancel_order_id is null or new.refund_status is not distinct from old.refund_status then return new; end if;
  if new.refund_status = 'approved' then
    perform public.cancel_settle_apply(new.cancel_order_id, (now() at time zone 'Asia/Taipei')::date);
  elsif new.refund_status = 'rejected' then
    update public.orders set cancel_settle = coalesce(cancel_settle, '{}'::jsonb) || '{"status":"rejected"}'::jsonb
     where id = new.cancel_order_id and coalesce(cancel_settle->>'status', '') = 'review';
  end if;
  return new;
end $fn$;
drop trigger if exists trg_dep_cancel_settle on public.deposits;
create trigger trg_dep_cancel_settle after update of refund_status on public.deposits
  for each row execute function public.trg_dep_cancel_settle();

do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('319_order_cancel_settle');
  end if;
end $do$;

commit;

-- ═══ 自檢（在 commit 後面 —— 看不到那張表就是整支回滾了） ═══════════
select 1 as 序, '欄位在（訂單取消、押金承載）' as 檢查,
       (select string_agg(table_name || '.' || column_name, '、' order by table_name, column_name) from information_schema.columns
         where table_schema = 'public' and ((table_name = 'orders' and column_name in ('cancelled_on', 'cancel_reason', 'cancel_settle'))
                                         or (table_name = 'deposits' and column_name = 'cancel_order_id'))) as 結果,
       case when (select count(*) from information_schema.columns where table_schema = 'public'
                   and ((table_name = 'orders' and column_name in ('cancelled_on', 'cancel_reason', 'cancel_settle'))
                     or (table_name = 'deposits' and column_name = 'cancel_order_id'))) = 4 then '✅' else '❌' end as 判定
union all
select 2, '已取消不認列（gen_recognitions 新版，長租那條還在）',
       case when pg_get_functiondef('public.gen_recognitions(public.orders)'::regprocedure) like '%cancelled_on is not null then return%'
             and pg_get_functiondef('public.gen_recognitions(public.orders)'::regprocedure) like '%longterm%contract_id is not null then return%'
            then '新版' else '★ 不對' end,
       case when pg_get_functiondef('public.gen_recognitions(public.orders)'::regprocedure) like '%cancelled_on is not null then return%'
             and pg_get_functiondef('public.gen_recognitions(public.orders)'::regprocedure) like '%longterm%contract_id is not null then return%'
            then '✅' else '❌' end
union all
select 3, '結算函式、核可觸發器在',
       (select string_agg(proname, '、' order by proname) from pg_proc where proname in ('cancel_order_settle', 'cancel_settle_apply', 'trg_dep_cancel_settle'))
         || '・' || coalesce((select tgname from pg_trigger where tgname = 'trg_dep_cancel_settle'), '★ 沒有觸發器'),
       case when (select count(*) from pg_proc where proname in ('cancel_order_settle', 'cancel_settle_apply', 'trg_dep_cancel_settle')) = 3
             and exists (select 1 from pg_trigger where tgname = 'trg_dep_cancel_settle') then '✅' else '❌' end
union all
select 4, '名目「取消入住」→ 其他收入（318 要先跑）',
       public.order_account_code('oneoff', '取消入住'),
       case when public.order_account_code('oneoff', '取消入住') = 'other_income' then '✅' else '❌ 先跑 318' end
order by 1;
