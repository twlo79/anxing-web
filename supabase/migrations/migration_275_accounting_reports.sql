/*
 * migration_275_accounting_reports.sql　2026-09-18
 * 新的一頁：會計報表（月報、401、其他）
 *
 * 【怎麼跑】整份貼進 Supabase SQL Editor，看最後那張自檢表。
 *          ★ 看不到自檢的表格＝整支回滾了，不是「跑成功但沒輸出」。
 *
 * ══════════════════════════════════════════════════════════
 * 【使用者 2026-09-18】
 *   「多一個 叫 會計報表 / 會計可上傳 月報 401報表 /
 *     檔案形式 PDF excel word / 參考 這個 /
 *     權限：會計 主管 總經理 可以來讀 / 種類 月報 401 其他 /
 *     日期 期別 種類 / 401 兩月一期」
 *   「401 可以選 之後月份嗎 可以 dropdown 自己選 不用再新增」
 *   「還是有標題 可以自己輸入」「下載檔案 和標題一樣」
 *
 * ══════════════════════════════════════════════════════════
 * 【★★★ 跟「表單下載」（273）的規則不一樣，所以不共用名單】
 *
 *   表單下載　看：**全公司，含房務**　　改：總經理・會計・主管
 *   會計報表　看：總經理・會計・主管　　改：同一組
 *
 * ★ 請假單是發給大家填的；401 不是。房務看得到 401 沒有道理。
 * ★★ 兩邊規則不同就**不要共用一支函式**。共用的話哪天改其中一邊
 *   會連帶改掉另一邊，而那件事不會有人發現
 *   （README:同一條規則在三個地方各寫一次）。
 *
 * ★★★ 這一支「看」與「改」現在**是同一組人**，所以只有一支函式。
 *   哪天要分開（例如主管只能看不能傳），做法是**新增**
 *   `accounting_report_edit_roles()`，然後只把寫入那三條 policy 換過去 ——
 *   不要在 policy 裡直接打一串角色，那就變成第二份名單了。
 *
 * ══════════════════════════════════════════════════════════
 * 【★★★ 期別只存一支欄位】
 *
 * `period_start` ＝ 那一期的**第一天**（401 的 7-8 月存 `2026-07-01`）。
 * 畫面上的「115年 7-8月」由 `lib/report.ts` 的 `periodText()` 算出來。
 *
 * 存中文的話「115年7-8月」「115 年 7~8 月」會同時存在，
 * 而排序、篩選、找重複全部對不上
 * （README:同一支欄位既拿來顯示又拿來當 key）。
 *
 * ══════════════════════════════════════════════════════════
 * 【★★ 為什麼另開一個 bucket】
 *
 * `board-forms` 的物件 policy 是「**登入的人都可以 select**」——
 * 表單本來就是全公司下載的。會計報表借用它的話，
 * 房務**繞過畫面直接呼叫 storage API 就抓得到 401**。
 * RLS 是最後一道，不是畫面。
 *
 * ══════════════════════════════════════════════════════════
 * 【跑兩次結果一樣】`if not exists` ＋ `drop policy if exists`。
 * ══════════════════════════════════════════════════════════
 */

begin;

-- ══════ ① 誰用得了這一頁（唯一的一份定義）══════

create or replace function public.accounting_report_roles()
returns text[] language sql immutable
as $fn$ select array['accountant', 'manager', 'super_admin']::text[] $fn$;

comment on function public.accounting_report_roles() is
  '可以看與上傳會計報表的角色(使用者 2026-09-18:「會計 主管 總經理 可以來讀」)。'
  '★ 這一份是唯一的定義 —— policy 與自檢都走它,不要在別的地方再打一次。'
  '★★ 前端是 lib/report.ts 那一頁的 canUseReports()。'
  '★★★ 跟 board_form_edit_roles() **不共用** —— 表單是全公司看的,報表不是。';

create or replace function public.can_use_accounting_reports()
returns boolean language sql stable security definer
set search_path = public
as $fn$
  select coalesce(
    (select p.role from public.profiles p where p.id = auth.uid())
      = any(public.accounting_report_roles()),
    false)
$fn$;

comment on function public.can_use_accounting_reports() is
  '這個人能不能看／上傳會計報表(migration_275)。'
  '★ SECURITY DEFINER 是為了讀得到 profiles(它自己也有 RLS);'
  '  這支只回 true/false,不吐任何資料。';

grant execute on function public.accounting_report_roles() to authenticated;
grant execute on function public.can_use_accounting_reports() to authenticated;

-- ══════ ② 表 ══════

create table if not exists public.accounting_reports (
  id            uuid primary key default gen_random_uuid(),
  /* 月報 / 401 / 其他 */
  kind          text not null,
  /*
   * ★★★ 那一期的**第一天**。401 的 7-8 月存 2026-07-01。
   *   「其他」可以是 null（財簽報告那種沒有期間的）。
   */
  period_start  date,
  /* 使用者自己打的標題。★ 清單的大字與**下載下來的檔名**都是它 */
  title         text not null,
  /* 申報日（使用者說的「日期」） */
  filed_on      date,
  note          text,
  file_path     text,
  file_name     text,
  file_size     bigint,
  created_by    uuid references public.profiles(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_by    uuid references public.profiles(id) on delete set null,
  /* ★ clock_timestamp() 不是 now() —— now() 是交易開始時間（README） */
  updated_at    timestamptz not null default clock_timestamp()
);

comment on table public.accounting_reports is
  '會計報表:月報、401、其他(migration_275)。'
  '★ 看與改都是 can_use_accounting_reports() —— 房務與管家完全看不到。'
  '★★ 期別存 period_start(那一期的第一天),中文由 lib/report.ts 算出來。';

comment on column public.accounting_reports.period_start is
  '那一期的第一天。401 兩月一期,起月只能是 1/3/5/7/9/11 —— 見 ar_shape_chk。'
  '★ 不要存「115年 7-8月」這種字串:排序、篩選、找重複全部會對不上。';

comment on column public.accounting_reports.title is
  '使用者自己打的標題(2026-09-18:「還是有標題 可以自己輸入」)。'
  '★ 下載下來的檔名就是它(「下載檔案 和標題一樣」),所以不可以是空的。';

/*
 * ★★ 形狀的守衛。前端 `validateReport()` 是同一組規則 ——
 *   前端負責講出「為什麼」，這裡負責擋住**任何**路徑（含手改資料）。
 */
do $do$ begin
  alter table public.accounting_reports
    add constraint ar_kind_chk check (kind in ('月報', '401', '其他'));
exception when duplicate_object then null;
end $do$;

do $do$ begin
  alter table public.accounting_reports
    add constraint ar_shape_chk check (
      btrim(title) <> ''
      /* 月報與 401 一定要有期別；其他可以沒有 */
      and (kind = '其他' or period_start is not null)
      /* 有期別的話一定是那一期的第一天 */
      and (period_start is null or extract(day from period_start) = 1)
      /* ★★★ 401 兩月一期 —— 起月只能是單數月，選不到「6-7 月」 */
      and (kind <> '401' or period_start is null
           or extract(month from period_start)::int in (1, 3, 5, 7, 9, 11))
      /* 申報日不能早於那一期的開始 */
      and (filed_on is null or period_start is null or filed_on >= period_start)
    );
exception when duplicate_object then null;
end $do$;

/*
 * ★★★ 同一個種類＋同一期只留一份（2026-09-18 的 ❷「換掉舊的」）。
 *   「其他」不在這條裡 —— 它可以有很多份。
 *
 * ★★ 這是 **partial 唯一索引**，所以前端**絕對不可以**用
 *   `.upsert(..., { onConflict: 'kind,period_start' })` ——
 *   PostgREST 只送得出欄位名，表達不出那個 WHERE，
 *   Postgres 會直接丟 `no unique or exclusion constraint matching
 *   the ON CONFLICT specification`（README 2026-09-07 踩過）。
 *   要換掉舊的就先 select 找出那一列，再 update 它。
 */
create unique index if not exists ar_period_uniq
  on public.accounting_reports (kind, period_start)
  where kind <> '其他' and period_start is not null;

create index if not exists ar_kind_period_idx
  on public.accounting_reports (kind, period_start desc);

/*
 * ★★★ `create table` 之後**一定**接 `enable row level security` ＋ `create policy`。
 *   Supabase 的 rls_auto_enable() 會自動開 RLS，而沒有 policy 等於全部擋掉 ——
 *   查詢**回成功、0 列**，畫面上是一個很正常的「0 份」而沒有任何錯誤
 *   （README 2026-09-02，migration_206 踩過）。
 */
alter table public.accounting_reports enable row level security;

drop policy if exists ar_read on public.accounting_reports;
create policy ar_read on public.accounting_reports
  for select using (public.can_use_accounting_reports());

drop policy if exists ar_insert on public.accounting_reports;
create policy ar_insert on public.accounting_reports
  for insert with check (public.can_use_accounting_reports());

drop policy if exists ar_update on public.accounting_reports;
create policy ar_update on public.accounting_reports
  for update using (public.can_use_accounting_reports())
             with check (public.can_use_accounting_reports());

drop policy if exists ar_delete on public.accounting_reports;
create policy ar_delete on public.accounting_reports
  for delete using (public.can_use_accounting_reports());

-- ══════ ③ 檔案放哪 ══════

insert into storage.buckets (id, name, public)
values ('accounting-reports', 'accounting-reports', false)
on conflict (id) do nothing;

/*
 * ★★★ 連「讀」都要限角色 —— 這裡跟 board-forms 不一樣。
 *   借用 board-forms 的話，房務繞過畫面直接呼叫 storage API 就抓得到 401。
 */
drop policy if exists ar_obj_read on storage.objects;
create policy ar_obj_read on storage.objects
  for select using (bucket_id = 'accounting-reports' and public.can_use_accounting_reports());

drop policy if exists ar_obj_write on storage.objects;
create policy ar_obj_write on storage.objects
  for insert with check (bucket_id = 'accounting-reports' and public.can_use_accounting_reports());

drop policy if exists ar_obj_update on storage.objects;
create policy ar_obj_update on storage.objects
  for update using (bucket_id = 'accounting-reports' and public.can_use_accounting_reports());

drop policy if exists ar_obj_del on storage.objects;
create policy ar_obj_del on storage.objects
  for delete using (bucket_id = 'accounting-reports' and public.can_use_accounting_reports());

do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('275_accounting_reports');
  end if;
end $do$;

commit;


-- ══════════════════════════════════════════════════════════
-- 自檢
-- ★★ 這張表在 commit 後面 —— 看不到它 = 整支回滾了。
-- ══════════════════════════════════════════════════════════

with pol as (
  select policyname::text as name,
         coalesce(qual, '')::text || ' ' || coalesce(with_check, '')::text as body,
         cmd::text as cmd
    from pg_policies where schemaname = 'public' and tablename = 'accounting_reports'
),
objpol as (
  select policyname::text as name,
         coalesce(qual, '')::text || ' ' || coalesce(with_check, '')::text as body
    from pg_policies
   where schemaname = 'storage' and tablename = 'objects'
     and policyname like 'ar\_obj\_%'
),
gap as (
  select string_agg(g::text, '　' order by g) as miss
    from generate_series(200, 275) g
   where not exists (select 1 from public.schema_migrations m
                      where split_part(m.name, '_', 1) = g::text)
)

select * from (

  select 1 as ord, '① 表建好了沒' as "檢查",
         case when to_regclass('public.accounting_reports') is not null
              then 'accounting_reports ✅　欄位 '
                   || (select count(*)::text from information_schema.columns
                        where table_schema = 'public'   -- ★ 一定要帶（README）
                          and table_name = 'accounting_reports')
              else '❌ 沒建起來' end as "結果",
         case when to_regclass('public.accounting_reports') is null
              then '❌ 表不在 —— 下面全部不算數' else '✅' end as "判定"

  union all
  select 2, '② RLS 開了而且有 policy 嗎',
         case when to_regclass('public.accounting_reports') is null then '★ 表不在'
              else (case when (select relrowsecurity from pg_class
                                where oid = 'public.accounting_reports'::regclass)
                         then 'RLS ✅' else 'RLS ❌' end)
                   || '　policy ' || (select count(*)::text from pol) || ' 條：'
                   || coalesce((select string_agg(name || '(' || cmd || ')', '　' order by name) from pol), '無')
         end,
         case when to_regclass('public.accounting_reports') is null then '❌ 表不在'
              when not (select relrowsecurity from pg_class
                         where oid = 'public.accounting_reports'::regclass)
              then '❌ RLS 沒開'
              when (select count(*) from pol) < 4
              then '❌ 少於 4 條（讀／新增／修改／刪除）—— 缺的那個動作會全部被擋，'
                   || '而症狀是「回成功、0 列」'
              else '✅ RLS 開著，四個動作都有 policy' end

  union all
  /*
   * ★★★ 這一頁跟表單下載相反:「看」也要限角色。
   *   寫成 `auth.uid() is not null` 的話房務看得到 401。
   */
  select 3, '★★★ ③ 「看」有沒有限角色（房務不可以看到 401）',
         coalesce((select left(body, 80) from pol where cmd = 'SELECT'), '★ 沒有 SELECT policy'),
         case when not exists (select 1 from pol where cmd = 'SELECT')
              then '❌ 沒有 —— 誰都看不到'
              when (select body from pol where cmd = 'SELECT') ~ '\mcan_use_accounting_reports\M'
              then '✅ 限那三種角色'
              else '❌ **看的條件沒走那支函式** —— 很可能是「登入就看得到」，房務會看到 401' end

  union all
  /*
   * ★★★ 這一列**去讀那支函式吐出來的清單**，不是在這裡再打一次那三個角色 ——
   *   再打一次的話是比我寫的跟我寫的，永遠會綠（README 2026-09-17）。
   */
  select 4, '④ 用得了這一頁的是哪幾種角色',
         coalesce(array_to_string(public.accounting_report_roles(), '、'), '★ 函式不存在'),
         case when to_regprocedure('public.accounting_report_roles()') is null
              then '❌ 函式不見了'
              when 'cleaner' = any(public.accounting_report_roles())
                or 'housekeeper' = any(public.accounting_report_roles())
              then '❌ **房務或管家在名單裡** —— 使用者說的是會計｜主管｜總經理'
              when array_length(public.accounting_report_roles(), 1) = 3
              then '✅ 三種：' || array_to_string(public.accounting_report_roles(), '、')
              else '⚠ 不是三種，看上面印的' end

  union all
  /*
   * ★★★ 光是「名單長對」不夠 —— 四條 policy 有沒有真的去呼叫它。
   *   名單對而 policy 寫死另一份的話，兩件事可以同時成立而門是開的。
   */
  select 5, '⑤ 四條 policy 真的走那支函式嗎',
         coalesce((select string_agg(name || '：' ||
                     case when body ~ '\mcan_use_accounting_reports\M' then '有' else '**沒有**' end,
                     '　' order by name) from pol), '★ 沒有 policy'),
         case when not exists (select 1 from pol) then '❌ 一條 policy 都沒有'
              when exists (select 1 from pol where body !~ '\mcan_use_accounting_reports\M')
              then '❌ 有 policy 沒走那支函式 —— 名單改了它不會跟'
              else '✅ 四條都走同一份名單' end

  union all
  /*
   * ★★★ 形狀的守衛。少一條不會報錯，只會讓某一種錯誤的資料安靜存進去。
   */
  select 6, '★★ ⑥ 形狀的守衛在不在',
         (select string_agg(g.nm, '、' order by g.ord)
            from (values
                    (1, '標題不可空',   'btrim(title)'),
                    (2, '要有期別',     'period_start IS NOT NULL'),
                    (3, '一定是一號',   'day'),
                    (4, '401 單數月',   'ARRAY[1, 3, 5, 7, 9, 11]'),
                    (5, '申報日不早於', 'filed_on >=')
                 ) g(ord, nm, needle)
           where coalesce((select pg_get_constraintdef(c.oid) from pg_constraint c
                            where c.conrelid = 'public.accounting_reports'::regclass
                              and c.conname = 'ar_shape_chk'), '') like '%' || g.needle || '%'),
         case when to_regclass('public.accounting_reports') is null then '❌ 表不在'
              when (select count(*)
                      from (values ('btrim(title)'), ('period_start IS NOT NULL'), ('day'),
                                   ('ARRAY[1, 3, 5, 7, 9, 11]'), ('filed_on >=')) g(needle)
                     where coalesce((select pg_get_constraintdef(c.oid) from pg_constraint c
                                       where c.conrelid = 'public.accounting_reports'::regclass
                                         and c.conname = 'ar_shape_chk'), '')
                           like '%' || g.needle || '%') = 5
              then '✅ 五條都在'
              else '❌ 少了其中一條 —— 那一種錯誤的資料會安靜存進去' end

  union all
  /*
   * ★★ 同一期只留一份的唯一索引。
   *   它是 partial 的 —— 前端不可以用 upsert 對它（README 2026-09-07）。
   */
  select 7, '⑦ 同一個種類＋同一期只留一份',
         coalesce((select i.indexname::text || '（' ||
                     case when idx.indisunique then 'unique' else '**不是 unique**' end || '）'
                     from pg_indexes i
                     join pg_class c on c.relname = i.indexname
                     join pg_index idx on idx.indexrelid = c.oid
                    where i.schemaname = 'public' and i.tablename = 'accounting_reports'
                      and i.indexname = 'ar_period_uniq'), '★ 索引不在'),
         case when not exists (select 1 from pg_indexes
                                where schemaname = 'public' and tablename = 'accounting_reports'
                                  and indexname = 'ar_period_uniq')
              then '❌ 不在 —— 同一期會存進兩份，而畫面上看不出哪一份才是送出去的'
              else '✅ 在（partial：其他不受限）' end

  union all
  select 8, '⑧ 檔案那一側（bucket 與它的 policy）',
         coalesce((select 'bucket ' || b.id || '（public=' || b.pub || '）'
                     from (select id::text, public::text as pub from storage.buckets
                            where id = 'accounting-reports') b), '★ bucket 不在')
         || '　│ policy ' || (select count(*)::text from objpol) || ' 條',
         case when not exists (select 1 from storage.buckets where id = 'accounting-reports')
              then '❌ bucket 不在 —— 檔案傳不上去'
              when exists (select 1 from storage.buckets where id = 'accounting-reports' and public)
              then '❌ **bucket 是 public** —— 不用登入就抓得到 401，要關掉'
              when (select count(*) from objpol) < 4
              then '⚠ 少於 4 條（讀／新增／修改／刪除）'
              when exists (select 1 from objpol where body !~ '\mcan_use_accounting_reports\M')
              then '❌ 有一條沒限角色 —— 房務繞過畫面就抓得到'
              else '✅ 私有 bucket、四個動作都限那三種角色' end

  union all
  /*
   * ★★★ 跟表單下載**不可以是同一個 bucket**。
   *   board-forms 的讀是「登入就可以」—— 借用的話房務抓得到 401。
   */
  select 9, '★★ ⑨ 沒有跟表單下載共用 bucket 吧',
         (select string_agg(id::text, '、' order by id) from storage.buckets
           where id in ('board-forms', 'accounting-reports')),
         case when not exists (select 1 from storage.buckets where id = 'accounting-reports')
              then '❌ 報表的 bucket 不在'
              when exists (select 1 from objpol where body like '%board-forms%')
              then '❌ 報表的 policy 指到 board-forms 去了'
              else '✅ 兩個是分開的' end

  union all
  /*
   * ★ 母體要判定。剛建好是 0 份 —— 那是對的，但要說出來，
   *   不然下次有人看到 0 會以為壞了（README:母體是空的 → 每一條都回綠）。
   */
  select 10, '⑩ 現在有幾份報表',
         case when to_regclass('public.accounting_reports') is null then '★ 表不在'
              else (select count(*)::text from public.accounting_reports) || ' 份' end,
         case when to_regclass('public.accounting_reports') is null then '❌ 表不在'
              when (select count(*) from public.accounting_reports) = 0
              then '⚠ 剛建好，0 份是對的 —— 推上去之後在「財務管理 → 會計報表」按「＋ 上傳報表」'
              else '✅' end

  union all
  select 11, '⑪ 200～275 之間還缺哪幾號',
         coalesce((select miss from gap), '（沒有缺）'),
         case when (select miss from gap) is null then '✅ 一號都沒缺'
              else '⚠ 還缺：' || (select miss from gap) end

  union all
  select 12, '⑫ 這一支有沒有被記錄',
         coalesce((select max(name) from public.schema_migrations
                    where name = '275_accounting_reports'), '（沒記到）'),
         case when exists (select 1 from public.schema_migrations
                            where name = '275_accounting_reports')
              then '✅' else '❌ record_migration 沒寫進去' end

) v(ord, "檢查", "結果", "判定") order by v.ord;
