/*
 * migration_328_tax_import_batches.sql　2026-10-08
 * 稅務管理「從支出帶入」：修帶不進去、一次帶入＝一批、可以整批撤銷
 *
 * 【怎麼跑】整份貼進 Supabase SQL Editor，看最後那張自檢表。
 *          ★ 看不到自檢的表格＝整支回滾了。把錯誤訊息整段貼回來。
 *
 * 【使用者 2026-10-08】
 *   「帶入失敗：duplicate key value violates unique constraint "tax_invoice_uniq"」
 *   「1. 可以勾 全選 分月  2. 預設不要全勾  3. 無法匯進去  4. 歷史紀錄可以撤」
 *
 * 【★★★ 為什麼帶不進去】
 *   一張發票常拆在好幾筆支出上：DU68730014 ＝ 2F 管理費 5,700 ＋ 2F 租金 73,500。
 *   原本一筆支出寫一列發票 → 同一個號碼兩列 → 撞 tax_invoice_uniq（一家公司一個號碼一列），
 *   整批 216 筆一起失敗。
 *   → 畫面先把同號碼的併成一列（lib/tax-from-expense.ts toInvoiceRows），
 *     這裡多一張表記「這張發票是哪幾筆支出」。
 *   ★ 號碼先前已經手 key／上傳過的，畫面會標「已經在稅務表裡了」勾不起來（不覆蓋人家的資料）。
 *
 * 【這一支做的事】
 *   ① tax_invoice_expenses：一張發票 ↔ 好幾筆支出（一筆支出只能帶一次）
 *      ★ 舊資料（tax_invoice.expense_id）補進來，「帶過了沒」新舊一起認
 *   ② tax_import_batches：一次帶入＝一批（期別、張數、金額、稅額、誰、什麼時候）
 *      tax_invoice.import_batch_id 指回那一批
 *   ③ import_tax_from_expense()：整批寫入，任一張失敗全部退回
 *   ④ undo_tax_import()：整批撤銷（刪掉那批發票，支出就又可以帶）；已結算的期別不能撤
 *
 * ★ 權限照 tax_invoice：會計、主管、總經理。
 * ══════════════════════════════════════════════════════════
 */

begin;

create temp table if not exists _chk328 (k text primary key, v text) on commit preserve rows;
truncate _chk328;

-- ══════ ⓪ 閘門 ══════
do $do$
begin
  if to_regclass('public.tax_invoice') is null then raise exception 'tax_invoice 不在 —— 整支停下來'; end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public'
                  and table_name = 'tax_invoice' and column_name = 'expense_id') then
    raise exception 'tax_invoice 沒有 expense_id（migration_220 沒跑？）—— 整支停下來';
  end if;
end $do$;

-- ══════ ① 發票 ↔ 支出 ══════
create table if not exists public.tax_invoice_expenses (
  invoice_id uuid not null references public.tax_invoice(id) on delete cascade,
  expense_id uuid not null references public.expenses(id) on delete cascade,
  primary key (invoice_id, expense_id)
);
create unique index if not exists tax_invoice_expenses_exp_uniq on public.tax_invoice_expenses (expense_id);
comment on table public.tax_invoice_expenses is
  '進項發票是哪幾筆支出帶進來的（migration_328）。一張發票可以是好幾筆支出（同號碼拆項目），一筆支出只能帶一次。';

insert into public.tax_invoice_expenses (invoice_id, expense_id)
select t.id, t.expense_id from public.tax_invoice t
 where t.expense_id is not null
   and exists (select 1 from public.expenses e where e.id = t.expense_id)
on conflict do nothing;

alter table public.tax_invoice_expenses enable row level security;
drop policy if exists tax_invoice_expenses_all on public.tax_invoice_expenses;
create policy tax_invoice_expenses_all on public.tax_invoice_expenses for all
  using (current_role_of() = any (array['accountant','manager','super_admin']))
  with check (current_role_of() = any (array['accountant','manager','super_admin']));
grant select, insert, update, delete on public.tax_invoice_expenses to authenticated;

-- ══════ ② 批次 ══════
create table if not exists public.tax_import_batches (
  id             uuid primary key default gen_random_uuid(),
  company_tax_id text not null,
  period         text not null,
  n              int not null default 0,
  total          numeric not null default 0,
  tax            numeric not null default 0,
  created_by     uuid default auth.uid(),
  created_at     timestamptz not null default now(),
  undone_at      timestamptz,
  undone_by      uuid
);
create index if not exists tax_import_batches_idx on public.tax_import_batches (company_tax_id, created_at desc);
comment on table public.tax_import_batches is '稅務「從支出帶入」：一次帶入＝一批，可整批撤銷（migration_328）';

alter table public.tax_import_batches enable row level security;
drop policy if exists tax_import_batches_all on public.tax_import_batches;
create policy tax_import_batches_all on public.tax_import_batches for all
  using (current_role_of() = any (array['accountant','manager','super_admin']))
  with check (current_role_of() = any (array['accountant','manager','super_admin']));
grant select, insert, update, delete on public.tax_import_batches to authenticated;

alter table public.tax_invoice add column if not exists import_batch_id uuid
  references public.tax_import_batches(id) on delete set null;
create index if not exists tax_invoice_batch_idx on public.tax_invoice (import_batch_id) where import_batch_id is not null;

-- ══════ ③ 帶入 ══════
/*
 * p_rows：[{invoice_no, invoice_date, category, tax_code, counterparty, counterparty_tax_id,
 *           item_name, summary, estate_id, property_id, net_amount, tax_amount, total_amount,
 *           voucher_ref, expense_ids: [uuid,…]}, …]（lib/tax-from-expense.ts toInvoiceRows）
 * ★ security invoker：權限照 tax_invoice 的 RLS 走。
 * ★ 擋下來的情況回 ok=false 講原因，不丟例外（畫面看得懂）；寫到一半出錯就丟例外，整批退回。
 */
create or replace function public.import_tax_from_expense(p_company text, p_period text, p_rows jsonb)
returns jsonb language plpgsql as $fn$
declare
  v_b   uuid;
  v_inv uuid;
  r     jsonb;
  v_n   int := 0;
  v_tot numeric := 0;
  v_tax numeric := 0;
  v_dup text;
  v_ids uuid[];
begin
  if coalesce(public.current_role_of(), '') not in ('accountant', 'manager', 'super_admin') then
    return jsonb_build_object('ok', false, 'message', '只有會計、主管、總經理可以帶入');
  end if;
  if p_rows is null or jsonb_array_length(p_rows) = 0 then
    return jsonb_build_object('ok', false, 'message', '先勾要帶入的項目');
  end if;
  if exists (select 1 from public.tax_period where company_tax_id = p_company and period = p_period and status = 'closed') then
    return jsonb_build_object('ok', false, 'message', '這一期已經結算，要帶入請先取消結算');
  end if;

  -- 號碼已經在表裡的（手 key／上傳過）→ 不覆蓋，講出來
  select string_agg(distinct x.no, '、') into v_dup
    from (select upper(btrim(e->>'invoice_no')) as no from jsonb_array_elements(p_rows) e) x
    join public.tax_invoice t on t.company_tax_id = p_company and t.kind = 'in' and upper(t.invoice_no) = x.no;
  if v_dup is not null then
    return jsonb_build_object('ok', false, 'message', '這幾張發票已經在稅務表裡了：' || left(v_dup, 200) || '。取消勾選它們再帶一次。');
  end if;

  -- 支出已經帶過的
  select string_agg(distinct x.id::text, '、') into v_dup
    from (select (jsonb_array_elements_text(e->'expense_ids'))::uuid as id from jsonb_array_elements(p_rows) e) x
    join public.tax_invoice_expenses te on te.expense_id = x.id;
  if v_dup is not null then
    return jsonb_build_object('ok', false, 'message', '有支出已經帶過了（可能另一個視窗剛帶完）。關掉重新打開再帶一次。');
  end if;

  insert into public.tax_import_batches (company_tax_id, period) values (p_company, p_period) returning id into v_b;

  for r in select * from jsonb_array_elements(p_rows) loop
    select array_agg(x::uuid) into v_ids from jsonb_array_elements_text(r->'expense_ids') x;
    insert into public.tax_invoice (
      period, company_tax_id, kind, category, tax_code, invoice_date, invoice_no,
      counterparty, counterparty_tax_id, summary, item_name, estate_id, property_id,
      net_amount, tax_amount, total_amount, voucher_ref, source, expense_id, import_batch_id
    ) values (
      p_period, p_company, 'in', coalesce(r->>'category', '費用'), r->>'tax_code',
      (r->>'invoice_date')::date, upper(btrim(r->>'invoice_no')),
      nullif(r->>'counterparty', ''), nullif(r->>'counterparty_tax_id', ''),
      nullif(r->>'summary', ''), r->>'item_name',
      nullif(r->>'estate_id', '')::uuid, nullif(r->>'property_id', '')::uuid,
      round(coalesce((r->>'net_amount')::numeric, 0)), round(coalesce((r->>'tax_amount')::numeric, 0)),
      round(coalesce((r->>'total_amount')::numeric, 0)),
      r->>'voucher_ref', 'expense', v_ids[1], v_b
    ) returning id into v_inv;
    insert into public.tax_invoice_expenses (invoice_id, expense_id) select v_inv, unnest(v_ids);
    v_n := v_n + 1;
    v_tot := v_tot + coalesce((r->>'total_amount')::numeric, 0);
    v_tax := v_tax + coalesce((r->>'tax_amount')::numeric, 0);
  end loop;

  update public.tax_import_batches set n = v_n, total = v_tot, tax = v_tax where id = v_b;
  return jsonb_build_object('ok', true, 'batch_id', v_b, 'n', v_n,
    'message', format('已帶入 %s 張進項發票・稅額 $%s', v_n, to_char(v_tax, 'FM999,999,999')));
end $fn$;
grant execute on function public.import_tax_from_expense(text, text, jsonb) to authenticated;

-- ══════ ④ 整批撤銷 ══════
create or replace function public.undo_tax_import(p_batch uuid)
returns jsonb language plpgsql as $fn$
declare b public.tax_import_batches; k int;
begin
  if coalesce(public.current_role_of(), '') not in ('accountant', 'manager', 'super_admin') then
    return jsonb_build_object('ok', false, 'message', '只有會計、主管、總經理可以撤銷');
  end if;
  select * into b from public.tax_import_batches where id = p_batch for update;
  if not found then return jsonb_build_object('ok', false, 'message', '找不到這一批'); end if;
  if b.undone_at is not null then return jsonb_build_object('ok', false, 'message', '這一批已經撤銷過了'); end if;
  if exists (select 1 from public.tax_period where company_tax_id = b.company_tax_id and period = b.period and status = 'closed') then
    return jsonb_build_object('ok', false, 'message', '這一期已經結算，要撤銷請先取消結算');
  end if;
  delete from public.tax_invoice where import_batch_id = b.id;   -- 支出關聯跟著 cascade
  get diagnostics k = row_count;
  update public.tax_import_batches set undone_at = now(), undone_by = auth.uid() where id = b.id;
  return jsonb_build_object('ok', true, 'n', k, 'message', format('已撤銷這一批，刪掉 %s 張發票，那些支出可以重新帶入', k));
end $fn$;
grant execute on function public.undo_tax_import(uuid) to authenticated;

insert into _chk328 values ('舊資料補進關聯表', (select count(*)::text from public.tax_invoice_expenses) || ' 筆');

do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('328_tax_import_batches');
  end if;
end $do$;

commit;

-- ══════ 自檢（看不到這張表就是整支回滾了）══════
select 1 as 序, '發票↔支出關聯表、批次表、RLS' as 檢查,
       (select count(*)::text from pg_policy where polrelid in ('public.tax_invoice_expenses'::regclass, 'public.tax_import_batches'::regclass)) || ' 條 policy' as 結果,
       case when (select count(*) from pg_policy where polrelid in ('public.tax_invoice_expenses'::regclass, 'public.tax_import_batches'::regclass)) = 2
            then '✅' else '❌' end as 判定
union all
select 2, '舊的「從支出帶入」補進關聯表',
       (select v from _chk328 where k = '舊資料補進關聯表'),
       case when (select count(*) from public.tax_invoice where expense_id is not null)
               = (select count(*) from public.tax_invoice_expenses) then '✅' else '⚠ 有幾張的支出已經被刪了（不影響）' end
union all
select 3, '帶入／撤銷兩支函式',
       case when to_regprocedure('public.import_tax_from_expense(text,text,jsonb)') is not null
             and to_regprocedure('public.undo_tax_import(uuid)') is not null then '有' else '沒有' end,
       case when to_regprocedure('public.import_tax_from_expense(text,text,jsonb)') is not null
             and to_regprocedure('public.undo_tax_import(uuid)') is not null then '✅' else '❌' end
order by 1;
