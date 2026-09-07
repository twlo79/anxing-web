/*
 * migration_223 —— 關帳（鎖住已結算月份的訂單）
 * ============================================================
 * 2026-09-07 使用者：「我要做一個鎖定 關帳鍵入的功能」
 *
 * ============================================================
 * 【規則】（2026-09-07 使用者逐項確認）
 *
 *   判定    `orders.checkout` 落在哪個月
 *   範圍    **只鎖短租訂單**。契約產的月租單放行
 *   時機    每月 5 號自動關上個月；會計也可以手動關／開
 *   鎖什麼  **整張訂單改不動、刪不掉**。收款、支出、押金不鎖
 *   同步    碰到鎖住的**不寫，但記一筆待處理**
 *
 * ★ 為什麼月租單放行:它是 `gen_contract_orders()` 自動產的，
 *   改契約金額時會重算整串。鎖了的話「改契約」這個動作
 *   會在舊月份上失敗，而錯誤訊息跟契約完全無關。
 *
 * ★★ 為什麼同步不直接放行:那樣關帳形同虛設 ——
 *   已經定稿的月份還是會被 Airbnb 悄悄改掉，而沒有人會發現。
 *   也不能全擋:每日同步會開始報錯，而錯誤在 GitHub Actions 裡，
 *   沒有人會去看。所以走中間:不寫、記下來、在畫面上讓人決定。
 *   （判斷原則:「建議，不自動。系統負責看見，人負責決定。」）
 *
 * ============================================================
 * 【★★★ 一個要知道的洞】
 *
 * 觸發器分辨「人」與「系統」的判準是 `auth.uid()` 是不是 null。
 * 而**從 SQL Editor 改也是 null** —— 也就是管理員直接下 SQL
 * 改鎖住的訂單**不會被擋**，只會被記成一筆待處理。
 *
 * 那是刻意的（要留一條給管理員的路），但不要以為關帳是絕對的。
 *
 * 【怎麼跑】整份貼進 Supabase SQL Editor，看最後那張自檢表。
 */

begin;

-- ══════════════════════════════════════════════════════════
-- 1. 關帳紀錄（一個月一列）
-- ══════════════════════════════════════════════════════════
create table if not exists public.period_lock (
  ym           text primary key check (ym ~ '^\d{6}$'),
  locked       boolean not null default true,
  /** 是不是排程自動關的。手動關的是 false —— 兩者在畫面上分得開 */
  auto         boolean not null default false,
  locked_at    timestamptz,
  locked_by    uuid,
  /*
   * ★★ 打開的時間要留著。`close_due_periods()` 靠它判斷
   *   「這個月被人打開過」—— 打開過的**不自動關回去**，
   *   不然會計正在改，隔天清晨又被鎖起來。
   */
  reopened_at  timestamptz,
  reopened_by  uuid,
  note         text
);

/*
 * ★★★ 新建表一定要接 RLS ＋ policy。
 *   Supabase 的 `rls_auto_enable()` 會自動開 RLS，而沒有 policy
 *   等於全部擋掉 —— 查詢**回成功、0 列**，畫面上是一個很正常的
 *   「還沒有任何月份關帳」（CLAUDE.md，migration_206 踩過）。
 */
alter table public.period_lock enable row level security;

do $do$ begin
  create policy period_lock_read on public.period_lock
    for select using (
      current_role_of() = any (array['accountant','manager','super_admin'])
    );
exception when duplicate_object then null; end $do$;

do $do$ begin
  create policy period_lock_write on public.period_lock
    for all using (
      current_role_of() = any (array['accountant','manager','super_admin'])
    ) with check (
      current_role_of() = any (array['accountant','manager','super_admin'])
    );
exception when duplicate_object then null; end $do$;

comment on table public.period_lock is
  '關帳紀錄，一個月一列（migration_223）。'
  '★ `locked=false` 而且 `reopened_at` 有值 = 被人手動打開過 —— '
  '排程**不會**把它自動關回去，不然會計正在改就被鎖住。';

-- ══════════════════════════════════════════════════════════
-- 2. 同步被擋下來的異動
-- ══════════════════════════════════════════════════════════
create table if not exists public.order_lock_pending (
  id           uuid primary key default gen_random_uuid(),
  order_id     uuid not null references public.orders(id) on delete cascade,
  ym           text not null,
  /** 本來要改成什麼：`{欄位: [舊值, 新值]}`。刪除是 `{"_刪除": 整列}` */
  changes      jsonb not null,
  attempted_at timestamptz not null default now(),
  resolved     boolean not null default false,
  resolved_at  timestamptz,
  resolved_by  uuid
);

create index if not exists order_lock_pending_open_idx
  on public.order_lock_pending (ym) where not resolved;

alter table public.order_lock_pending enable row level security;

do $do$ begin
  create policy olp_read on public.order_lock_pending
    for select using (
      current_role_of() = any (array['accountant','manager','super_admin'])
    );
exception when duplicate_object then null; end $do$;

do $do$ begin
  create policy olp_write on public.order_lock_pending
    for all using (
      current_role_of() = any (array['accountant','manager','super_admin'])
    ) with check (
      current_role_of() = any (array['accountant','manager','super_admin'])
    );
exception when duplicate_object then null; end $do$;

comment on table public.order_lock_pending is
  '關帳後同步想改但被擋下來的異動（migration_223）。'
  '★ 不寫進訂單，但也不讓它消失 —— 在訂單頁顯示差異讓人決定。';

-- ══════════════════════════════════════════════════════════
-- 3. 這個月關了沒
-- ══════════════════════════════════════════════════════════
create or replace function public.is_period_locked(p_ym text)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $fn$
  select coalesce((select locked from public.period_lock where ym = p_ym), false);
$fn$;

-- ══════════════════════════════════════════════════════════
-- ★★★ 4. 守門的觸發器
-- ══════════════════════════════════════════════════════════
create or replace function public.orders_period_lock_guard()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  v_ym   text;
  v_uid  uuid := auth.uid();
  v_diff jsonb := '{}'::jsonb;
  k      text;
  oj     jsonb;
  nj     jsonb;
begin
  /*
   * ★ 月租單放行（使用者指定）。它會隨契約重算，
   *   鎖了的話「改契約」會在舊月份上失敗，而訊息跟契約無關。
   */
  if coalesce(old.imported_via, '') = 'contract' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  -- 沒有退房日就判不出月份 —— 放行，不要用猜的鎖人
  if old.checkout is null then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  v_ym := to_char(old.checkout, 'YYYYMM');
  if not public.is_period_locked(v_ym) then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  -- ── 這個月鎖住了 ──────────────────────────────────────
  /*
   * ★★ 人在改 → 擋下來，而且**講人話**。
   *   一句 SQL 例外看不懂，使用者只會覺得「存不了」。
   */
  if v_uid is not null then
    raise exception '% 已經關帳，這張訂單改不動。要改的話請到權限管理 → 關帳，把那個月打開。',
      substr(v_ym, 1, 4) || '-' || substr(v_ym, 5, 2)
      using errcode = 'check_violation';
  end if;

  /*
   * ★★★ 系統路徑（Airbnb 同步、匯入、SQL Editor）——
   *   **不寫，但記一筆**。直接放行的話關帳形同虛設；
   *   直接擋的話每日同步會靜默失敗。
   */
  if tg_op = 'DELETE' then
    insert into public.order_lock_pending (order_id, ym, changes)
    values (old.id, v_ym, jsonb_build_object('_刪除', to_jsonb(old)));
    return null;                       -- 不刪
  end if;

  oj := to_jsonb(old);
  nj := to_jsonb(new);
  for k in select jsonb_object_keys(nj) loop
    if oj -> k is distinct from nj -> k then
      v_diff := v_diff || jsonb_build_object(k, jsonb_build_array(oj -> k, nj -> k));
    end if;
  end loop;

  -- ★ 沒有實際變動就安靜跳過。同步常常送出一模一樣的值，
  --   每次都記一筆的話待處理清單會被洗掉
  if v_diff = '{}'::jsonb then return null; end if;

  insert into public.order_lock_pending (order_id, ym, changes)
  values (old.id, v_ym, v_diff);
  return null;                         -- ★ 不改
end $fn$;

drop trigger if exists trg_orders_period_lock on public.orders;
create trigger trg_orders_period_lock
  before update or delete on public.orders
  for each row execute function public.orders_period_lock_guard();

-- ══════════════════════════════════════════════════════════
-- 5. 每月 5 號自動關上個月（冪等，給排程呼叫）
-- ══════════════════════════════════════════════════════════
/*
 * ★ 這個專案**沒有 pg_cron**（2026-09-07 查過），
 *   所以排程掛在 GitHub Actions 上，每天呼叫這一支一次。
 *
 * ★★ 冪等:關過了就什麼都不做，重跑無害、漏跑一天隔天補上。
 *   回傳一列說明做了什麼 —— 排程的 log 才看得懂。
 */
create or replace function public.close_due_periods()
returns table (ym text, action text)
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  v_today date := (now() at time zone 'Asia/Taipei')::date;
  v_prev  text := to_char(date_trunc('month', v_today) - interval '1 day', 'YYYYMM');
begin
  if extract(day from v_today) < 5 then
    return query select v_prev, '還沒到 5 號，不關'::text; return;
  end if;

  if exists (select 1 from public.period_lock p where p.ym = v_prev and p.locked) then
    return query select v_prev, '已經關過了'::text; return;
  end if;

  /*
   * ★★★ 被人手動打開過的**不自動關回去**。
   *   不然會計打開七月正在改，隔天清晨又被鎖起來 ——
   *   而他不會知道是排程做的，只會覺得系統壞了。
   *   他改完自己關（那時 auto = false）。
   */
  if exists (select 1 from public.period_lock p
              where p.ym = v_prev and not p.locked and p.reopened_at is not null) then
    return query select v_prev, '被手動打開過，不自動關回去'::text; return;
  end if;

  insert into public.period_lock (ym, locked, auto, locked_at)
  values (v_prev, true, true, now())
  on conflict (ym) do update
    set locked = true, auto = true, locked_at = now();

  return query select v_prev, '已關帳'::text;
end $fn$;

do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('223_period_lock');
  end if;
end $do$;

commit;


-- ══════════════════════════════════════════════════════════
-- 自檢
-- ══════════════════════════════════════════════════════════
select v.ord, v."檢查", v."結果", v."判定" from (

  select 1, '① 兩張表建好了',
         coalesce((select string_agg(c.relname::text || '（' || cnt.n::text || ' 條 policy）', '、')
                     from pg_class c
                     join pg_namespace n on n.oid = c.relnamespace
                     cross join lateral (select count(*) as n from pg_policies pp
                                          where pp.schemaname = 'public' and pp.tablename = c.relname) cnt
                    where n.nspname = 'public' and c.relkind = 'r'
                      and c.relname in ('period_lock', 'order_lock_pending')), '（沒建出來）'),
         /*
          * ★★★ 沒有 policy 等於全部擋掉 —— 查詢回成功、0 列，
          *   畫面上是一個很正常的「還沒有任何月份關帳」。
          */
         case when (select count(*) from pg_policies
                     where schemaname = 'public'
                       and tablename in ('period_lock', 'order_lock_pending')) >= 4
              then '✅ 兩張表各有讀寫 policy'
              else '❌ policy 不夠 —— 查詢會回成功且 0 列，而畫面看起來很正常' end

  union all
  select 2, '★★ ② 守門觸發器是 BEFORE UPDATE/DELETE',
         coalesce((select case when (t.tgtype & 2) <> 0 then 'BEFORE' else 'AFTER ❌' end || ' ' ||
                     concat_ws('/',
                       case when (t.tgtype &  8) <> 0 then 'DELETE' end,
                       case when (t.tgtype & 16) <> 0 then 'UPDATE' end)
                     from pg_trigger t
                     join pg_class c on c.oid = t.tgrelid
                     join pg_namespace n on n.oid = c.relnamespace
                    where not t.tgisinternal and n.nspname = 'public'
                      and c.relname = 'orders'
                      and t.tgname::text = 'trg_orders_period_lock'), '（沒裝上）'),
         case when exists (select 1 from pg_trigger t
                            join pg_class c on c.oid = t.tgrelid
                            join pg_namespace n on n.oid = c.relnamespace
                           where not t.tgisinternal and n.nspname = 'public'
                             and c.relname = 'orders'
                             and t.tgname::text = 'trg_orders_period_lock'
                             and (t.tgtype & 2) <> 0)
              then '✅ BEFORE —— 才擋得住' else '❌ AFTER 的話擋不掉，只會事後才知道' end

  union all
  -- ★ 月租單一定要放行,不然改契約會在舊月份上失敗
  select 3, '★ ③ 守門函式有沒有放行月租單',
         case when coalesce((select pg_get_functiondef(p.oid) from pg_proc p
                               join pg_namespace n on n.oid = p.pronamespace
                              where n.nspname = 'public' and p.prokind in ('f','p')
                                and p.proname::text = 'orders_period_lock_guard'), '')
                   ilike '%contract%'
              then '有 —— imported_via = ''contract'' 直接 return'
              else '沒有 ❌' end,
         case when coalesce((select pg_get_functiondef(p.oid) from pg_proc p
                               join pg_namespace n on n.oid = p.pronamespace
                              where n.nspname = 'public' and p.prokind in ('f','p')
                                and p.proname::text = 'orders_period_lock_guard'), '')
                   ilike '%contract%'
              then '✅ 改契約不會被舊月份擋住'
              else '❌ 月租單會被鎖 —— 改契約金額時會失敗而訊息跟契約無關' end

  union all
  select 4, '④ 兩支函式都在',
         coalesce((select string_agg(p.proname::text, '、' order by p.proname)
                     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                    where n.nspname = 'public' and p.prokind in ('f','p')
                      and p.proname::text in ('is_period_locked', 'close_due_periods')), '（找不到）'),
         case when (select count(*) from pg_proc p
                     join pg_namespace n on n.oid = p.pronamespace
                    where n.nspname = 'public' and p.prokind in ('f','p')
                      and p.proname::text in ('is_period_locked', 'close_due_periods')) = 2
              then '✅' else '❌ 少了一支' end

  union all
  -- ★★ 今天跑 close_due_periods() 會怎樣（唯讀試算,這裡不真的呼叫）
  select 5, '★★ ⑤ 今天是幾號、上個月是哪個月',
         to_char((now() at time zone 'Asia/Taipei')::date, 'YYYY-MM-DD') || '（'
           || extract(day from (now() at time zone 'Asia/Taipei')::date)::int::text || ' 號）'
           || '，上個月 = '
           || to_char(date_trunc('month', (now() at time zone 'Asia/Taipei')::date)
                      - interval '1 day', 'YYYY-MM'),
         case when extract(day from (now() at time zone 'Asia/Taipei')::date) >= 5
              then 'ℹ 今天呼叫 close_due_periods() 會把上個月關起來'
              else 'ℹ 今天呼叫會回「還沒到 5 號」' end

  union all
  /*
   * ★★★ 母體要判定。這一支只建結構、不關任何一個月 ——
   *   所以現在一定是 0 個月已關。要真的關請到權限管理按，
   *   或等排程在 5 號跑。
   */
  select 6, '★★★ ⑥ 目前關了幾個月',
         (select count(*)::text || ' 列，其中鎖住的 '
                 || count(*) filter (where locked)::text || ' 個月'
            from public.period_lock),
         case when (select count(*) from public.period_lock) = 0
              then '✅ 0 —— **正常**。這一支只建結構，要關請到權限管理按'
              else 'ℹ 已經有關帳紀錄了' end

  union all
  select 7, '⑦ 可以被鎖的短租訂單有幾張',
         (select count(*)::text || ' 張（排除契約月租單）'
            from public.orders
           where coalesce(imported_via, '') <> 'contract' and checkout is not null),
         case when (select count(*) from public.orders
                     where coalesce(imported_via, '') <> 'contract' and checkout is not null) = 0
              then '⚠ 一張都沒有 —— 上面驗的只是結構' else '✅ 有母體' end

  union all
  select 8, '⑧ 這一支有沒有被記錄',
         coalesce((select max(name) from public.schema_migrations
                    where name = '223_period_lock'), '（沒記到）'),
         case when exists (select 1 from public.schema_migrations
                            where name = '223_period_lock')
              then '✅' else '❌ record_migration 沒寫進去' end

) v(ord, "檢查", "結果", "判定") order by v.ord;
