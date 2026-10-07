/* ══════════════════════════════════════════════════════════════════════
 * migration_322：非實支 → 轉成實支（批次、可撤銷）                                     2026-10-07
 *
 * 【為什麼】David：「多做一個轉成實支的按鈕，按下去可以批量選非實支的支出（物業｜時間），
 *   轉成實支並填寫繳款方式、出款帳號，存了以後寫進原本支出的明細」「同時做歷史紀錄，可以撤銷改回非實支」
 *   參考調價費支出（migration_312）的做法。
 *
 * 【做什麼】
 *   ① noncash_batches：一次「轉成實支」＝ 一批（誰、何時、幾筆、合計、付款方式、帳號、實際付款日、撤銷了沒）
 *      noncash_batch_items：每一筆**轉之前**的付款方式、帳號、備註 —— 撤銷時原樣放回
 *   ② convert_noncash(支出ids, 方式, 帳號, 付款日)：
 *      拿掉「非實支」標籤、填付款方式與帳號、備註追加一行「轉實支 YYYY-MM-DD」；金額、日期、科目一律不動
 *      不是非實支、已關帳月份的 → 跳過並講原因；一筆都轉不了就不建批次
 *   ③ undo_noncash_batch(批次id)：整批放回非實支（標籤、付款方式、帳號、備註都還原）；含已關帳月份的不給撤
 *
 * ★ 標籤字串「非實支」跟 src/lib/expense-tags.ts 的 TAG_NON_CASH 同步（那支檔頭有寫）。
 * ★ 房務產生器（排班統計「產生收支」）用 upsert ignoreDuplicates —— 已存在的列不會被改回非實支。
 * ★ 兩支函式都是 security invoker：支出的 RLS 照舊。
 * ★★ 自檢在 commit 後面 —— 看不到那張表就是整支回滾了。
 * ══════════════════════════════════════════════════════════ */

begin;

-- ① 批次
create table if not exists public.noncash_batches (
  id             uuid primary key default gen_random_uuid(),
  created_at     timestamptz not null default now(),
  created_by     uuid default auth.uid(),
  n              int not null default 0,
  total          numeric not null default 0,
  payment_method text,
  pay_account    text,
  paid_on        date,
  yms            text,
  estates        text,
  undone_at      timestamptz,
  undone_by      uuid
);
comment on table public.noncash_batches is '非實支轉實支：一次轉換＝一批，可整批撤銷（migration_322）';

create table if not exists public.noncash_batch_items (
  batch_id            uuid not null references public.noncash_batches(id) on delete cascade,
  expense_id          uuid not null references public.expenses(id) on delete cascade,
  prev_payment_method text,
  prev_pay_account    text,
  prev_note           text,
  primary key (batch_id, expense_id)
);

alter table public.noncash_batches enable row level security;
alter table public.noncash_batch_items enable row level security;
drop policy if exists ncb_rw on public.noncash_batches;
drop policy if exists ncbi_rw on public.noncash_batch_items;
create policy ncb_rw on public.noncash_batches for all
  using (public.current_role_of() in ('accountant', 'manager', 'super_admin'))
  with check (public.current_role_of() in ('accountant', 'manager', 'super_admin'));
create policy ncbi_rw on public.noncash_batch_items for all
  using (public.current_role_of() in ('accountant', 'manager', 'super_admin'))
  with check (public.current_role_of() in ('accountant', 'manager', 'super_admin'));
grant select, insert, update, delete on public.noncash_batches, public.noncash_batch_items to authenticated;

alter table public.expenses add column if not exists noncash_batch_id uuid
  references public.noncash_batches(id) on delete set null;
create index if not exists expenses_noncash_batch_idx on public.expenses (noncash_batch_id) where noncash_batch_id is not null;

-- ② 轉成實支
create or replace function public.convert_noncash(
  p_ids uuid[], p_method text, p_account text, p_paid_on date)
returns jsonb language plpgsql as $fn$
declare
  e      public.expenses;
  v_b    uuid;
  v_n    int := 0;
  v_tot  numeric := 0;
  v_skip jsonb := '[]'::jsonb;
  v_yms  text[] := '{}';
  v_est  text[] := '{}';
  why    text;
  k      int;
begin
  if auth.uid() is null then return jsonb_build_object('ok', false, 'message', '請重新登入'); end if;
  if p_ids is null or cardinality(p_ids) = 0 then return jsonb_build_object('ok', false, 'message', '先勾支出'); end if;
  if coalesce(p_method, '') = '' then return jsonb_build_object('ok', false, 'message', '先選付款方式'); end if;
  if p_paid_on is null then return jsonb_build_object('ok', false, 'message', '先填實際付款日'); end if;

  -- 先數能轉幾筆：一筆都不行就不建批次
  if not exists (select 1 from public.expenses x where x.id = any(p_ids) and '非實支' = any(x.tags)
                  and not public.is_period_locked(to_char(x.spent_on, 'YYYYMM'))) then
    return jsonb_build_object('ok', false, 'message', '勾的支出一筆都轉不了（不是非實支，或月份已關帳）');
  end if;

  insert into public.noncash_batches (payment_method, pay_account, paid_on)
  values (p_method, nullif(p_account, ''), p_paid_on) returning id into v_b;

  for e in select * from public.expenses x where x.id = any(p_ids) order by x.spent_on, x.item_name loop
    why := case
      when not ('非實支' = any(coalesce(e.tags, '{}'))) then '不是非實支（可能已經轉過）'
      when public.is_period_locked(to_char(e.spent_on, 'YYYYMM')) then to_char(e.spent_on, 'YYYYMM') || ' 已關帳'
      else null end;
    if why is not null then
      v_skip := v_skip || jsonb_build_object('id', e.id, 'item', e.item_name, 'why', why);
      continue;
    end if;

    insert into public.noncash_batch_items (batch_id, expense_id, prev_payment_method, prev_pay_account, prev_note)
    values (v_b, e.id, e.payment_method, e.pay_account, e.note);

    update public.expenses
       set tags = array_remove(coalesce(tags, '{}'), '非實支'),
           payment_method = p_method,
           pay_account = case when p_method = 'cash' and coalesce(p_account, '') = '' then null else nullif(p_account, '') end,
           noncash_batch_id = v_b,
           note = case when coalesce(note, '') = '' then '' else note || E'\n' end || '轉實支 ' || to_char(p_paid_on, 'YYYY-MM-DD')
     where id = e.id;
    get diagnostics k = row_count;
    if k <> 1 then raise exception '支出沒有更新（多半是權限）—— 這一批全部退回'; end if;

    v_n := v_n + 1; v_tot := v_tot + coalesce(e.amount, 0);
    if not (to_char(e.spent_on, 'YYYYMM') = any(v_yms)) then v_yms := v_yms || to_char(e.spent_on, 'YYYYMM'); end if;
    if e.estate_id is not null and not ((select name from public.estates where id = e.estate_id) = any(v_est)) then
      v_est := v_est || (select name from public.estates where id = e.estate_id);
    end if;
  end loop;

  update public.noncash_batches
     set n = v_n, total = v_tot,
         yms = (select string_agg(y, '、' order by y desc) from unnest(v_yms) y),
         estates = (select string_agg(s, '、' order by s) from unnest(v_est) s)
   where id = v_b;

  return jsonb_build_object('ok', true, 'batch_id', v_b, 'n', v_n, 'total', v_tot, 'skipped', v_skip,
    'message', format('已轉成實支 %s 筆，合計 %s', v_n, to_char(v_tot, 'FM999,999,999')));
end $fn$;
comment on function public.convert_noncash(uuid[], text, text, date) is
  '非實支轉實支：拿掉標籤、填付款方式與帳號、備註追加；一次＝一批，可撤銷。security invoker。migration_322。';
grant execute on function public.convert_noncash(uuid[], text, text, date) to authenticated;

-- ③ 撤銷一批
create or replace function public.undo_noncash_batch(p_batch uuid)
returns jsonb language plpgsql as $fn$
declare b public.noncash_batches; lk text; k int;
begin
  if auth.uid() is null then return jsonb_build_object('ok', false, 'message', '請重新登入'); end if;
  select * into b from public.noncash_batches where id = p_batch;
  if not found then return jsonb_build_object('ok', false, 'message', '找不到這一批'); end if;
  if b.undone_at is not null then return jsonb_build_object('ok', false, 'message', '這一批已經撤銷過了'); end if;

  select string_agg(distinct to_char(x.spent_on, 'YYYYMM'), '、') into lk
    from public.noncash_batch_items i join public.expenses x on x.id = i.expense_id
   where i.batch_id = p_batch and public.is_period_locked(to_char(x.spent_on, 'YYYYMM'));
  if lk is not null then
    return jsonb_build_object('ok', false, 'message', lk || ' 已關帳，這一批撤銷不了。要撤請會計先開帳。');
  end if;

  update public.expenses x
     set tags = case when '非實支' = any(coalesce(x.tags, '{}')) then x.tags else array_append(coalesce(x.tags, '{}'), '非實支') end,
         payment_method = i.prev_payment_method,
         pay_account = i.prev_pay_account,
         note = i.prev_note,
         noncash_batch_id = null
    from public.noncash_batch_items i
   where i.batch_id = p_batch and x.id = i.expense_id and x.noncash_batch_id = p_batch;
  get diagnostics k = row_count;

  update public.noncash_batches set undone_at = now(), undone_by = auth.uid() where id = p_batch;
  if not found then raise exception '批次狀態沒有更新（多半是權限）—— 支出也一起退回'; end if;
  return jsonb_build_object('ok', true, 'restored', k, 'message', format('已撤銷，%s 筆改回非實支', k));
end $fn$;
comment on function public.undo_noncash_batch(uuid) is
  '撤銷一批非實支轉實支：標籤、付款方式、帳號、備註原樣放回；含已關帳月份的不給撤。migration_322。';
grant execute on function public.undo_noncash_batch(uuid) to authenticated;

do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('322_noncash_to_cash');
  end if;
end $do$;

commit;

-- ═══ 自檢（在 commit 後面 —— 看不到那張表就是整支回滾了） ═══════════
select 1 as 序, '批次表、明細表在，RLS 開著' as 檢查,
       (select string_agg(relname || ' RLS ' || case when relrowsecurity then '開' else '關' end, '、' order by relname)
          from pg_class where oid in ('public.noncash_batches'::regclass, 'public.noncash_batch_items'::regclass)) as 結果,
       case when (select count(*) from pg_class where oid in ('public.noncash_batches'::regclass, 'public.noncash_batch_items'::regclass) and relrowsecurity) = 2
            then '✅' else '❌' end as 判定
union all
select 2, '兩支函式在、是 invoker（支出 RLS 照舊）',
       (select string_agg(proname || ':' || case when prosecdef then 'definer' else 'invoker' end, ' ' order by proname)
          from pg_proc where proname in ('convert_noncash', 'undo_noncash_batch')),
       case when (select count(*) from pg_proc where proname in ('convert_noncash', 'undo_noncash_batch') and not prosecdef) = 2 then '✅' else '❌' end
union all
select 3, '目前的非實支（可以轉的，參考）',
       (select count(*) || ' 筆・$' || to_char(coalesce(sum(amount), 0), 'FM999,999,999') from public.expenses where '非實支' = any(tags)),
       'ℹ'
order by 1;
