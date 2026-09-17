/*
 * migration_262_board.sql　2026-09-17
 * 佈告欄：帳密 ＋ 活動（開會／團聚）＋ 開會資料
 *
 * 【怎麼跑】整份貼進 Supabase SQL Editor，看最後那張自檢表。
 *          ★ 看不到自檢的表格＝整支回滾了，不是「跑成功但沒輸出」。
 *            自檢在 commit 後面，成功就一定看得到。把錯誤訊息整段貼回來。
 *
 * ══════════════════════════════════════════════════════════
 * 【★★★ 這一支跟別支不一樣：它存的是真的帳號密碼】
 *
 * 使用者 2026-09-17：「帳密 自己成一格 > 目的是存 帳密」「房務以外都看得到」。
 *
 *   ★ 所以 `board_secrets` 是**整個系統唯一一張「policy 寫錯一行就是資安事件」**
 *     的表。而那件事不會有人來報 —— 畫面上一切正常，
 *     只是房務阿姨也看得到全公司的密碼。
 *
 *   ★★ 誰看得到只有**一份定義**：`can_see_board_secrets()`。
 *     policy 用它，前端也用 rpc 叫它。兩邊各寫一次的話會有一邊沒跟上
 *     （README 坑 A），而這一次錯的方向是「多給」。
 *
 *   ★★★ 自檢第 ④ 列把**每一種角色**餵進 policy 真正在用的那份清單，
 *     第 ⑤ 列證明判斷式走的就是那一份。
 *     只檢查「policy 存在」是不夠的 —— 存在但條件寫反，看起來一樣是綠的。
 *
 * ══════════════════════════════════════════════════════════
 * 【★★ 新建表一定要接 enable row level security ＋ create policy】
 *
 * Supabase 的 `rls_auto_enable()` 會自動幫新表開 RLS，
 * 而沒有 policy 等於全部擋掉 —— 查詢**回成功、0 列**。
 * 症狀是畫面上一個很正常的「還沒有資料」，沒有任何錯誤
 * （migration_206 建 hk_labor_cost 漏了 policy，2026-09-02 踩過）。
 *
 * ══════════════════════════════════════════════════════════
 * 【這支建什麼】
 *
 *   board_secrets       帳密。房務以外看得到
 *   board_secret_reads  誰、什麼時候、打開了哪一筆。只有總經理看得到
 *   board_events        活動（開會／團聚）。全部人看得到
 *   board_files         開會資料。全部人看得到、全部人傳得了
 *   storage bucket      board（私有）
 *
 * ★ 跑兩次結果一樣（`if not exists` ＋ `drop policy if exists`）。
 * ══════════════════════════════════════════════════════════
 */

begin;

-- ── ① 誰是誰 ────────────────────────────────────────────

/*
 * ★★ security definer。
 *   policy 裡直接 `select … from profiles` 的話，那個查詢會再被
 *   profiles 自己的 RLS 檢查一次 —— 讀不到就回 0 列，
 *   而 0 列在布林判斷裡是 false，於是每個人都被擋在外面。
 *   症狀是「全公司都看不到」，而 policy 看起來完全正常。
 */
create or replace function public.board_role()
returns text
language sql
stable
security definer
set search_path = public
as $fn$
  select p.role::text from public.profiles p where p.id = auth.uid()
$fn$;

/*
 * ★★★ 「誰看得到帳密」的**唯一一份定義**，而且是**讀得出來的**一份。
 *
 *   前端 lib/board.ts 的 SECRET_ROLES 要跟這個陣列一模一樣。
 *
 * ★ 是白名單 —— 之後多一種角色，預設看不到。
 *   寫成 `<> 'cleaner'` 的黑名單的話，新角色會自動看得到，
 *   而那件事不會有人發現。
 *
 * ★★ 為什麼拆成一支回陣列的函式，而不是把清單寫在判斷式裡：
 *   **這樣自檢才問得到真的那一份**。寫在判斷式裡的話，
 *   自檢只能在 SQL 裡把同一串字再打一次，然後拿我自己打的那串跟自己比
 *   —— 兩邊都是我寫的，永遠會是綠的（README:拿兩個問法不同的檢查互相比較）。
 */
create or replace function public.board_secret_roles()
returns text[]
language sql
immutable
as $fn$
  select array['housekeeper', 'accountant', 'manager', 'super_admin']::text[]
$fn$;

create or replace function public.can_see_board_secrets()
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select coalesce(public.board_role() = any(public.board_secret_roles()), false)
$fn$;

create or replace function public.board_is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select coalesce(public.board_role() in ('manager', 'super_admin'), false)
$fn$;

grant execute on function public.can_see_board_secrets() to authenticated;

-- ── ② 帳密 ──────────────────────────────────────────────

create table if not exists public.board_secrets (
  id          uuid primary key default gen_random_uuid(),
  title       text not null,
  account     text,
  secret      text,
  note        text,
  created_by  uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_by  uuid references public.profiles(id) on delete set null,
  /* ★ clock_timestamp() 不是 now() —— now() 是交易開始時間（README） */
  updated_at  timestamptz not null default clock_timestamp()
);

comment on table public.board_secrets is
  '佈告欄的帳密。★ 這張表存的是真的密碼 —— 改 policy 之前先想清楚。'
  '誰看得到只有一份定義：can_see_board_secrets()，前端是 lib/board.ts 的 SECRET_ROLES。';

alter table public.board_secrets enable row level security;

drop policy if exists board_secrets_all on public.board_secrets;
create policy board_secrets_all on public.board_secrets
  for all
  using (public.can_see_board_secrets())
  with check (public.can_see_board_secrets());

-- ── ③ 誰看過帳密 ────────────────────────────────────────

/*
 * ★★ 這張表是為了回答一個問題：**密碼外流了，誰打開過**。
 *   沒有它的話那個問題沒有答案。
 *
 * ★ 寫得進去的人是「看得到帳密的人」（他們打開的時候由前端寫一列），
 *   讀得到的只有總經理 —— 不然大家都看得到誰在查什麼。
 */
create table if not exists public.board_secret_reads (
  id         uuid primary key default gen_random_uuid(),
  secret_id  uuid not null references public.board_secrets(id) on delete cascade,
  user_id    uuid references public.profiles(id) on delete set null,
  read_at    timestamptz not null default clock_timestamp()
);

create index if not exists board_secret_reads_secret_idx
  on public.board_secret_reads (secret_id, read_at desc);

alter table public.board_secret_reads enable row level security;

drop policy if exists board_secret_reads_write on public.board_secret_reads;
create policy board_secret_reads_write on public.board_secret_reads
  for insert
  with check (public.can_see_board_secrets() and user_id = auth.uid());

drop policy if exists board_secret_reads_read on public.board_secret_reads;
create policy board_secret_reads_read on public.board_secret_reads
  for select
  using (public.board_role() = 'super_admin');

-- ── ④ 活動 ──────────────────────────────────────────────

create table if not exists public.board_events (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null default 'meeting',
  title       text not null,
  starts_at   timestamptz not null,
  /* 只有日期沒有時間的活動（例如「7/19 上半年慶功」）—— 畫面上就不畫時間 */
  all_day     boolean not null default false,
  note        text,
  created_by  uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now()
);

do $do$ begin
  alter table public.board_events
    add constraint board_events_kind_chk check (kind in ('meeting', 'gathering'));
exception when duplicate_object then null;
end $do$;

create index if not exists board_events_starts_idx
  on public.board_events (starts_at desc);

alter table public.board_events enable row level security;

/* 看：全部登入的人。團聚本來就是全公司的事 */
drop policy if exists board_events_read on public.board_events;
create policy board_events_read on public.board_events
  for select using (auth.uid() is not null);

/* 排一場：誰都可以，但要掛自己的名字 */
drop policy if exists board_events_insert on public.board_events;
create policy board_events_insert on public.board_events
  for insert with check (auth.uid() is not null and created_by = auth.uid());

/*
 * ★ 改與刪：**自己排的，或主管以上**。
 *   全開的話，誰都刪得掉別人排的會 —— 而刪掉不會有人收到通知。
 */
drop policy if exists board_events_update on public.board_events;
create policy board_events_update on public.board_events
  for update
  using (created_by = auth.uid() or public.board_is_admin())
  with check (created_by = auth.uid() or public.board_is_admin());

drop policy if exists board_events_delete on public.board_events;
create policy board_events_delete on public.board_events
  for delete using (created_by = auth.uid() or public.board_is_admin());

-- ── ⑤ 開會資料 ──────────────────────────────────────────

create table if not exists public.board_files (
  id          uuid primary key default gen_random_uuid(),
  event_id    uuid not null references public.board_events(id) on delete cascade,
  /* storage 的路徑。bucket 是 board */
  path        text not null,
  /* 原始檔名 —— 畫面上顯示這個，也靠它的副檔名判斷是 PDF 還是 Word */
  name        text not null,
  size_bytes  bigint,
  uploaded_by uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now()
);

create index if not exists board_files_event_idx
  on public.board_files (event_id, created_at);

alter table public.board_files enable row level security;

drop policy if exists board_files_read on public.board_files;
create policy board_files_read on public.board_files
  for select using (auth.uid() is not null);

/* 「可以讓大家上傳」（使用者 2026-09-17）—— 所以是全部人 */
drop policy if exists board_files_insert on public.board_files;
create policy board_files_insert on public.board_files
  for insert with check (auth.uid() is not null and uploaded_by = auth.uid());

/* 刪：自己傳的，或主管以上 */
drop policy if exists board_files_delete on public.board_files;
create policy board_files_delete on public.board_files
  for delete using (uploaded_by = auth.uid() or public.board_is_admin());

-- ── ⑥ storage ───────────────────────────────────────────

/*
 * ★★ `public = false`。開會資料是公司內部文件，
 *   公開 bucket 的網址**任何人猜到就打得開**，不需要登入。
 */
insert into storage.buckets (id, name, public)
values ('board', 'board', false)
on conflict (id) do nothing;

drop policy if exists board_obj_read on storage.objects;
create policy board_obj_read on storage.objects
  for select using (bucket_id = 'board' and auth.uid() is not null);

drop policy if exists board_obj_write on storage.objects;
create policy board_obj_write on storage.objects
  for insert with check (bucket_id = 'board' and auth.uid() is not null);

drop policy if exists board_obj_del on storage.objects;
create policy board_obj_del on storage.objects
  for delete using (bucket_id = 'board' and auth.uid() is not null);

do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('262_board');
  end if;
end $do$;

commit;


-- ══════════════════════════════════════════════════════════
-- 自檢
-- ══════════════════════════════════════════════════════════

with tbls as (
  /* ★ 一定要帶 table_schema='public'（README） */
  select table_name::text as t from information_schema.tables
  where table_schema = 'public'
    and table_name in ('board_secrets', 'board_secret_reads', 'board_events', 'board_files')
),
rls as (
  /*
   * ★★★ `relkind = 'r'` 不能省。
   *   不加的話 pg_class 會一起掃到**索引與主鍵**（board_events_pkey、
   *   board_events_starts_idx…）—— 那些東西本來就沒有 RLS，
   *   於是這一列在「一切正常」的時候回❌。
   *
   * ★ 誤報比沒有檢查更糟:紅字會讓人停下來，而一個每次都紅的檢查
   *   會讓人學會忽略它 —— 然後真的壞掉那天也一起被忽略（README）。
   *   2026-09-17 第一次跑就踩到，是拿真的 Postgres 跑過才看見的。
   */
  select c.relname::text as t, c.relrowsecurity as on_
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'board\_%'
),
pol as (
  select tablename::text as t, count(*) as n from pg_policies
  where schemaname = 'public' and tablename like 'board\_%'
  group by tablename
),
spol as (
  select count(*) as n from pg_policies
  where schemaname = 'storage' and tablename = 'objects'
    and policyname in ('board_obj_read', 'board_obj_write', 'board_obj_del')
),
fns as (
  select count(*) as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prokind in ('f', 'p')
    and p.proname in ('board_role', 'board_secret_roles', 'can_see_board_secrets', 'board_is_admin')
),
/*
 * ★★★ 把每一種角色餵進 **policy 真正在用的那個清單**（board_secret_roles()），
 *   不是在這裡把同一串字再打一次。
 *   再打一次的話，比的是我寫的跟我寫的，永遠會綠。
 */
gate as (
  select r.role, (r.role = any(public.board_secret_roles())) as ok
  from (values ('cleaner'), ('housekeeper'), ('accountant'), ('manager'), ('super_admin'))
       as r(role)
),
buck as (
  select id::text as id, public as pub from storage.buckets where id = 'board'
),
cnt as (
  select
    (select count(*) from public.board_secrets) as s,
    (select count(*) from public.board_events) as e,
    (select count(*) from public.board_files) as f
)

select * from (

  select 1 as ord, '① 四張表都建好了嗎' as "檢查",
         coalesce((select string_agg(t, '　' order by t) from tbls), '★ 一張都沒有') as "結果",
         case when (select count(*) from tbls) = 4 then '✅ 4/4'
              else '❌ 只有 ' || (select count(*) from tbls) || ' 張' end as "判定"

  union all
  /*
   * ★★ 沒有 policy 的新表 = 查詢回成功、0 列，而畫面上是一個很正常的
   *   「還沒有資料」（migration_206 踩過，2026-09-02）。
   */
  select 2, '② RLS 有開，而且每一張都有 policy',
         coalesce((select string_agg(r.t || ' RLS' || case when r.on_ then '✅' else '❌' end
                          || '/' || coalesce((select n::text from pol where pol.t = r.t), '0') || '條',
                          '　' order by r.t) from rls r), '★ 沒有表'),
         case when exists (select 1 from rls where not on_) then '❌ 有表沒開 RLS'
              when exists (select 1 from tbls
                            where not exists (select 1 from pol where pol.t = tbls.t))
              then '❌ 有表一條 policy 都沒有 —— 查詢會回成功、0 列，而且不報錯'
              else '✅ 都有' end

  union all
  select 3, '③ 四支判斷函式在不在',
         (select n from fns)::text || ' / 4　'
         || '(board_role・board_secret_roles・can_see_board_secrets・board_is_admin)',
         case when (select n from fns) = 4 then '✅ 4/4' else '❌ 少了' end

  union all
  /*
   * ★★★ 這一列是整支最要緊的。
   *   讀的是 policy 真正在用的那個清單，不是我在自檢裡重打一次的字。
   */
  select 4, '④ 每一種角色，看不看得到帳密',
         (select string_agg(role || '→' || case when ok then '看得到' else '看不到' end,
                            '　' order by role) from gate),
         case when (select ok from gate where role = 'cleaner')
              then '❌ 房務看得到 —— 條件寫反了，馬上停下來講'
              when (select count(*) from gate where ok) = 4
              then '✅ 房務看不到，其餘四種看得到（使用者 2026-09-17 指定）'
              else '❌ 對不上 —— 應該是 4 種看得到，現在是 '
                   || (select count(*) from gate where ok) end

  union all
  /*
   * ★★ 判斷式真的用到那支清單嗎。
   *   ④ 證明清單是對的，這一列證明 policy 走的是那支清單
   *   —— 少了這一列的話，有人把判斷式改成寫死的字串，④ 還是綠的。
   */
  select 5, '⑤ 判斷式真的走那支清單嗎',
         case when exists (
                select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public' and p.prokind in ('f', 'p')
                   and p.proname = 'can_see_board_secrets'
                   and pg_get_functiondef(p.oid) ~ '\mboard_secret_roles\M')
              then 'can_see_board_secrets() → board_secret_roles()'
              else '★ 判斷式裡沒有提到 board_secret_roles' end,
         case when exists (
                select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public' and p.prokind in ('f', 'p')
                   and p.proname = 'can_see_board_secrets'
                   and pg_get_functiondef(p.oid) ~ '\mboard_secret_roles\M')
              then '✅ 只有一份清單'
              else '❌ 判斷式自己寫死了名單 —— 上面第 ④ 列問的就不是它在用的那份' end

  union all
  select 6, '⑥ storage 的 board bucket',
         coalesce((select 'bucket ' || id || '　public=' || pub::text from buck), '★ 沒建到')
         || '　│ policy ' || (select n from spol) || '/3',
         case when not exists (select 1 from buck) then '❌ bucket 沒建到 —— 檔案傳不上去'
              when (select pub from buck) then '❌ 是公開的 —— 網址猜到就打得開，不用登入'
              when (select n from spol) < 3 then '❌ storage policy 少了 —— 上傳或下載會失敗'
              else '✅ 私有，三條 policy 都在' end

  union all
  /*
   * ★★ 母體**要判定**，不能只當參考值。
   *   跑完是 0 是**正常的**（這支只開路，東西要人去填），
   *   但要講出來 —— 不然下一輪會有人以為已經有資料了
   *   （2026-09-03 踩過 migration_210 那次，六個綠勾而母體是 0）。
   */
  select 7, '⑦ 現在有幾筆',
         '帳密 ' || (select s from cnt) || '　活動 ' || (select e from cnt)
         || '　開會資料 ' || (select f from cnt),
         case when (select s + e + f from cnt) = 0
              then '⚠ 全部是 0 —— 這是正常的，這支只開路。東西要進畫面自己加'
              else '✅ 已經有資料了' end

  union all
  select 8, '⑧ 這一支有沒有被記錄',
         coalesce((select max(name) from public.schema_migrations
                    where name = '262_board'), '（沒記到）'),
         case when exists (select 1 from public.schema_migrations
                            where name = '262_board')
              then '✅' else '❌ record_migration 沒寫進去' end

) v(ord, "檢查", "結果", "判定") order by v.ord;
