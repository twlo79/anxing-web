/*
 * migration_323_partial_pay.sql　2026-10-07
 * 請款單「部分付款」
 *
 * 【怎麼跑】整份貼進 Supabase SQL Editor，看最後那張自檢表。
 *          ★ 看不到自檢的表格＝整支回滾了。把錯誤訊息整段貼回來。
 *
 * ══════════════════════════════════════════════════════════
 * 【使用者 2026-10-07】
 *   「請款單 只付了部分 如這單付了 2W 會自動選項目變支出 由最低金額的開始選
 *     沒付完的到支出 會顯示 部分付款」
 *   「繼續付 會從 部分繳的 繼續扣」
 *   「明細 日期 付款$／儀錶板 應付 實付 尚差／可以寫入之後的實付」
 *
 * 【這一支做的事】
 *   ① 新表 purchase_payments：一次付款一列（日期、金額、付款方式、安幸付款帳號）
 *   ② purchase_requests.paid_amount：已付多少（列表直接讀，不用每列再查）
 *   ③ expenses.payment_id：這筆支出是哪一次付款產生的。撤銷那次付款 → 支出一起刪
 *   ④ 「一個項目只能有一筆支出」的唯一鍵改成只管一次付清的那種
 *      （部分付款一個項目會有好幾筆，一次一筆）
 *   ⑤ gen_expenses_from_pr()：有部分付款紀錄的單，付清那一刻**不再**整張產生支出
 *      （錢已經在每一次付款時記過了，再產生一次就重複）
 *   ⑥ pay_request_part()：記一筆付款 → 照順序分到項目 → 產生支出；付滿就填付款日
 *   ⑦ undo_request_payment()：撤銷一筆付款（單子還沒付清才可以）
 *
 * ★★★ 分錢順序（跟 src/lib/partial-pay.ts 的 payOrder 一樣，改一邊要改另一邊）：
 *     付過一部分還沒付滿的那一項先扣 → 金額小到大 → 項目 id
 *
 * ★★ 只管「部分付款」這條新路。沒有分次付的單，「付清」還是走原本那條
 *   （填付款日 → 觸發器產生支出、代墊、暫支），一個字都沒變。
 *
 * ★★ 不支援部分付款的單（擋下來講原因）：
 *     · 暫支款（advance_category 有值）
 *     · 安幸代墊別本帳（付款帳戶的帳本 ≠ 單的帳本）
 *   這兩種在付清那一刻要建暫付，分次付的話暫付要拆好幾列，目前沒有這個需求。
 *
 * ★ 支出標籤「部分付款」：那一項還沒付滿時，它的每一筆支出都掛這個標籤；
 *   付滿的那一刻，標籤一起拿掉。（字串跟 src/lib/expense-tags.ts 的 TAG_PARTIAL 同步）
 * ══════════════════════════════════════════════════════════
 */

begin;

-- ══════ ⓪ 閘門 ══════
do $do$
begin
  if to_regprocedure('public.gen_expenses_from_pr()') is null then
    raise exception 'gen_expenses_from_pr() 不在 —— 整支停下來沒有改任何東西。';
  end if;
  if to_regprocedure('public.lend_book_for(text,text)') is null then
    raise exception 'lend_book_for() 不在（migration_285 沒跑？）—— 整支停下來。';
  end if;
  if to_regprocedure('public.is_period_locked(text)') is null then
    raise exception 'is_period_locked() 不在 —— 整支停下來。';
  end if;
end $do$;


-- ══════ ① 付款紀錄 ══════
create table if not exists public.purchase_payments (
  id             uuid primary key default gen_random_uuid(),
  request_id     uuid not null references public.purchase_requests(id) on delete cascade,
  paid_on        date not null,
  amount         numeric not null check (amount > 0),
  payment_method text,
  pay_account    text,
  created_by     uuid default auth.uid(),
  created_at     timestamptz not null default now()
);
create index if not exists purchase_payments_req_idx on public.purchase_payments (request_id, created_at);
comment on table public.purchase_payments is
  '請款單分次付款：一次一列（migration_323）。只經由 pay_request_part()／undo_request_payment() 寫入。';

alter table public.purchase_payments enable row level security;
drop policy if exists purchase_payments_read on public.purchase_payments;
-- ★ 看得到那張請款單的人就看得到它的付款（子查詢走 purchase_requests 自己的 RLS）
create policy purchase_payments_read on public.purchase_payments
  for select to authenticated
  using (exists (select 1 from public.purchase_requests r where r.id = request_id));


-- ══════ ② 已付多少 ══════
alter table public.purchase_requests add column if not exists paid_amount numeric not null default 0;
comment on column public.purchase_requests.paid_amount is
  '部分付款累計已付（migration_323）。只有分次付的單才會 > 0；一次付清的單維持 0，看 purchased_on 就好。';


-- ══════ ③ 支出 ↔ 付款 ══════
alter table public.expenses add column if not exists payment_id uuid
  references public.purchase_payments(id) on delete cascade;
comment on column public.expenses.payment_id is
  '這筆支出是哪一次部分付款產生的（migration_323）。撤銷那次付款，支出跟著刪。一次付清的支出是 null。';


-- ══════ ④ 唯一鍵：一次付清 → 一項一筆；部分付款 → 一項一次付款一筆 ══════
alter table public.expenses drop constraint if exists expenses_source_item_id_key;
create unique index if not exists expenses_src_item_full_uniq
  on public.expenses (source_item_id) where payment_id is null;
create unique index if not exists expenses_src_item_pay_uniq
  on public.expenses (source_item_id, payment_id) where payment_id is not null;


-- ══════ ⑤ 改觸發器（拿線上那一份來改，只動兩個地方）══════
/*
 * ★★ 不重抄整支 —— 拿 pg_get_functiondef() 線上的版本，只替換兩段字：
 *   a. `if old.purchased_on is null then`
 *        → 再加「而且這張單沒有部分付款紀錄」
 *   b. `on conflict (source_item_id) do nothing`
 *        → 唯一鍵改成部分索引了，衝突條件要寫出 where
 * ★ 每一段都要剛好出現一次，不是就整支停下來（代表線上的版本跟我看的不一樣）。
 * ★ 第二次跑：已經改過（裡面有 purchase_payments）就跳過。
 */
do $do$
declare
  v   text := pg_get_functiondef('public.gen_expenses_from_pr()'::regprocedure);
  a0  text := 'if old.purchased_on is null then';
  a1  text := 'if old.purchased_on is null'
              || E'\n     and not exists (select 1 from public.purchase_payments pp where pp.request_id = new.id) then'
              || E'\n    /* ★ migration_323：分次付過的單，支出在每次付款時已經產生了，付清時不再整張產生 */';
  b0  text := 'on conflict (source_item_id) do nothing';
  b1  text := 'on conflict (source_item_id) where payment_id is null do nothing';
  na  int;
  nb  int;
begin
  if position('purchase_payments' in v) > 0 then
    raise notice 'gen_expenses_from_pr() 已經改過了，跳過';
    return;
  end if;
  na := (length(v) - length(replace(v, a0, ''))) / length(a0);
  nb := (length(v) - length(replace(v, b0, ''))) / length(b0);
  if na <> 1 or nb <> 1 then
    raise exception 'gen_expenses_from_pr() 跟預期的不一樣（a=% 次、b=% 次，都應該是 1）—— 整支停下來沒有改任何東西。把這句貼回來。', na, nb;
  end if;
  execute replace(replace(v, a0, a1), b0, b1);
end $do$;


-- ══════ ⑥ 標籤：一項還沒付滿 → 它的支出掛「部分付款」；付滿 → 拿掉 ══════
create or replace function public.pr_partial_retag(p_req uuid)
returns void
language sql
security definer
set search_path to 'public'
as $fn$
  update public.expenses e
     set tags = case
                  when x.paid < x.amount
                    then array_append(array_remove(coalesce(e.tags, '{}'), '部分付款'), '部分付款')
                  else array_remove(coalesce(e.tags, '{}'), '部分付款')
                end
    from (
      select i.id, i.amount,
             coalesce((select sum(e2.amount) from public.expenses e2
                        where e2.source_item_id = i.id and e2.payment_id is not null), 0) as paid
        from public.purchase_request_items i
       where i.request_id = p_req
    ) x
   where e.source_item_id = x.id
     and e.payment_id is not null;
$fn$;
revoke all on function public.pr_partial_retag(uuid) from public, anon, authenticated;


-- ══════ ⑦ 記一筆付款 ══════
create or replace function public.pay_request_part(
  p_req uuid, p_amount numeric, p_paid_on date, p_method text, p_account text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  r       public.purchase_requests;
  v_due   numeric;
  v_paid  numeric;
  v_left  numeric;
  v_rest  numeric := round(coalesce(p_amount, 0), 2);
  v_pay   uuid;
  v_lend  text;
  v_n     int := 0;
  v_done  boolean;
  it      record;
  g       numeric;
begin
  if coalesce(public.current_role_of(), '') not in ('manager', 'accountant', 'super_admin') then
    return jsonb_build_object('ok', false, 'message', '只有主管、會計、總經理可以記付款');
  end if;

  select * into r from public.purchase_requests where id = p_req for update;
  if not found then return jsonb_build_object('ok', false, 'message', '找不到這張請款單'); end if;
  if r.status <> 'approved' then return jsonb_build_object('ok', false, 'message', '這張單還沒核可'); end if;
  if r.purchased_on is not null then return jsonb_build_object('ok', false, 'message', '這張單已經付清了'); end if;
  if r.advance_category is not null then
    return jsonb_build_object('ok', false, 'message', '暫支款的單只能一次付清');
  end if;
  if p_paid_on is null then return jsonb_build_object('ok', false, 'message', '填付款日'); end if;
  if coalesce(p_method, '') = '' then return jsonb_build_object('ok', false, 'message', '選付款方式'); end if;
  if coalesce(p_account, '') = '' then return jsonb_build_object('ok', false, 'message', '選安幸付款帳號'); end if;
  if public.is_period_locked(to_char(p_paid_on, 'YYYYMM')) then
    return jsonb_build_object('ok', false, 'message', to_char(p_paid_on, 'YYYYMM') || ' 已關帳，不能記這個月的付款');
  end if;

  v_lend := public.lend_book_for(p_account, coalesce(r.book, 'anxing'));
  if v_lend is not null then
    return jsonb_build_object('ok', false, 'message',
      case when left(v_lend, 1) = '!' then '這個付款帳戶跟這張單的帳本對不起來，請換一個帳戶'
           else '用安幸的帳戶付別本帳＝代墊，代墊的單只能一次付清' end);
  end if;

  select coalesce(sum(amount), 0) into v_due from public.purchase_request_items where request_id = r.id;
  select coalesce(sum(amount), 0) into v_paid from public.purchase_payments where request_id = r.id;
  v_left := v_due - v_paid;
  if v_rest <= 0 then return jsonb_build_object('ok', false, 'message', '填實付金額'); end if;
  if v_rest > v_left then
    return jsonb_build_object('ok', false, 'message', '超過尚差 $' || to_char(v_left, 'FM999,999,999') || '，不能多付');
  end if;

  insert into public.purchase_payments (request_id, paid_on, amount, payment_method, pay_account)
  values (r.id, p_paid_on, v_rest, p_method, p_account)
  returning id into v_pay;

  -- ★★★ 分錢：部分付款的先 → 金額小到大 → id（跟 lib/partial-pay.ts payOrder 同一個排法）
  for it in
    select i.*, x.paid
      from public.purchase_request_items i
      cross join lateral (
        select coalesce(sum(e.amount), 0) as paid from public.expenses e
         where e.source_item_id = i.id and e.payment_id is not null) x
     where i.request_id = r.id and coalesce(i.amount, 0) > 0
     order by (x.paid > 0 and x.paid < i.amount) desc, i.amount asc, i.id asc
  loop
    exit when v_rest <= 0;
    g := least(it.amount - it.paid, v_rest);
    continue when g <= 0;
    v_rest := v_rest - g;
    v_n := v_n + 1;

    insert into public.expenses (
      spent_on, item_name, amount, amount_original, currency, fx_rate,
      account_code, purpose_type, estate_id, property_id,
      payment_method, pay_account, voucher_no, no_voucher,
      note, source_item_id, request_id, created_by, book, payment_id, tags
    ) values (
      p_paid_on, it.item_name, g,
      case when it.amount = 0 then g else round(coalesce(it.amount_original, it.amount) * g / it.amount, 2) end,
      coalesce(r.currency, 'TWD'), coalesce(r.fx_rate, 1),
      it.account_code, it.purpose_type, it.estate_id, it.property_id,
      p_method, p_account,
      case when coalesce(r.shared_voucher, true) then r.voucher_no else it.voucher_no end,
      case when coalesce(r.shared_voucher, true) then coalesce(r.no_voucher, false) else coalesce(it.no_voucher, false) end,
      concat_ws(E'\n', nullif(it.note, ''),
        r.req_no || ' 部分付款 $' || to_char(g, 'FM999,999,999') || '（這項累計 $'
        || to_char(it.paid + g, 'FM999,999,999') || '／$' || to_char(it.amount, 'FM999,999,999') || '）'),
      it.id, r.id, auth.uid(), coalesce(r.book, 'anxing'), v_pay, '{}'
    );
  end loop;

  perform public.pr_partial_retag(r.id);

  v_done := (v_paid + p_amount) >= v_due;
  update public.purchase_requests
     set paid_amount = v_paid + round(p_amount, 2),
         expense_generated_at = coalesce(expense_generated_at, now()),
         purchased_on   = case when v_done then p_paid_on else purchased_on end,
         payment_method = case when v_done then p_method  else payment_method end,
         payout_account = case when v_done then p_account else payout_account end
   where id = r.id;

  return jsonb_build_object('ok', true, 'payment_id', v_pay, 'n', v_n, 'done', v_done,
    'message', '已記付款 $' || to_char(p_amount, 'FM999,999,999') || '，產生 ' || v_n || ' 筆支出'
               || case when v_done then '・這張已付清' else '' end);
end $fn$;
revoke all on function public.pay_request_part(uuid, numeric, date, text, text) from public, anon;
grant execute on function public.pay_request_part(uuid, numeric, date, text, text) to authenticated;


-- ══════ ⑧ 撤銷一筆付款 ══════
create or replace function public.undo_request_payment(p_payment uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  p  public.purchase_payments;
  r  public.purchase_requests;
  v_paid numeric;
begin
  if coalesce(public.current_role_of(), '') not in ('manager', 'accountant', 'super_admin') then
    return jsonb_build_object('ok', false, 'message', '只有主管、會計、總經理可以撤銷付款');
  end if;
  select * into p from public.purchase_payments where id = p_payment;
  if not found then return jsonb_build_object('ok', false, 'message', '找不到這筆付款（可能已經撤銷了）'); end if;
  select * into r from public.purchase_requests where id = p.request_id for update;
  if r.purchased_on is not null then
    return jsonb_build_object('ok', false, 'message', '這張單已經付清，不能撤銷付款。要調整請到支出頁改那幾筆支出。');
  end if;
  if public.is_period_locked(to_char(p.paid_on, 'YYYYMM')) then
    return jsonb_build_object('ok', false, 'message', to_char(p.paid_on, 'YYYYMM') || ' 已關帳，不能撤銷');
  end if;

  delete from public.purchase_payments where id = p.id;   -- 支出跟著 cascade 刪掉
  perform public.pr_partial_retag(r.id);

  select coalesce(sum(amount), 0) into v_paid from public.purchase_payments where request_id = r.id;
  update public.purchase_requests
     set paid_amount = v_paid,
         expense_generated_at = case when v_paid = 0 then null else expense_generated_at end
   where id = r.id;

  return jsonb_build_object('ok', true,
    'message', '已撤銷 ' || to_char(p.paid_on, 'YYYY-MM-DD') || ' 那筆 $' || to_char(p.amount, 'FM999,999,999') || '，它產生的支出一起刪掉了');
end $fn$;
revoke all on function public.undo_request_payment(uuid) from public, anon;
grant execute on function public.undo_request_payment(uuid) to authenticated;


do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('323_partial_pay');
  end if;
end $do$;

commit;


-- ══════════════════════════════════════════════════════════
-- 自檢（看不到這張表就是整支回滾了）
-- ══════════════════════════════════════════════════════════
select * from (
  select 1 as ord, '① 付款紀錄表' as "檢查",
         case when to_regclass('public.purchase_payments') is not null then '✅ 有' else '❌ 沒有' end as "結果"
  union all
  select 2, '② 請款單「已付」欄',
         case when exists (select 1 from information_schema.columns where table_schema = 'public'
                            and table_name = 'purchase_requests' and column_name = 'paid_amount')
              then '✅ 有' else '❌ 沒有' end
  union all
  select 3, '③ 舊的唯一鍵拿掉、新的兩個在',
         case when not exists (select 1 from pg_constraint where conname = 'expenses_source_item_id_key')
               and to_regclass('public.expenses_src_item_full_uniq') is not null
               and to_regclass('public.expenses_src_item_pay_uniq') is not null
              then '✅' else '❌' end
  union all
  select 4, '④ 觸發器改到了（兩處）',
         case when position('purchase_payments' in pg_get_functiondef('public.gen_expenses_from_pr()'::regprocedure)) > 0
               and position('where payment_id is null do nothing' in pg_get_functiondef('public.gen_expenses_from_pr()'::regprocedure)) > 0
              then '✅' else '❌' end
  union all
  select 5, '⑤ 記付款／撤銷兩支函式',
         case when to_regprocedure('public.pay_request_part(uuid,numeric,date,text,text)') is not null
               and to_regprocedure('public.undo_request_payment(uuid)') is not null
              then '✅ 有' else '❌ 沒有' end
  union all
  select 6, '⑥ 既有支出有沒有一項兩筆（應該 0）',
         (select count(*)::text from (select source_item_id from public.expenses
            where source_item_id is not null and payment_id is null
            group by source_item_id having count(*) > 1) z)
) t order by ord;
