/*
 * migration_273_board_forms.sql　2026-09-18
 * 佈告欄多一格「表單下載」—— 共用的公司文件
 *
 * 【怎麼跑】整份貼進 Supabase SQL Editor，看最後那張自檢表。
 *          ★ 看不到自檢的表格＝整支回滾了，不是「跑成功但沒輸出」。
 *          ★★ migration_262 要先跑完（這支用它的 `board_role()`）。
 *
 * ══════════════════════════════════════════════════════════
 * 【使用者 2026-09-18】
 *   「加一個 表單下載 / 可上傳 共用公司文件 之後的人 可以下載使用
 *     1. 可以編輯 換檔案 > 總經理 | 會計 | 主管
 *     2. 其他人有權限可以下載
 *     3. 能上傳 word pdf」
 *
 * ══════════════════════════════════════════════════════════
 * 【★★★ 這一格跟「帳密」的規則不一樣，所以不共用名單】
 *
 *   帳密　　看：房務以外（`can_see_board_secrets`）　　改：同上
 *   表單　　看：**全公司，含房務**　　　　　　　　　改：總經理・會計・主管
 *
 * ★ 請假單、報帳單這種本來就是發給大家填的 —— 房務看不到的話這一格沒有意義。
 * ★★ 兩格的規則不同就**不要共用一支函式**。共用的話，哪天改其中一格
 *   會連帶改掉另一格，而那件事不會有人發現（README:同一條規則在三個地方各寫一次）。
 *
 * ══════════════════════════════════════════════════════════
 * 【★★ 誰可以改，只有一份定義】
 *
 * `can_edit_board_forms()` —— policy 走它，自檢也走它，前端
 * `lib/board.ts` 的 `FORM_EDIT_ROLES` 跟它對齊。
 *
 * ★★★ 自檢**不可以把那三個角色再打一次**然後拿它當答案 ——
 *   那是比我寫的跟我寫的，永遠會綠（README 2026-09-17 那條）。
 *   所以底下第 ④ 列是去讀那支函式吐出來的清單，第 ⑤ 列證明 policy 真的呼叫它。
 *
 * ══════════════════════════════════════════════════════════
 * 【★★★ 為什麼另開一個 bucket，不用 262 的 `board`】
 *
 * `board` 那個 bucket 的物件 policy 是「**登入的人都可以 insert / delete**」
 * （262 寫的，因為活動的檔案本來就是大家上傳的）。
 *
 * 表單借用它的話，房務**繞過畫面直接呼叫 storage API 就刪得掉表單**——
 * 而畫面上那顆鈕明明沒有畫給他。RLS 是最後一道，不是畫面。
 *
 * 所以 `board-forms` 自己一個 bucket，寫入限那三種角色。
 *
 * ══════════════════════════════════════════════════════════
 * 【跑兩次結果一樣】`if not exists` ＋ `drop policy if exists`。
 * ══════════════════════════════════════════════════════════
 */

begin;

-- ══════ ① 誰可以改（唯一的一份定義）══════

create or replace function public.board_form_edit_roles()
returns text[] language sql immutable
as $fn$ select array['accountant', 'manager', 'super_admin']::text[] $fn$;

comment on function public.board_form_edit_roles() is
  '可以上傳／換檔案／改名／刪除表單的角色(使用者 2026-09-18:「總經理 | 會計 | 主管」)。'
  '★ 這一份是唯一的定義 —— policy 與自檢都走它,不要在別的地方再打一次。'
  '★★ 前端是 lib/board.ts 的 FORM_EDIT_ROLES。';

create or replace function public.can_edit_board_forms()
returns boolean language sql stable security definer
set search_path = public
as $fn$
  select coalesce(public.board_role() = any(public.board_form_edit_roles()), false)
$fn$;

grant execute on function public.board_form_edit_roles() to authenticated;
grant execute on function public.can_edit_board_forms() to authenticated;

-- ══════ ② 表 ══════

create table if not exists public.board_forms (
  id          uuid primary key default gen_random_uuid(),
  title       text not null,
  /* 人事 / 財務 / 房務 / 其他（使用者 2026-09-18 選的） */
  category    text not null default '其他',
  /* 什麼時候要用、填完交給誰 */
  note        text,
  /* storage 裡的路徑。★ 換檔案時這一欄跟著換，id 不動 —— 見底下 */
  file_path   text,
  file_name   text,
  file_size   bigint,
  created_by  uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_by  uuid references public.profiles(id) on delete set null,
  /* ★ clock_timestamp() 不是 now() —— now() 是交易開始時間（README） */
  updated_at  timestamptz not null default clock_timestamp()
);

comment on table public.board_forms is
  '佈告欄的「表單下載」:共用的公司文件(請假單、報帳單那種)。'
  '★ 看:全公司,含房務。改:can_edit_board_forms()。'
  '★★ 換檔案時**id 不動**,只換 file_path —— 換掉 id 的話'
  '「誰上傳的、什麼時候」那段歷史會跟著不見(README:整批刪掉重建有 id 的東西)。';

comment on column public.board_forms.category is
  '人事／財務／房務／其他。★ 前端 lib/board.ts 的 FORM_CATS 是同一份,加新的要兩邊一起改。';

do $do$ begin
  alter table public.board_forms
    add constraint board_forms_cat_chk check (category in ('人事', '財務', '房務', '其他'));
exception when duplicate_object then null;
end $do$;

create index if not exists board_forms_cat_idx on public.board_forms (category, title);

/*
 * ★★★ `create table` 之後**一定**接 `enable row level security` ＋ `create policy`。
 *   Supabase 的 rls_auto_enable() 會自動開 RLS,而沒有 policy 等於全部擋掉 ——
 *   查詢**回成功、0 列**,畫面上是一個很正常的「0 份」而沒有任何錯誤
 *   （README 2026-09-02,migration_206 踩過）。
 */
alter table public.board_forms enable row level security;

/* 看：全公司。★ 房務也要 —— 表單本來就是發給大家填的 */
drop policy if exists board_forms_read on public.board_forms;
create policy board_forms_read on public.board_forms
  for select using (auth.uid() is not null);

/* 改：那三種角色。★ 四個動作分開寫,不要用 for all —— 讀那一條要保持全公司 */
drop policy if exists board_forms_insert on public.board_forms;
create policy board_forms_insert on public.board_forms
  for insert with check (public.can_edit_board_forms());

drop policy if exists board_forms_update on public.board_forms;
create policy board_forms_update on public.board_forms
  for update using (public.can_edit_board_forms())
             with check (public.can_edit_board_forms());

drop policy if exists board_forms_delete on public.board_forms;
create policy board_forms_delete on public.board_forms
  for delete using (public.can_edit_board_forms());

-- ══════ ③ 檔案放哪 ══════

insert into storage.buckets (id, name, public)
values ('board-forms', 'board-forms', false)
on conflict (id) do nothing;

/* 下載：登入的人都可以 */
drop policy if exists board_forms_obj_read on storage.objects;
create policy board_forms_obj_read on storage.objects
  for select using (bucket_id = 'board-forms' and auth.uid() is not null);

/*
 * ★★★ 寫入限那三種角色。
 *   借用 262 的 `board` bucket 的話,房務**繞過畫面直接呼叫 storage API
 *   就刪得掉表單** —— 而畫面上那顆鈕沒有畫給他。RLS 是最後一道,不是畫面。
 */
drop policy if exists board_forms_obj_write on storage.objects;
create policy board_forms_obj_write on storage.objects
  for insert with check (bucket_id = 'board-forms' and public.can_edit_board_forms());

drop policy if exists board_forms_obj_update on storage.objects;
create policy board_forms_obj_update on storage.objects
  for update using (bucket_id = 'board-forms' and public.can_edit_board_forms());

drop policy if exists board_forms_obj_del on storage.objects;
create policy board_forms_obj_del on storage.objects
  for delete using (bucket_id = 'board-forms' and public.can_edit_board_forms());

do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('273_board_forms');
  end if;
end $do$;

commit;


-- ══════════════════════════════════════════════════════════
-- 自檢
-- ══════════════════════════════════════════════════════════

with pol as (
  select policyname::text as name,
         coalesce(qual, '')::text || ' ' || coalesce(with_check, '')::text as body,
         cmd::text as cmd
    from pg_policies where schemaname = 'public' and tablename = 'board_forms'
),
objpol as (
  select policyname::text as name,
         coalesce(qual, '')::text || ' ' || coalesce(with_check, '')::text as body
    from pg_policies
   where schemaname = 'storage' and tablename = 'objects'
     and policyname like 'board\_forms\_obj\_%'
),
gap as (
  select string_agg(g::text, '　' order by g) as miss
    from generate_series(200, 273) g
   where not exists (select 1 from public.schema_migrations m
                      where split_part(m.name, '_', 1) = g::text)
)

select * from (

  select 1 as ord, '① 表建好了沒' as "檢查",
         case when to_regclass('public.board_forms') is not null
              then 'board_forms ✅　欄位 '
                   || (select count(*)::text from information_schema.columns
                        where table_schema = 'public'   -- ★ 一定要帶（README）
                          and table_name = 'board_forms')
              else '❌ 沒建起來' end as "結果",
         case when to_regclass('public.board_forms') is null
              then '❌ 表不在 —— 下面全部不算數' else '✅' end as "判定"

  union all
  /*
   * ★★★ 新建表**一定**要有 RLS ＋ policy。
   *   RLS 開了而沒有 policy ＝ 查詢回成功、0 列，畫面上是一個很正常的
   *   「0 份」而沒有任何錯誤（migration_206 踩過）。
   */
  select 2, '② RLS 開了而且有 policy 嗎',
         case when to_regclass('public.board_forms') is null then '★ 表不在'
              else (case when (select relrowsecurity from pg_class
                                where oid = 'public.board_forms'::regclass)
                         then 'RLS ✅' else 'RLS ❌' end)
                   || '　policy ' || (select count(*)::text from pol) || ' 條：'
                   || coalesce((select string_agg(name || '(' || cmd || ')', '　' order by name) from pol), '無')
         end,
         case when to_regclass('public.board_forms') is null then '❌ 表不在'
              when not (select relrowsecurity from pg_class where oid = 'public.board_forms'::regclass)
              then '❌ RLS 沒開'
              when (select count(*) from pol) < 4
              then '❌ 少於 4 條（讀／新增／修改／刪除）—— 缺的那個動作會全部被擋，'
                   || '而症狀是「回成功、0 列」'
              else '✅ RLS 開著，四個動作都有 policy' end

  union all
  /*
   * ★★★ 「看」那一條**必須是全公司**。
   *   寫成 can_edit_board_forms() 的話房務看不到 ——
   *   而表單本來就是發給他們填的。
   */
  select 3, '③ 「看」是全公司嗎（房務也要看得到）',
         coalesce((select left(body, 70) from pol where cmd = 'SELECT'), '★ 沒有 SELECT policy'),
         case when not exists (select 1 from pol where cmd = 'SELECT')
              then '❌ 沒有 —— 誰都看不到'
              when (select body from pol where cmd = 'SELECT') ~ '\mcan_edit_board_forms\M'
              then '❌ **看的條件寫成「可以改的人」** —— 房務就看不到了'
              when (select body from pol where cmd = 'SELECT') ~ '\muid\M'
              then '✅ 登入就看得到 —— 含房務'
              else '⚠ 條件跟我預期的不一樣，看上面印的' end

  union all
  /*
   * ★★★ 這一列**去讀那支函式吐出來的清單**，不是我在這裡再打一次那三個角色。
   *   再打一次的話是比我寫的跟我寫的，永遠會綠（README 2026-09-17）。
   */
  select 4, '④ 可以改的是哪幾種角色',
         coalesce(array_to_string(public.board_form_edit_roles(), '、'), '★ 函式不存在'),
         case when to_regprocedure('public.board_form_edit_roles()') is null
              then '❌ 函式不見了'
              when 'cleaner' = any(public.board_form_edit_roles())
              then '❌ **房務在可以改的名單裡** —— 使用者說的是總經理｜會計｜主管'
              when 'housekeeper' = any(public.board_form_edit_roles())
              then '⚠ 管家也可以改 —— 使用者說的是三種，確認一下'
              when array_length(public.board_form_edit_roles(), 1) = 3
              then '✅ 三種：' || array_to_string(public.board_form_edit_roles(), '、')
              else '⚠ 不是三種，看上面印的' end

  union all
  /*
   * ★★★ 光是「名單長對」不夠 —— policy 有沒有真的去呼叫它。
   *   名單對而 policy 寫死另一份的話，兩件事可以同時成立而門是開的。
   */
  select 5, '⑤ 那三條 policy 真的走那支函式嗎',
         coalesce((select string_agg(name || '：' ||
                     case when body ~ '\mcan_edit_board_forms\M' then '有' else '**沒有**' end,
                     '　' order by name) from pol where cmd <> 'SELECT'), '★ 沒有寫入 policy'),
         case when not exists (select 1 from pol where cmd <> 'SELECT')
              then '❌ 一條寫入 policy 都沒有'
              when exists (select 1 from pol where cmd <> 'SELECT'
                             and body !~ '\mcan_edit_board_forms\M')
              then '❌ 有 policy 沒走那支函式 —— 名單改了它不會跟'
              else '✅ 三條都走同一份名單' end

  union all
  /*
   * ★★★ bucket 那一側。借用 262 的 `board` 的話房務繞過畫面刪得掉檔案。
   */
  select 6, '⑥ 檔案那一側（bucket 與它的 policy）',
         coalesce((select 'bucket ' || id || '（public=' || pub || '）'
                     from (select id::text, public::text as pub from storage.buckets
                            where id = 'board-forms') b), '★ bucket 不在')
         || '　│ policy ' || (select count(*)::text from objpol) || ' 條',
         case when not exists (select 1 from storage.buckets where id = 'board-forms')
              then '❌ bucket 不在 —— 檔案傳不上去'
              when exists (select 1 from storage.buckets where id = 'board-forms' and public)
              then '❌ **bucket 是 public** —— 不用登入就抓得到檔案，要關掉'
              when (select count(*) from objpol) < 4
              then '⚠ 少於 4 條（讀／新增／修改／刪除）'
              when exists (select 1 from objpol where name like '%_del' or name like '%_write')
                   and not exists (select 1 from objpol
                                    where (name like '%_del' or name like '%_write')
                                      and body ~ '\mcan_edit_board_forms\M')
              then '❌ 寫入／刪除沒限角色 —— 房務繞過畫面就刪得掉'
              else '✅ 私有 bucket、寫入限那三種角色' end

  union all
  /*
   * ★ 母體要判定。剛建好是 0 份 —— 那是對的，但要說出來,
   *   不然下次有人看到 0 會以為壞了（README:母體是空的 → 每一條都回綠）。
   */
  select 7, '⑦ 現在有幾份表單',
         case when to_regclass('public.board_forms') is null then '★ 表不在'
              else (select count(*)::text from public.board_forms) || ' 份' end,
         case when to_regclass('public.board_forms') is null then '❌ 表不在'
              when (select count(*) from public.board_forms) = 0
              then '⚠ 剛建好，0 份是對的 —— 推上去之後在畫面上按「＋ 上傳表單」'
              else '✅' end

  union all
  select 8, '⑧ 200～273 之間還缺哪幾號',
         coalesce((select miss from gap), '（沒有缺）'),
         case when (select miss from gap) is null then '✅ 一號都沒缺'
              else '⚠ 還缺：' || (select miss from gap) end

  union all
  select 9, '⑨ 這一支有沒有被記錄',
         coalesce((select max(name) from public.schema_migrations
                    where name = '273_board_forms'), '（沒記到）'),
         case when exists (select 1 from public.schema_migrations
                            where name = '273_board_forms')
              then '✅' else '❌ record_migration 沒寫進去' end

) v(ord, "檢查", "結果", "判定") order by v.ord;
