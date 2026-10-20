/*
 * migration_335_allowance_refund.sql　2026-10-20
 * 契約折讓的退款走請款（填了房客帳號才走）
 *
 * 【David】「折讓填完分兩種：
 *   填對方收款帳號 → 送請款單 → 營收負向沖掉，日期以實際退款日
 *   不填對方收款帳號 → 不送請款單 → 營收負向沖掉
 *   折讓在請款自成一個標籤」
 *
 * 【這一支做的事】
 *   ① deposits 多一欄 allowance_order_id → 這筆退款是哪一張折讓（orders，fee_type = '折讓'）
 *      ★ 跟「取消結算」「提前終止」同一招：退款掛在 deposits 的一列上，請款審核、核可、匯出、
 *        匯款 Excel 全部沿用押金退款那一套，不另外做一套審核。
 *      ★ 這一列 amount = 0、不掛 contract_id／order_id —— 它不是押金，不該出現在押金與契約的押金清單裡
 *        （押金頁也會把它濾掉）。
 *   ② request_allowance_refund(折讓訂單, 戶名, 銀行代碼, 帳號, 預計匯款日, 付款方式, 付款帳號)
 *      第一次＝建一列送審；還在送審中＝改那一列（核可要重簽）；已核可或已匯出＝不能改。
 *   ③ 觸發器：那一列填了匯出日（returned_on）→ 折讓那張訂單的日期改成實際退款日
 *      ＝ 營收沖銷的月份跟著實際退款走（認列觸發器會自己重算）。
 *
 * 【怎麼跑】整份貼進 Supabase SQL Editor。★★ 自檢在 commit 後面 —— 看不到那張表就是整支回滾了。
 *   ★ 先跑這支，再推程式。
 * ══════════════════════════════════════════════════════════
 */

begin;

-- ══════ ⓪ 閘門 ══════
do $do$
begin
  if to_regclass('public.deposits') is null or to_regclass('public.orders') is null or to_regclass('public.contracts') is null then
    raise exception 'deposits／orders／contracts 有一張不在 —— 整支停下來';
  end if;
end $do$;

-- ══════ ① 欄位 ══════
alter table public.deposits add column if not exists allowance_order_id uuid
  references public.orders(id) on delete set null;
create index if not exists dep_allowance_order_idx on public.deposits (allowance_order_id) where allowance_order_id is not null;
comment on column public.deposits.allowance_order_id is
  '這一列是契約折讓的退款（migration_335）。指向那張折讓訂單。amount = 0，不是押金。';

-- ══════ ② 送審／改 ══════
create or replace function public.request_allowance_refund(
  p_order uuid, p_payee_name text, p_payee_bank_code text, p_payee_account text,
  p_planned_on date, p_returned_method text, p_returned_account text
) returns jsonb language plpgsql as $fn$
declare
  uid uuid := auth.uid();
  o   public.orders;
  c   public.contracts;
  d   public.deposits;
  amt numeric;
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
  select * into c from public.contracts where id = o.contract_id;
  amt := abs(o.amount);

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
       set refund_amount = amt,
           payee_name = btrim(p_payee_name), payee_bank_code = nullif(btrim(coalesce(p_payee_bank_code, '')), ''),
           payee_account = btrim(p_payee_account), planned_refund_on = p_planned_on,
           returned_method = nullif(btrim(coalesce(p_returned_method, '')), ''),
           returned_account = case when coalesce(p_returned_method, '') in ('', 'cash') then null
                                   else nullif(btrim(coalesce(p_returned_account, '')), '') end,
           note = '折讓退款・' || coalesce(nullif(btrim(o.item_name), ''), '折讓'),
           refund_requested_by = uid, refund_requested_at = now(),
           manager_approved_by = null, manager_approved_at = null, admin_approved_by = null, admin_approved_at = null,
           refund_status = 'pending'
     where id = d.id;
    return jsonb_build_object('ok', true, 'message', '已更新折讓退款（要重新核可）', 'deposit_id', d.id);
  end if;

  insert into public.deposits (kind, estate_id, room, guest_name, currency, amount, received_on, note, is_manual,
                               allowance_order_id, refund_amount, payee_name, payee_bank_code, payee_account,
                               planned_refund_on, returned_method, returned_account,
                               refund_requested_by, refund_requested_at, refund_status)
  values ('deposit', coalesce(o.estate_id, c.estate_id), coalesce(o.property_raw, c.room), coalesce(o.guest_name, c.tenant_name),
          'TWD', 0, current_date, '折讓退款・' || coalesce(nullif(btrim(o.item_name), ''), '折讓'), true,
          o.id, amt, btrim(p_payee_name), nullif(btrim(coalesce(p_payee_bank_code, '')), ''), btrim(p_payee_account),
          p_planned_on, nullif(btrim(coalesce(p_returned_method, '')), ''),
          case when coalesce(p_returned_method, '') in ('', 'cash') then null else nullif(btrim(coalesce(p_returned_account, '')), '') end,
          uid, now(), 'pending')
  returning * into d;
  return jsonb_build_object('ok', true, 'message', '已送出折讓退款 $' || to_char(amt, 'FM999,999,990') || '，到請款頁審核', 'deposit_id', d.id);
end
$fn$;
grant execute on function public.request_allowance_refund(uuid, text, text, text, date, text, text) to authenticated;

-- ══════ ③ 匯出了 → 折讓的日期改成實際退款日 ══════
create or replace function public.allowance_refund_paid() returns trigger language plpgsql as $fn$
begin
  if new.allowance_order_id is not null and new.returned_on is not null
     and new.returned_on is distinct from old.returned_on then
    update public.orders
       set checkin = new.returned_on, checkout = new.returned_on
     where id = new.allowance_order_id and fee_type = '折讓'
       and checkin is distinct from new.returned_on;
  end if;
  return new;
end
$fn$;
drop trigger if exists trg_dep_allowance_paid on public.deposits;
create trigger trg_dep_allowance_paid after update of returned_on on public.deposits
  for each row execute function public.allowance_refund_paid();

do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('335_allowance_refund');
  end if;
end $do$;

commit;

-- ══════ 自檢（看不到這張表就是整支回滾了）══════
select 1 as 序, 'deposits.allowance_order_id' as 檢查,
       case when exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'deposits' and column_name = 'allowance_order_id') then '有' else '沒有' end as 結果,
       case when exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'deposits' and column_name = 'allowance_order_id') then '✅' else '❌' end as 判定
union all
select 2, '送審函式 request_allowance_refund',
       case when to_regprocedure('public.request_allowance_refund(uuid, text, text, text, date, text, text)') is not null then '有' else '沒有' end,
       case when to_regprocedure('public.request_allowance_refund(uuid, text, text, text, date, text, text)') is not null then '✅' else '❌' end
union all
select 3, '匯出後改折讓日期的觸發器',
       case when exists (select 1 from pg_trigger where tgname = 'trg_dep_allowance_paid') then '有' else '沒有' end,
       case when exists (select 1 from pg_trigger where tgname = 'trg_dep_allowance_paid') then '✅' else '❌' end
order by 1;
