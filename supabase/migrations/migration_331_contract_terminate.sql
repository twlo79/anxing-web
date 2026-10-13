/* ══════════════════════════════════════════════════════════════════════
 * migration_331：契約「提前終止・結算退款」＋ 停用不再把營收清光                       2026-10-13
 *
 * 【為什麼】6B5 周羽艾：年繳 1,323,000 已收，5/31 退租、退部分租金＋押金。
 *   查下去（查-提前終止契約前的現況）發現兩件事：
 *   ① gen_contract_recognitions() 先刪光這張契約的認列，然後 `if not ct.active then return` ——
 *      契約一停用，**從頭到尾**的營收都消失，連住過、收過錢的月份也一樣（周羽艾現在 0 筆）。
 *   ② gen_contract_orders() 停用時刪掉**所有**未收的月租單，連終止日以前欠的也刪 —— 應收不見。
 *   而「提前退租、預收要退一部分、押金一起結」系統裡沒有地方做。
 *
 * 【做什麼】
 *   ① 欄位：contracts.terminated_on / terminate_settle；deposits.terminate_contract_id（退款承載列）
 *   ② 兩支函式各改一行（線上原文 replace，恰好一處才改）：
 *        停用 **而且沒有終止日** 才清光 —— 走「提前終止」的契約，營收認到終止日、應收留到終止日
 *        ★ 只認 terminated_on。現在已經停用的兩張（周羽艾、南京10-2 舊房客）不會自己變，周羽艾用新功能結一次
 *   ③ contract_earned_to(契約, 終止日)：照認列同一套算法，算「住到終止日該收多少」
 *   ④ terminate_contract_settle()：（規則跟 lib/contract-terminate.ts 同一套）
 *        預收沒住的 ＝ 月租單已收合計 − 住到終止日該收的（不小於 0）
 *        押金可結算 ＝ 押金已收 − 已從押金扣的加費（已退／已沒收的算 0）
 *        兩列各自分沒收／退還；退還合計 0 → 結案、< 3,000 → 免審、≥ 3,000 → 送審（跟取消訂單同一條）
 *        契約：迄日＝終止日、停用、terminated_on；終止日之後的月租單（沒有收款紀錄的）刪掉
 *        沒收：記成「取消入住」收入單（→ 其他收入，migration_318），項目寫「提前解約・沒收租金／押金」
 *        退款：掛在押金那一列（沒有就建一列 0 元的），走現在的請款審核
 *   ⑤ 押金那一列核可／駁回／確認匯款 → 同步契約的結算狀態
 *
 * 【擋下來的】已經結算過／終止日不在租期內／還有沒處理的訂金／押金正在走別的退款／
 *            終止日之後的月租單上有收款紀錄（錢掛在那幾張上，先移到前面的期）／
 *            今天或營收會變動的月份已關帳
 *
 * ★★ 自檢在 commit 後面 —— 看不到那張表就是整支回滾了。
 * ══════════════════════════════════════════════════════════ */

begin;

-- ① 欄位
alter table public.contracts add column if not exists terminated_on date;
alter table public.contracts add column if not exists terminate_settle jsonb;
comment on column public.contracts.terminated_on is
  '提前終止日（migration_331）。有值：停用照樣認列營收到這天（＝end_date）；沒有值的停用＝作廢，營收全清';
comment on column public.contracts.terminate_settle is
  '提前終止結算：{rent_paid, earned, prepaid, deposit, rent_forfeit, dep_forfeit, refund, path, status, settled_on, deposit_id, forfeit_order_ids}';

alter table public.deposits add column if not exists terminate_contract_id uuid references public.contracts(id) on delete set null;
comment on column public.deposits.terminate_contract_id is
  '這一列承載哪張契約的提前終止結算（migration_331）。有值時退款金額＝結算的退還合計（租金＋押金）';


-- ② 兩支函式各改一行：停用「而且沒有終止日」才清光
do $do$
declare
  t text; old_s text; new_s text; n int;
begin
  -- 營收
  t := pg_get_functiondef('public.gen_contract_recognitions(public.contracts)'::regprocedure);
  if position('migration_331' in t) = 0 then
    old_s := 'if not ct.active then return; end if;';
    new_s := 'if not ct.active and ct.terminated_on is null then return; end if;  -- migration_331：提前終止的照認到終止日';
    n := (length(t) - length(replace(t, old_s, ''))) / length(old_s);
    if n <> 1 then raise exception 'gen_contract_recognitions 裡「%」出現 % 次（要剛好 1 次）—— 停下來', old_s, n; end if;
    execute replace(t, old_s, new_s);
  end if;

  -- 月租單
  t := pg_get_functiondef('public.gen_contract_orders(public.contracts)'::regprocedure);
  if position('migration_331' in t) = 0 then
    old_s := 'if not ct.active or ct.monthly_rent is null or ct.monthly_rent <= 0 then';
    new_s := 'if (not ct.active and ct.terminated_on is null) or ct.monthly_rent is null or ct.monthly_rent <= 0 then  -- migration_331';
    n := (length(t) - length(replace(t, old_s, ''))) / length(old_s);
    if n <> 1 then raise exception 'gen_contract_orders 裡「%」出現 % 次（要剛好 1 次）—— 停下來', old_s, n; end if;
    execute replace(t, old_s, new_s);
  end if;
end $do$;


-- ③ 住到終止日該收多少（跟 gen_contract_recognitions 第一趟同一套：每月 月租 × 住的天數 ÷ 當月天數，最後四捨五入）
create or replace function public.contract_earned_to(ct public.contracts, p_end date)
returns numeric language plpgsql stable as $fn$
declare
  ms date; me date; lease_end date; n int; dim int; total numeric := 0;
begin
  if ct.start_date is null or p_end is null or coalesce(ct.monthly_rent, 0) <= 0 then return 0; end if;
  lease_end := (p_end + 1)::date;
  ms := date_trunc('month', ct.start_date)::date;
  while ms < lease_end loop
    me := (ms + interval '1 month')::date;
    n  := least(me, lease_end) - greatest(ms, ct.start_date);
    if n > 0 then
      dim   := me - ms;
      total := total + ct.monthly_rent::numeric * n / dim;
    end if;
    ms := me;
  end loop;
  return round(total);
end $fn$;


-- ④-a 沒收變收入（RPC 與核可觸發器共用，冪等）
create or replace function public.terminate_settle_apply(p_contract uuid, p_on date)
returns void language plpgsql security definer set search_path = public as $fn$
declare
  c   public.contracts;
  st  jsonb;
  rf  numeric; df numeric;
  ids uuid[] := '{}';
  fid uuid;
  ename text;
begin
  select * into c from public.contracts where id = p_contract for update;
  st := coalesce(c.terminate_settle, '{}'::jsonb);
  if st ? 'forfeit_order_ids' then return; end if;      -- 冪等：核可觸發兩次也只有一份
  rf := coalesce((st->>'rent_forfeit')::numeric, 0);
  df := coalesce((st->>'dep_forfeit')::numeric, 0);

  if rf > 0 then
    insert into public.orders
      (order_key, source, fee_type, item_name, amount, checkin, checkout, nights,
       estate_id, property_raw, guest_name, note, paid, contract_id, imported_via)
    values
      (format('CTX_%s_R_%s', left(c.id::text, 8), (extract(epoch from clock_timestamp()) * 1000)::bigint),
       'oneoff', '取消入住', '提前解約・沒收租金', rf, p_on, p_on, 0,
       c.estate_id, c.room, c.tenant_name,
       format('提前終止（%s）：終止日 %s，預收沒住 %s，沒收 %s',
              coalesce(st->>'reason', '提前退租'), st->>'end',
              to_char((st->>'prepaid')::numeric, 'FM999,999,990'), to_char(rf, 'FM999,999,990')),
       true, c.id, 'manual')
    returning id into fid;
    if fid is null then raise exception '沒收租金的收入單沒有建起來（多半是權限）'; end if;
    ids := ids || fid;
  end if;

  if df > 0 then
    insert into public.orders
      (order_key, source, fee_type, item_name, amount, checkin, checkout, nights,
       estate_id, property_raw, guest_name, note, paid, contract_id, imported_via)
    values
      (format('CTX_%s_D_%s', left(c.id::text, 8), (extract(epoch from clock_timestamp()) * 1000)::bigint),
       'oneoff', '取消入住', '提前解約・沒收押金', df, p_on, p_on, 0,
       c.estate_id, c.room, c.tenant_name,
       format('提前終止（%s）：押金 %s，沒收 %s',
              coalesce(st->>'reason', '提前退租'),
              to_char((st->>'deposit')::numeric, 'FM999,999,990'), to_char(df, 'FM999,999,990')),
       true, c.id, 'manual')
    returning id into fid;
    if fid is null then raise exception '沒收押金的收入單沒有建起來（多半是權限）'; end if;
    ids := ids || fid;
  end if;

  update public.contracts
     set terminate_settle = st || jsonb_build_object('forfeit_order_ids', to_jsonb(ids), 'applied_on', p_on,
                                                    'status', case when (st->>'path') = 'review' then 'approved' else 'done' end)
   where id = c.id;
end $fn$;
revoke all on function public.terminate_settle_apply(uuid, date) from public;


-- ④-b 提前終止・結算
create or replace function public.terminate_contract_settle(
  p_contract uuid, p_end date, p_rent_forfeit numeric, p_dep_forfeit numeric, p_reason text,
  p_payee_name text default null, p_payee_bank_code text default null, p_payee_account text default null,
  p_planned_on date default null, p_returned_method text default null, p_returned_account text default null)
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare
  uid     uuid := auth.uid();
  c       public.contracts;
  d       public.deposits;
  today   date := (now() at time zone 'Asia/Taipei')::date;
  st      jsonb;
  paid    numeric := 0;
  earned  numeric := 0;
  prepaid numeric := 0;
  dep     numeric := 0;
  rf      numeric := round(coalesce(p_rent_forfeit, -1));
  df      numeric := round(coalesce(p_dep_forfeit, -1));
  refund  numeric;
  path    text;
  ym      text; ym_to text;
  bad     text;
  k       int;
begin
  if uid is null then return jsonb_build_object('ok', false, 'message', '請重新登入'); end if;
  if coalesce(public.current_role_of(), '') not in ('accountant', 'manager', 'super_admin') then
    return jsonb_build_object('ok', false, 'message', '只有主管、會計、總經理可以提前終止契約');
  end if;

  select * into c from public.contracts where id = p_contract for update;
  if not found then return jsonb_build_object('ok', false, 'message', '找不到這張契約（可能剛被刪了）'); end if;
  st := coalesce(c.terminate_settle, '{}'::jsonb);
  if c.terminated_on is not null and coalesce(st->>'status', '') <> 'rejected' then
    return jsonb_build_object('ok', false, 'message', '這張契約已經提前終止結算過了');
  end if;
  if p_end is null then return jsonb_build_object('ok', false, 'message', '填終止日'); end if;
  if c.start_date is null or c.end_date is null then
    return jsonb_build_object('ok', false, 'message', '這張契約沒有租期起訖 —— 先到編輯把租期填好');
  end if;
  if p_end < c.start_date then
    return jsonb_build_object('ok', false, 'message', '終止日不能早於起租日 ' || c.start_date);
  end if;
  if p_end > c.end_date then
    return jsonb_build_object('ok', false, 'message', '終止日不能晚於原本的迄日 ' || c.end_date || '（到期就不用終止）');
  end if;

  -- 關帳：今天（沒收入帳、退款承載列）＋ 營收會變的月份
  if public.is_period_locked(to_char(today, 'YYYYMM')) then
    return jsonb_build_object('ok', false, 'message', to_char(today, 'YYYYMM') || ' 已關帳，結算不了。要做請會計先開帳。');
  end if;
  if c.active then          -- 使用中：終止月～原本迄日那幾個月的營收會變少
    ym := to_char(p_end, 'YYYYMM'); ym_to := to_char(c.end_date, 'YYYYMM');
  else                      -- 已停用（營收被清光過）：起租月～終止月會補回來
    ym := to_char(c.start_date, 'YYYYMM'); ym_to := to_char(p_end, 'YYYYMM');
  end if;
  while ym <= ym_to loop
    if public.is_period_locked(ym) then bad := coalesce(bad || '、', '') || ym; end if;
    ym := to_char(to_date(ym || '01', 'YYYYMMDD') + interval '1 month', 'YYYYMM');
  end loop;
  if bad is not null then
    return jsonb_build_object('ok', false, 'message',
      '這次會改到 ' || bad || ' 的營收，那幾個月已關帳 —— 請會計先開帳，結算完再關回去。');
  end if;

  -- 訂金沒處理完的先擋
  if exists (select 1 from public.deposits
              where contract_id = c.id and kind = 'earnest' and received_on is not null
                and returned_on is null and forfeited_on is null and converted_to_deposit_id is null) then
    return jsonb_build_object('ok', false, 'message', '這張契約還有已收的訂金 —— 先到暫收付管理把訂金「轉押金」或「沒收」，再來結算');
  end if;

  -- 終止日之後的月租單上有收款紀錄 → 錢掛在那幾張，刪了收款就跟著不見
  select string_agg(o.order_key, '、' order by o.checkin) into bad
    from public.orders o
   where o.contract_id = c.id and o.imported_via = 'contract' and o.checkin > p_end
     and exists (select 1 from public.order_payments p where p.order_id = o.id);
  if bad is not null then
    return jsonb_build_object('ok', false, 'message',
      '終止日之後的月租單有收款紀錄（' || bad || '）—— 先到收租把那幾筆收款改掛到終止日以前的期，再來結算');
  end if;

  -- 押金
  select * into d from public.deposits where contract_id = c.id and kind = 'deposit' order by created_at limit 1;
  if d.id is not null then
    if coalesce(d.refund_status, 'none') in ('pending', 'approved') and d.terminate_contract_id is distinct from c.id then
      return jsonb_build_object('ok', false, 'message', '押金正在走退款 —— 先到暫收付管理撤銷那筆退款申請，再來結算');
    end if;
    if d.received_on is not null and d.returned_on is null and d.forfeited_on is null then
      dep := coalesce(d.received_amount, d.amount, 0)
           - coalesce((select sum(f.amount) from public.orders f where f.deposit_id = d.id and f.source = 'oneoff'), 0);
    end if;
  end if;
  dep := greatest(0, round(dep));

  -- 租金：月租單已收合計 − 住到終止日該收的
  select coalesce(sum(o.paid_amount), 0) into paid
    from public.orders o where o.contract_id = c.id and o.imported_via = 'contract';
  paid    := round(paid);
  earned  := public.contract_earned_to(c, p_end);
  prepaid := greatest(0, paid - earned);

  if rf < 0 or df < 0 then return jsonb_build_object('ok', false, 'message', '沒收不能是負的'); end if;
  if rf > prepaid then
    return jsonb_build_object('ok', false, 'message',
      format('沒收租金 %s 超過預收沒住的 %s', to_char(rf, 'FM999,999,990'), to_char(prepaid, 'FM999,999,990')));
  end if;
  if df > dep then
    return jsonb_build_object('ok', false, 'message',
      format('沒收押金 %s 超過押金可結算 %s', to_char(df, 'FM999,999,990'), to_char(dep, 'FM999,999,990')));
  end if;
  refund := (prepaid - rf) + (dep - df);
  path := case when refund = 0 then 'close' when refund < 3000 then 'direct' else 'review' end;
  if refund > 0 and (coalesce(btrim(p_payee_name), '') = '' or coalesce(btrim(p_payee_account), '') = '') then
    return jsonb_build_object('ok', false, 'message', '要退還的話，房客戶名與收款帳號要填');
  end if;

  -- 契約：迄日＝終止日、停用、記終止日（觸發器會重算營收與月租單）
  st := jsonb_build_object(
          'end', p_end, 'orig_end', coalesce(st->>'orig_end', c.end_date::text), 'reason', nullif(btrim(coalesce(p_reason, '')), ''),
          'rent_paid', paid, 'earned', earned, 'prepaid', prepaid, 'deposit', dep,
          'rent_forfeit', rf, 'dep_forfeit', df, 'rent_refund', prepaid - rf, 'dep_refund', dep - df, 'refund', refund,
          'path', path, 'status', case when path = 'review' then 'review' else 'done' end,
          'settled_on', today, 'settled_by', uid);
  update public.contracts
     set end_date = p_end, active = false, terminated_on = p_end, terminate_settle = st
   where id = c.id;
  get diagnostics k = row_count;
  if k <> 1 then raise exception '契約沒有更新（多半是權限）'; end if;

  -- 終止日之後的月租單：已收（只是標記、沒有收款紀錄）的也刪 —— 未收的觸發器已經刪了
  delete from public.orders o
   where o.contract_id = c.id and o.imported_via = 'contract' and o.checkin > p_end
     and not exists (select 1 from public.order_payments p where p.order_id = o.id);

  -- 退款承載列
  if refund > 0 then
    if d.id is null then
      insert into public.deposits (contract_id, kind, estate_id, room, guest_name, amount, received_on, note, is_manual)
      values (c.id, 'deposit', c.estate_id, c.room, c.tenant_name, 0, today,
              '提前終止退款（這張契約沒有押金，預收租金的退款掛在這一列）', true)
      returning * into d;
    end if;
    -- ★ deposit_id 先寫進結算 —— 下面改成 approved 時觸發器會馬上套用
    update public.contracts set terminate_settle = terminate_settle || jsonb_build_object('deposit_id', d.id) where id = c.id;
    update public.deposits
       set terminate_contract_id = c.id, refund_amount = refund,
           payee_name = btrim(p_payee_name), payee_bank_code = nullif(btrim(coalesce(p_payee_bank_code, '')), ''),
           payee_account = btrim(p_payee_account),
           planned_refund_on = p_planned_on,
           returned_method = nullif(btrim(coalesce(p_returned_method, '')), ''),
           returned_account = case when coalesce(p_returned_method, '') in ('', 'cash') then null
                                   else nullif(btrim(coalesce(p_returned_account, '')), '') end,
           refund_requested_by = uid, refund_requested_at = now(),
           manager_approved_by = null, manager_approved_at = null, admin_approved_by = null, admin_approved_at = null,
           rejected_by = null, rejected_at = null, reject_reason = null,
           refund_status = case when path = 'direct' then 'approved' else 'pending' end
     where id = d.id;
    get diagnostics k = row_count;
    if k <> 1 then raise exception '押金那一列沒有更新（多半是權限）'; end if;
  end if;
  if d.id is not null and refund = 0 then
    update public.contracts set terminate_settle = terminate_settle || jsonb_build_object('deposit_id', d.id) where id = c.id;
  end if;

  -- 沒收變收入：不用審的現在就做（direct 時上面改成 approved 觸發器已經做了，這裡冪等）
  if path <> 'review' then
    perform public.terminate_settle_apply(c.id, today);
  end if;

  -- 全部沒收：押金結案「已沒收」
  if path = 'close' and d.id is not null and dep > 0 then
    update public.deposits
       set forfeited_on = today, forfeited_by = uid, terminate_contract_id = c.id,
           forfeit_order_id = (select o.id from public.orders o where o.contract_id = c.id
                                and o.item_name = '提前解約・沒收押金' order by o.created_at desc limit 1)
     where id = d.id;
  end if;

  return jsonb_build_object('ok', true, 'path', path, 'refund', refund, 'prepaid', prepaid, 'deposit', dep,
    'message', case path
      when 'close'  then case when rf + df = 0 then '已終止，沒有要退或沒收的錢'
                         else format('已終止，沒收 %s 記成其他收入', to_char(rf + df, 'FM999,999,990')) end
      when 'direct' then format('已終止，沒收 %s 記成其他收入；退還 %s 未滿 3,000，直接排匯款',
                                to_char(rf + df, 'FM999,999,990'), to_char(refund, 'FM999,999,990'))
      else format('已終止；退還 %s 已送審，核可後沒收 %s 才記成收入', to_char(refund, 'FM999,999,990'), to_char(rf + df, 'FM999,999,990')) end);
end $fn$;
comment on function public.terminate_contract_settle(uuid, date, numeric, numeric, text, text, text, text, date, text, text) is
  '契約提前終止結算：預收沒住的（月租單已收 − 住到終止日）與押金，各自分沒收／退還。退還 0 結案、<3000 免審、≥3000 送審。migration_331。';
revoke all on function public.terminate_contract_settle(uuid, date, numeric, numeric, text, text, text, text, date, text, text) from public;
grant execute on function public.terminate_contract_settle(uuid, date, numeric, numeric, text, text, text, text, date, text, text) to authenticated;


-- ⑤ 押金那一列核可／駁回／確認匯款 → 同步契約的結算
create or replace function public.trg_dep_terminate_settle() returns trigger
language plpgsql security definer set search_path = public as $fn$
begin
  if new.terminate_contract_id is null then return new; end if;
  if new.refund_status is distinct from old.refund_status then
    if new.refund_status = 'approved' then
      perform public.terminate_settle_apply(new.terminate_contract_id, (now() at time zone 'Asia/Taipei')::date);
    elsif new.refund_status = 'rejected' then
      update public.contracts set terminate_settle = coalesce(terminate_settle, '{}'::jsonb) || '{"status":"rejected"}'::jsonb
       where id = new.terminate_contract_id and coalesce(terminate_settle->>'status', '') = 'review';
    end if;
  end if;
  if new.returned_on is not null and old.returned_on is null then
    update public.contracts
       set terminate_settle = coalesce(terminate_settle, '{}'::jsonb) || jsonb_build_object('status', 'done', 'returned_on', new.returned_on)
     where id = new.terminate_contract_id;
  end if;
  return new;
end $fn$;
drop trigger if exists trg_dep_terminate_settle on public.deposits;
create trigger trg_dep_terminate_settle after update of refund_status, returned_on on public.deposits
  for each row execute function public.trg_dep_terminate_settle();

do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('331_contract_terminate');
  end if;
end $do$;

commit;

-- ═══ 自檢（在 commit 後面 —— 看不到那張表就是整支回滾了） ═══════════
select 1 as 序, '欄位在（契約終止日、結算、押金承載）' as 檢查,
       (select count(*)::text || ' / 3' from information_schema.columns where table_schema = 'public'
         and ((table_name = 'contracts' and column_name in ('terminated_on', 'terminate_settle'))
           or (table_name = 'deposits' and column_name = 'terminate_contract_id'))) as 結果,
       case when (select count(*) from information_schema.columns where table_schema = 'public'
         and ((table_name = 'contracts' and column_name in ('terminated_on', 'terminate_settle'))
           or (table_name = 'deposits' and column_name = 'terminate_contract_id'))) = 3 then '✅' else '❌' end as 判定
union all
select 2, '營收：停用而且沒有終止日才清光',
       case when pg_get_functiondef('public.gen_contract_recognitions(public.contracts)'::regprocedure)
                 like '%not ct.active and ct.terminated_on is null then return%' then '新版' else '★ 舊的' end,
       case when pg_get_functiondef('public.gen_contract_recognitions(public.contracts)'::regprocedure)
                 like '%not ct.active and ct.terminated_on is null then return%' then '✅' else '❌' end
union all
select 3, '月租單：提前終止的留著終止日以前的應收',
       case when pg_get_functiondef('public.gen_contract_orders(public.contracts)'::regprocedure)
                 like '%(not ct.active and ct.terminated_on is null) or ct.monthly_rent%' then '新版' else '★ 舊的' end,
       case when pg_get_functiondef('public.gen_contract_orders(public.contracts)'::regprocedure)
                 like '%(not ct.active and ct.terminated_on is null) or ct.monthly_rent%' then '✅' else '❌' end
union all
select 4, '結算函式、套用、觸發器在',
       (select string_agg(proname, '、' order by proname) from pg_proc
         where proname in ('terminate_contract_settle', 'terminate_settle_apply', 'trg_dep_terminate_settle', 'contract_earned_to')),
       case when (select count(*) from pg_proc
                   where proname in ('terminate_contract_settle', 'terminate_settle_apply', 'trg_dep_terminate_settle', 'contract_earned_to')) = 4
             and exists (select 1 from pg_trigger where tgname = 'trg_dep_terminate_settle') then '✅' else '❌' end
union all
select 5, '周羽艾 6B5：住到 5/31 該收（試算，應該是 441,000）',
       coalesce((select to_char(public.contract_earned_to(c, '2026-05-31'), 'FM999,999,990')
                   from public.contracts c where c.room = '6B5' and c.tenant_name like '%周羽艾%' limit 1), '（找不到這張）'),
       case when (select public.contract_earned_to(c, '2026-05-31') from public.contracts c
                   where c.room = '6B5' and c.tenant_name like '%周羽艾%' limit 1) = 441000 then '✅' else 'ℹ 看一下數字' end
union all
select 6, '「取消入住」名目 → 其他收入（318）',
       public.order_account_code('oneoff', '取消入住'),
       case when public.order_account_code('oneoff', '取消入住') = 'other_income' then '✅' else '❌' end
order by 1;
