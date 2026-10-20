/*
 * migration_337_allowance_refund_deduct.sql　2026-10-20
 * 折讓退款可以「扣除」一筆（例：稅金 900）→ 實退 ＝ 折讓 − 扣除
 *
 * 【David】「這筆是退 18000 − 900 稅費」
 *
 * 【這一支做的事】
 *   ① deposits 多兩欄：refund_deduct_item（扣什麼，例：稅金）、refund_deduct_amount（扣多少）
 *   ② request_allowance_refund 多兩個參數（扣除項目、扣除金額），refund_amount ＝ 折讓 − 扣除
 *      ★ 舊的 7 個參數那一支拿掉 —— 留著的話前端呼叫會撞到兩支同名函式
 *   ③ 營收照舊沖「整筆折讓」（18,000）—— 扣掉的 900 不是少折讓，是代扣的稅（David 還沒定 A/B，先照 A）
 *
 * 【怎麼跑】整份貼進 Supabase SQL Editor。★★ 自檢在 commit 後面 —— 看不到那張表就是整支回滾了。
 *   ★ 先跑這支，再推程式（請款頁會撈這兩欄，沒跑的話請款頁讀不出來）。
 * ══════════════════════════════════════════════════════════
 */

begin;

do $do$
begin
  if to_regprocedure('public.request_allowance_refund(uuid, text, text, text, date, text, text)') is null
     and to_regprocedure('public.request_allowance_refund(uuid, text, text, text, date, text, text, text, numeric)') is null then
    raise exception '找不到 request_allowance_refund —— 先跑 migration_335';
  end if;
end $do$;

-- ══════ ① 欄位 ══════
alter table public.deposits add column if not exists refund_deduct_item text;
alter table public.deposits add column if not exists refund_deduct_amount numeric not null default 0;
do $do$ begin
  if not exists (select 1 from pg_constraint where conname = 'deposits_refund_deduct_chk') then
    alter table public.deposits add constraint deposits_refund_deduct_chk check (refund_deduct_amount >= 0);
  end if;
end $do$;
comment on column public.deposits.refund_deduct_item   is '折讓退款扣除的項目（例：稅金）。migration_337';
comment on column public.deposits.refund_deduct_amount is '折讓退款扣除的金額。實退 refund_amount ＝ 折讓 − 這個。migration_337';

-- ══════ ② 送審函式（多扣除兩個參數）══════
drop function if exists public.request_allowance_refund(uuid, text, text, text, date, text, text);

create or replace function public.request_allowance_refund(
  p_order uuid, p_payee_name text, p_payee_bank_code text, p_payee_account text,
  p_planned_on date, p_returned_method text, p_returned_account text,
  p_deduct_item text default null, p_deduct_amount numeric default 0
) returns jsonb language plpgsql as $fn$
declare
  uid uuid := auth.uid();
  o   public.orders;
  c   public.contracts;
  d   public.deposits;
  amt numeric;
  ded numeric := round(coalesce(p_deduct_amount, 0));
  net numeric;
  itm text := nullif(btrim(coalesce(p_deduct_item, '')), '');
  nt  text;
begin
  if uid is null then return jsonb_build_object('ok', false, 'message', '請重新登入'); end if;
  select * into o from public.orders where id = p_order;
  if not found then return jsonb_build_object('ok', false, 'message', '找不到這筆折讓（可能剛被刪了）'); end if;
  if o.fee_type is distinct from '折讓' or coalesce(o.amount, 0) >= 0 or o.contract_id is null then
    return jsonb_build_object('ok', false, 'message', '這一筆不是契約的折讓');
  end if;
  if coalesce(btrim(p_payee_name), '') = '' or coalesce(btrim(p_payee_account), '') = '' then
    return jsonb_build_object('ok', false, 'message', '要退款的話，房客戶名與收款帳號要填');
  end if;
  amt := abs(o.amount);
  if ded < 0 or ded >= amt then
    return jsonb_build_object('ok', false, 'message', '扣除金額要大於等於 0、而且小於折讓金額');
  end if;
  if ded > 0 and itm is null then itm := '扣除'; end if;
  if ded = 0 then itm := null; end if;
  net := amt - ded;
  nt := '折讓退款・' || coalesce(nullif(btrim(o.item_name), ''), '折讓')
        || case when ded > 0 then '・扣' || itm || ' ' || to_char(ded, 'FM999,999,990') else '' end;
  select * into c from public.contracts where id = o.contract_id;

  select * into d from public.deposits
   where allowance_order_id = o.id and refund_status <> 'rejected'
   order by created_at desc limit 1;

  if found then
    if d.returned_on is not null then
      return jsonb_build_object('ok', false, 'message', '這筆退款 ' || d.returned_on || ' 已經匯出了，不能再改');
    end if;
    if d.refund_status = 'approved' then
      return jsonb_build_object('ok', false, 'message', '這筆退款已經核可、等匯款 —— 要改請先到請款頁撤銷');
    end if;
    update public.deposits
       set refund_amount = net, refund_deduct_item = itm, refund_deduct_amount = ded,
           payee_name = btrim(p_payee_name), payee_bank_code = nullif(btrim(coalesce(p_payee_bank_code, '')), ''),
           payee_account = btrim(p_payee_account), planned_refund_on = p_planned_on,
           returned_method = nullif(btrim(coalesce(p_returned_method, '')), ''),
           returned_account = case when coalesce(p_returned_method, '') in ('', 'cash') then null
                                   else nullif(btrim(coalesce(p_returned_account, '')), '') end,
           note = nt,
           refund_requested_by = uid, refund_requested_at = now(),
           manager_approved_by = null, manager_approved_at = null, admin_approved_by = null, admin_approved_at = null,
           refund_status = 'pending'
     where id = d.id;
    return jsonb_build_object('ok', true, 'message', '已更新折讓退款（要重新核可）', 'deposit_id', d.id);
  end if;

  insert into public.deposits (kind, estate_id, room, guest_name, currency, amount, received_on, note, is_manual,
                               allowance_order_id, refund_amount, refund_deduct_item, refund_deduct_amount,
                               payee_name, payee_bank_code, payee_account,
                               planned_refund_on, returned_method, returned_account,
                               refund_requested_by, refund_requested_at, refund_status)
  values ('deposit', coalesce(o.estate_id, c.estate_id), coalesce(o.property_raw, c.room), coalesce(o.guest_name, c.tenant_name),
          'TWD', 0, current_date, nt, true,
          o.id, net, itm, ded, btrim(p_payee_name), nullif(btrim(coalesce(p_payee_bank_code, '')), ''), btrim(p_payee_account),
          p_planned_on, nullif(btrim(coalesce(p_returned_method, '')), ''),
          case when coalesce(p_returned_method, '') in ('', 'cash') then null else nullif(btrim(coalesce(p_returned_account, '')), '') end,
          uid, now(), 'pending')
  returning * into d;
  return jsonb_build_object('ok', true, 'message', '已送出折讓退款 實退 $' || to_char(net, 'FM999,999,990') || '，到請款頁審核', 'deposit_id', d.id);
end
$fn$;
grant execute on function public.request_allowance_refund(uuid, text, text, text, date, text, text, text, numeric) to authenticated;

do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('337_allowance_refund_deduct');
  end if;
end $do$;

commit;

-- ══════ 自檢（看不到這張表就是整支回滾了）══════
select 1 as 序, 'deposits 扣除兩欄' as 檢查,
       (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'deposits'
          and column_name in ('refund_deduct_item', 'refund_deduct_amount'))::text || ' / 2' as 結果,
       case when (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'deposits'
          and column_name in ('refund_deduct_item', 'refund_deduct_amount')) = 2 then '✅' else '❌' end as 判定
union all
select 2, '新的送審函式（9 個參數）',
       case when to_regprocedure('public.request_allowance_refund(uuid, text, text, text, date, text, text, text, numeric)') is not null then '有' else '沒有' end,
       case when to_regprocedure('public.request_allowance_refund(uuid, text, text, text, date, text, text, text, numeric)') is not null then '✅' else '❌' end
union all
select 3, '舊的 7 個參數那一支拿掉了',
       case when to_regprocedure('public.request_allowance_refund(uuid, text, text, text, date, text, text)') is null then '拿掉了' else '還在' end,
       case when to_regprocedure('public.request_allowance_refund(uuid, text, text, text, date, text, text)') is null then '✅' else '❌' end
order by 1;
