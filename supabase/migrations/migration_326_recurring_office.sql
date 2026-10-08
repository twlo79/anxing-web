/*
 * migration_326_recurring_office.sql　2026-10-08
 * 定期收費可以記到「安幸辦公室」—— 時兆那四項改過去
 *
 * 【怎麼跑】整份貼進 Supabase SQL Editor，看最後那張自檢表。
 *          ★ 看不到自檢的表格＝整支回滾了。把錯誤訊息整段貼回來。
 *
 * 【使用者 2026-10-08】「這計到營收 房源改成 安幸辦公室」
 *   → 問過：物業＝安幸辦公室（不算時兆的營收，跟一次性收入選「安幸辦公室」一樣）
 *   → 範圍：垃圾代收、楊特助清潔費、洗衣機、烘衣機
 *
 * 【這一支做的事】
 *   ① recurring_charges 多一欄 purpose_type：estate（掛物業，原本的）／office（安幸辦公室）
 *      ★ 定期收費本身還是放在時兆底下（面板照物業分組，方便記），
 *        只是**記進營收的那筆**不掛時兆：estate_id、房源都空，purpose_type = office
 *   ② record_recurring()：記一筆時照 purpose_type 決定掛哪（照 317 的原樣抄，只改掛法那幾行）
 *   ③ trg_recurring_sync()：改了 purpose_type 也同步到還沒收款的月份
 *   ④ 時兆那四項改成 office，並且把**已經記進去的每一個月**都改過去（含已收款的）
 *      ★ 已關帳的月份不動（關帳守衛會擋，也不該動），自檢會列出有幾筆
 *
 * ★ 改的只有「掛在哪」：金額、日期、收款都不動。
 * ══════════════════════════════════════════════════════════
 */

begin;

create temp table if not exists _chk326 (k text primary key, v text) on commit preserve rows;
truncate _chk326;

-- ══════ ⓪ 閘門 ══════
do $do$
begin
  if to_regclass('public.recurring_charges') is null then raise exception 'recurring_charges 不在 —— 整支停下來'; end if;
  if to_regprocedure('public.record_recurring(uuid,uuid,text,text,text,numeric,text)') is null then
    raise exception 'record_recurring() 不在（migration_317 沒跑？）—— 整支停下來';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public'
                  and table_name = 'orders' and column_name = 'purpose_type') then
    raise exception 'orders 沒有 purpose_type —— 整支停下來';
  end if;
end $do$;

-- ══════ ① 欄位 ══════
alter table public.recurring_charges add column if not exists purpose_type text not null default 'estate';
do $do$ begin
  alter table public.recurring_charges add constraint rc_purpose_chk check (purpose_type in ('estate', 'office'));
exception when duplicate_object then null; end $do$;
comment on column public.recurring_charges.purpose_type is
  '記進營收時掛哪（migration_326）：estate＝掛這個物業（原本）、office＝安幸辦公室（estate_id 與房源都空）。'
  '★ 項目本身的 estate_id 還是留著 —— 定期收費面板靠它分組。';

-- ══════ ② 記一筆（照 317 抄，只改「掛在哪」）══════
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
  v_est  uuid;          -- migration_326：記進營收的物業（office → 空）
  v_pur  text;          -- migration_326：estate／office
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

  -- ★ migration_326：安幸辦公室 → 不掛物業、不掛房源
  v_pur := coalesce(v_rc.purpose_type, 'estate');
  if v_pur = 'office' then
    v_est := null; v_pid := null; v_praw := null;
  else
    v_est := v_rc.estate_id;
    v_pid := coalesce(v_rc.property_id, public.recurring_whole_property(v_rc.estate_id));
    select name into v_praw from public.properties where id = v_pid;
  end if;
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
           fee_type = v_rc.fee_type, estate_id = v_est, property_id = v_pid, property_raw = v_praw,
           purpose_type = v_pur
     where id = v_o.id;
    get diagnostics k = row_count;
    if k <> 1 then raise exception '沒存到（多半是權限）'; end if;
    return jsonb_build_object('ok', true, 'updated', true, 'rc_id', v_rc.id,
      'message', format('已改 %s %s：$%s', v_item, p_ym, to_char(p_amount, 'FM999,999,999')));
  end if;

  insert into public.orders (order_key, source, estate_id, property_id, property_raw, guest_name,
    checkin, checkout, nights, amount, deposit, fee_type, item_name, note, imported_via, paid, purpose_type)
  values (v_key, 'oneoff', v_est, v_pid, v_praw, v_rc.item_name,
    v_me, v_me, 0, p_amount, 0, v_rc.fee_type, v_rc.item_name, v_note, 'recurring', false, v_pur);
  return jsonb_build_object('ok', true, 'updated', false, 'rc_id', v_rc.id,
    'message', format('已記 %s %s：$%s', v_item, p_ym, to_char(p_amount, 'FM999,999,999')));
end $fn$;
comment on function public.record_recurring(uuid, uuid, text, text, text, numeric, text) is
  '定期收費記一筆：項目沒有就建、那個月沒有就新增有就改金額（同項目同月只有一筆）。日期月底、客戶＝項目。'
  '已收款不改、已關帳不收、金額 > 0。管家／會計／主管／總經理。migration_317；326 起照 purpose_type 決定掛物業或安幸辦公室。';

-- ══════ ③ 同步觸發器（照 317 抄，多比 purpose_type）══════
create or replace function public.trg_recurring_sync() returns trigger
 language plpgsql security definer as $fn$
declare v_pid uuid; v_praw text; v_est uuid; v_pur text;
begin
  if tg_op = 'DELETE' then
    return old;      -- migration_317：記進去的月份是真的收入，項目刪了也留著
  end if;
  if tg_op = 'UPDATE' and (new.item_name, new.fee_type, new.estate_id, new.property_id, new.purpose_type)
                is distinct from (old.item_name, old.fee_type, old.estate_id, old.property_id, old.purpose_type) then
    v_pur := coalesce(new.purpose_type, 'estate');
    if v_pur = 'office' then
      v_est := null; v_pid := null; v_praw := null;
    else
      v_est := new.estate_id;
      v_pid := coalesce(new.property_id, public.recurring_whole_property(new.estate_id));
      select name into v_praw from public.properties where id = v_pid;
    end if;
    update public.orders
       set item_name = new.item_name, guest_name = new.item_name, fee_type = new.fee_type,
           estate_id = v_est, property_id = v_pid, property_raw = v_praw, purpose_type = v_pur
     where imported_via = 'recurring' and order_key like 'RC_' || new.id || '_%'
       and paid = false and not public.is_period_locked(right(order_key, 6));
  end if;
  return new;
end $fn$;

-- ══════ ④ 時兆那四項改成安幸辦公室 ══════
do $do$
declare
  v_ids uuid[];
  n int;
begin
  select array_agg(rc.id) into v_ids
    from public.recurring_charges rc
    join public.estates e on e.id = rc.estate_id
   where e.name = '時兆'
     and rc.item_name in ('垃圾代收', '楊特助清潔費', '洗衣機', '烘衣機');
  n := coalesce(cardinality(v_ids), 0);
  insert into _chk326 values ('找到的項目', n || ' 項');
  if n = 0 then
    raise exception '時兆底下找不到那四項（垃圾代收／楊特助清潔費／洗衣機／烘衣機）—— 整支停下來沒有改任何東西';
  end if;
  if n > 4 then
    raise exception '時兆底下符合的項目有 % 項（應該最多 4 項，可能有同名重複）—— 整支停下來沒有改任何東西', n;
  end if;

  -- 項目本身（觸發器會順手同步還沒收款的月份）
  update public.recurring_charges set purpose_type = 'office' where id = any(v_ids);

  -- 已經記進去的每一個月（含已收款），已關帳的不動
  update public.orders o
     set estate_id = null, property_id = null, property_raw = null, purpose_type = 'office'
   where o.imported_via = 'recurring'
     and exists (select 1 from unnest(v_ids) x where o.order_key like 'RC_' || x || '_%')
     and not public.is_period_locked(right(o.order_key, 6))
     and (o.estate_id is not null or o.property_id is not null or o.purpose_type is distinct from 'office');
  get diagnostics n = row_count;
  insert into _chk326 values ('另外改過去的月份（多半是已收款的）', n || ' 筆');
end $do$;

do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('326_recurring_office');
  end if;
end $do$;

commit;

-- ══════ 自檢（看不到這張表就是整支回滾了）══════
select rc.item_name as 項目,
       rc.purpose_type as 掛法,
       count(o.id) filter (where o.purpose_type = 'office' and o.estate_id is null) as 已在安幸辦公室,
       count(o.id) filter (where not (o.purpose_type = 'office' and o.estate_id is null)) as 還掛在時兆,
       count(o.id) filter (where not (o.purpose_type = 'office' and o.estate_id is null)
                             and public.is_period_locked(right(o.order_key, 6))) as 其中已關帳,
       case when count(o.id) filter (where not (o.purpose_type = 'office' and o.estate_id is null)
                                       and not public.is_period_locked(right(o.order_key, 6))) = 0
            then '✅' else '❌' end as 判定
  from public.recurring_charges rc
  join public.estates e on e.id = rc.estate_id and e.name = '時兆'
  left join public.orders o on o.imported_via = 'recurring' and o.order_key like 'RC_' || rc.id || '_%'
 where rc.item_name in ('垃圾代收', '楊特助清潔費', '洗衣機', '烘衣機')
 group by rc.item_name, rc.purpose_type
 order by 1;
