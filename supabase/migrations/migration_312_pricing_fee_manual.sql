/* ══════════════════════════════════════════════════════════════════════
 * migration_312：調價軟體支出改成「人勾、人按」—— 拿掉自動觸發，改成批次產生＋可撤銷           2026-10-03
 *
 * 【為什麼】David：「把之前產生的調價 1.5% 刪除，然後也不要用自動觸發。
 *   訂單有一個按鈕『調價支出』，勾選哪些訂單要產生支出，預覽，完成產生。
 *   下次可以選其他沒有選的產生；有歷史紀錄可以撤銷；產生過的不能重複產生。」
 *
 * 【做什麼】
 *   ① 拿掉 311 的觸發器與函式（跑過的話）；刪掉所有系統產生的調價支出（auto_key 開頭 pricing:）
 *   ② 新表 pricing_fee_batches：一次「產生支出」＝ 一批（誰、何時、幾張、合計、撤銷了沒）
 *   ③ expenses.pricing_batch_id：這筆調價支出是哪一批產生的（撤銷整批靠它）
 *   ④ gen_pricing_fees(訂單ids, 只預覽?)：同一支函式做預覽與產生 —— 公式只有一份
 *   ⑤ undo_pricing_batch(批次id)：整批拿掉；那幾張訂單回到「可以產生」
 *
 * 【規則】一張訂單一筆，金額 ＝ 訂單金額 × work_settings.pricing_fee_rate（1.5%），日期 ＝ 入住日，
 *   會計科目 service、用途 ＝ 訂單的物業。
 *   ★ 不能重複產生：auto_key = pricing:order:<訂單id>，唯一索引（308 建的）擋著 —— 不是靠畫面。
 *   ★ 收不了的（不是 Airbnb、金額 0、沒有入住日、沒有物業、入住月已關帳、已經產生過）跳過並講原因。
 *   ★ 已關帳月份的那一批撤銷不了。
 *   ★ 兩支都是 security invoker：支出的 RLS 照舊（會計／主管／總經理）。
 *
 * ★★ 自檢在 commit 後面 —— 看不到那張表就是整支回滾了。
 * ══════════════════════════════════════════════════════════ */

begin;

-- ① 拿掉自動那一套
drop trigger if exists trg_order_pricing_fee on public.orders;
drop function if exists public.order_pricing_fee();
drop function if exists public.gen_pricing_fee_expenses(text);
do $$ begin
  perform cron.unschedule(jobid) from cron.job where jobname = 'pricing_fee_daily';
exception when others then null;
end $$;


-- ② 批次
create table if not exists public.pricing_fee_batches (
  id         uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid() references public.profiles(id) on delete set null,
  n          int not null default 0,
  total      numeric not null default 0,
  /** 這一批涵蓋哪幾個入住月（六碼，頓號分隔）—— 歷史紀錄上看的 */
  yms        text,
  undone_at  timestamptz,
  undone_by  uuid references public.profiles(id) on delete set null
);
comment on table public.pricing_fee_batches is
  '調價軟體支出：一次「產生支出」＝ 一批。撤銷＝把那一批的支出整批拿掉、記 undone_at（migration_312）。';

alter table public.pricing_fee_batches enable row level security;
drop policy if exists pfb_read  on public.pricing_fee_batches;
drop policy if exists pfb_write on public.pricing_fee_batches;
create policy pfb_read  on public.pricing_fee_batches for select
  using (public.current_role_of() in ('accountant', 'manager', 'super_admin'));
create policy pfb_write on public.pricing_fee_batches for all
  using (public.current_role_of() in ('accountant', 'manager', 'super_admin'))
  with check (public.current_role_of() in ('accountant', 'manager', 'super_admin'));
grant select, insert, update, delete on public.pricing_fee_batches to authenticated, service_role;

-- ③ 支出記是哪一批
alter table public.expenses add column if not exists pricing_batch_id uuid
  references public.pricing_fee_batches(id) on delete set null;
create index if not exists expenses_pricing_batch_idx on public.expenses (pricing_batch_id) where pricing_batch_id is not null;
comment on column public.expenses.pricing_batch_id is '調價軟體支出是哪一批產生的（migration_312）。撤銷整批靠它。';

-- ①-2 刪掉之前產生的調價支出
--   ★★ 一定要放在所有 alter table expenses **之後**：expenses 上有延遲到交易結束才驗的觸發器
--     （trg_expense_deferral_sum，deferrable initially deferred）。先刪的話，刪除留下「待驗」的事件，
--     接著 alter table 就丟 55006 cannot ALTER TABLE because it has pending trigger events（2026-10-03 第一版踩到）。
create temp table _old as
  select count(*) as n, coalesce(sum(amount), 0) as amt from public.expenses where auto_key like 'pricing:%';
delete from public.expenses where auto_key like 'pricing:%';

-- ④ 預覽＋產生（同一支，公式只有一份）
create or replace function public.gen_pricing_fees(p_order_ids uuid[], p_dry boolean default true)
returns jsonb language plpgsql as $fn$
declare
  v_rate  numeric;
  v_batch uuid;
  v_rows  jsonb := '[]'::jsonb;
  v_skip  jsonb := '[]'::jsonb;
  v_n     int := 0;
  v_total numeric := 0;
  v_yms   text[] := '{}';
  o       record;
  why     text;
  amt     numeric;
  k       int;
begin
  if auth.uid() is null then
    return jsonb_build_object('ok', false, 'message', '請重新登入');
  end if;
  if p_order_ids is null or cardinality(p_order_ids) = 0 then
    return jsonb_build_object('ok', false, 'message', '先勾訂單');
  end if;
  select coalesce(pricing_fee_rate, 0.015) into v_rate from public.work_settings where id = 1;
  v_rate := coalesce(v_rate, 0.015);

  if not p_dry then
    -- 先預覽一次：一張都不能產生的話，連批次都不要建（回原因，不丟錯）
    if ((public.gen_pricing_fees(p_order_ids, true))->>'n')::int = 0 then
      return public.gen_pricing_fees(p_order_ids, true);
    end if;
    insert into public.pricing_fee_batches default values returning id into v_batch;
  end if;

  for o in
    select x.* from public.orders x where x.id = any(p_order_ids) order by x.checkin, x.property_raw
  loop
    amt := round(coalesce(o.amount, 0) * v_rate);
    why := case
      when o.source is distinct from 'airbnb' then '不是 Airbnb 訂單'
      when coalesce(o.amount, 0) <= 0 then '訂單金額是 0'
      when o.checkin is null then '沒有入住日'
      when o.estate_id is null then '沒有物業'
      when amt <= 0 then '金額太小，算出來是 0'
      when public.is_period_locked(to_char(o.checkin, 'YYYYMM')) then to_char(o.checkin, 'YYYYMM') || ' 已關帳'
      when exists (select 1 from public.expenses e where e.auto_key = 'pricing:order:' || o.id) then '已經產生過'
      else null end;
    if why is not null then
      v_skip := v_skip || jsonb_build_object('order_id', o.id, 'order_key', o.order_key, 'room', o.property_raw,
                                             'guest', o.guest_name, 'checkin', o.checkin, 'why', why);
      continue;
    end if;

    if not p_dry then
      insert into public.expenses
        (spent_on, item_name, amount, account_code, purpose_type, estate_id, property_id, note, auto_key, pricing_batch_id)
      values
        (o.checkin, '調價軟體 ' || coalesce(nullif(o.property_raw, ''), o.order_key), amt, 'service', 'estate',
         o.estate_id, o.property_id,
         'Airbnb ' || o.order_key || '・' || coalesce(nullif(o.guest_name, ''), '—') || '・'
           || to_char(o.checkin, 'YYYY-MM-DD') || '～' || coalesce(to_char(o.checkout, 'YYYY-MM-DD'), '?')
           || '・訂單 ' || to_char(round(o.amount), 'FM999,999,999') || ' × '
           || rtrim(rtrim((v_rate * 100)::text, '0'), '.') || '%',
         'pricing:order:' || o.id, v_batch);
      get diagnostics k = row_count;
      if k <> 1 then raise exception '支出沒有寫進去（多半是權限）—— 這一批全部退回'; end if;
    end if;

    v_n := v_n + 1; v_total := v_total + amt;
    if not (to_char(o.checkin, 'YYYYMM') = any(v_yms)) then v_yms := v_yms || to_char(o.checkin, 'YYYYMM'); end if;
    v_rows := v_rows || jsonb_build_object('order_id', o.id, 'spent_on', o.checkin,
                'item', '調價軟體 ' || coalesce(nullif(o.property_raw, ''), o.order_key),
                'estate_id', o.estate_id, 'amount', amt);
  end loop;

  if not p_dry then
    if v_n = 0 then
      raise exception '勾的訂單一張都不能產生 —— 什麼都沒寫';
    end if;
    update public.pricing_fee_batches
       set n = v_n, total = v_total,
           yms = (select string_agg(y, '、' order by y desc) from unnest(v_yms) y)
     where id = v_batch;
  end if;

  return jsonb_build_object('ok', v_n > 0, 'dry', p_dry, 'batch_id', v_batch,
    'n', v_n, 'total', v_total, 'rate', v_rate, 'rows', v_rows, 'skipped', v_skip,
    'message', case when v_n = 0 then '勾的訂單一張都不能產生'
                    when p_dry then format('會產生 %s 筆，合計 %s', v_n, to_char(v_total, 'FM999,999,999'))
                    else format('已產生 %s 筆調價支出，合計 %s', v_n, to_char(v_total, 'FM999,999,999')) end);
end $fn$;
comment on function public.gen_pricing_fees(uuid[], boolean) is
  '調價軟體支出：p_dry=true 只預覽，false 寫成一批。一張訂單一筆、日期＝入住日、金額＝訂單×費率；'
  '不能產生的跳過並回原因。security invoker（支出 RLS 照舊）。migration_312。';
grant execute on function public.gen_pricing_fees(uuid[], boolean) to authenticated;

-- ⑤ 撤銷一批
create or replace function public.undo_pricing_batch(p_batch uuid)
returns jsonb language plpgsql as $fn$
declare
  b  public.pricing_fee_batches;
  k  int;
  lk text;
begin
  if auth.uid() is null then
    return jsonb_build_object('ok', false, 'message', '請重新登入');
  end if;
  select * into b from public.pricing_fee_batches where id = p_batch;
  if not found then return jsonb_build_object('ok', false, 'message', '找不到這一批'); end if;
  if b.undone_at is not null then return jsonb_build_object('ok', false, 'message', '這一批已經撤銷過了'); end if;

  select string_agg(distinct to_char(spent_on, 'YYYYMM'), '、') into lk
    from public.expenses
   where pricing_batch_id = p_batch and public.is_period_locked(to_char(spent_on, 'YYYYMM'));
  if lk is not null then
    return jsonb_build_object('ok', false, 'message', lk || ' 已關帳，這一批撤銷不了。要撤請會計先開帳。');
  end if;

  delete from public.expenses where pricing_batch_id = p_batch and auto_key like 'pricing:order:%';
  get diagnostics k = row_count;
  update public.pricing_fee_batches set undone_at = now(), undone_by = auth.uid() where id = p_batch;
  if not found then raise exception '批次狀態沒有更新（多半是權限）—— 支出也一起退回'; end if;
  return jsonb_build_object('ok', true, 'removed', k, 'message', format('已撤銷，拿掉 %s 筆調價支出', k));
end $fn$;
comment on function public.undo_pricing_batch(uuid) is
  '撤銷一批調價軟體支出：整批刪掉、記 undone_at；含已關帳月份的不給撤。security invoker。migration_312。';
grant execute on function public.undo_pricing_batch(uuid) to authenticated;

do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('312_pricing_fee_manual');
  end if;
end $do$;

commit;

-- ═══ 自檢（在 commit 後面 —— 看不到那張表就是整支回滾了） ═══════════
select 1 as 序, '自動觸發拿掉了（311 的觸發器、308 的排程）' as 檢查,
       case when exists (select 1 from pg_trigger where tgname = 'trg_order_pricing_fee') then '★ 觸發器還在'
            when to_regprocedure('public.gen_pricing_fee_expenses(text)') is not null then '★ 308 的函式還在'
            else '都拿掉了' end as 結果,
       case when not exists (select 1 from pg_trigger where tgname = 'trg_order_pricing_fee')
             and to_regprocedure('public.gen_pricing_fee_expenses(text)') is null then '✅' else '❌' end as 判定
union all
select 2, '之前產生的調價支出刪掉了',
       '這次刪了 ' || (select n from _old) || ' 筆（$' || to_char((select amt from _old), 'FM999,999,999') || '）・現在剩 '
         || (select count(*) from public.expenses where auto_key like 'pricing:%' and pricing_batch_id is null) || ' 筆沒有批次的',
       case when (select count(*) from public.expenses where auto_key like 'pricing:%' and pricing_batch_id is null) = 0 then '✅' else '❌' end
union all
select 3, '批次表：RLS 開、兩條 policy、authenticated 讀得到',
       'RLS ' || (select case when relrowsecurity then '開' else '關' end from pg_class where oid = 'public.pricing_fee_batches'::regclass)
         || '・policy ' || (select count(*) from pg_policies where schemaname = 'public' and tablename = 'pricing_fee_batches')
         || '・grant ' || has_table_privilege('authenticated', 'public.pricing_fee_batches', 'select'),
       case when (select relrowsecurity from pg_class where oid = 'public.pricing_fee_batches'::regclass)
             and (select count(*) from pg_policies where schemaname = 'public' and tablename = 'pricing_fee_batches') = 2
             and has_table_privilege('authenticated', 'public.pricing_fee_batches', 'select') then '✅' else '❌' end
union all
select 4, '兩支函式在、而且是 invoker（支出 RLS 照舊）',
       (select string_agg(proname || ':' || case when prosecdef then 'definer' else 'invoker' end, ' ' order by proname)
          from pg_proc where proname in ('gen_pricing_fees', 'undo_pricing_batch')),
       case when (select count(*) from pg_proc where proname in ('gen_pricing_fees', 'undo_pricing_batch') and not prosecdef) = 2
            then '✅' else '❌' end
union all
select 5, '不能重複產生：auto_key 唯一索引在',
       coalesce((select indexname from pg_indexes where schemaname = 'public' and indexname = 'expenses_auto_key_uniq'), '★ 沒有'),
       case when exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'expenses_auto_key_uniq') then '✅' else '❌' end
union all
select 6, '母體：可以產生的 Airbnb 訂單（參考）',
       (select count(*) || ' 張' from public.orders
         where source = 'airbnb' and coalesce(amount, 0) > 0 and checkin is not null and estate_id is not null),
       'ℹ'
union all
select 7, '這支跑過了沒（schema_migrations）',
       coalesce((select name from public.schema_migrations where name = '312_pricing_fee_manual'), '（沒記到）'),
       case when exists (select 1 from public.schema_migrations where name = '312_pricing_fee_manual') then '✅' else '❌' end
order by 1;
