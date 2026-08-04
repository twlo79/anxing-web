-- 匯出線上 schema 的完整定義
--
-- 用途：產生 migration_00_baseline.sql 的內容。
-- migration_30 之前的變更歷史不在版控裡，這支把「線上實際長什麼樣」撈出來納管。
--
-- 為什麼不用 supabase db dump：那個指令需要 Docker（它在容器裡跑 pg_dump）。
-- 我們要的不是可還原的備份，是「改既有函式前能在 repo 裡查到真正的定義」，
-- catalog 查詢就夠了。
--
-- 怎麼用：
--   1. 整段貼進 Supabase SQL Editor 執行
--   2. 結果只有一欄 ddl，全選複製
--   3. 貼進 supabase/migrations/migration_00_baseline.sql
--   4. 檔頭加一段說明（見該檔案），commit
--
-- 注意：輸出是「參考用」不是「可重跑」的。裡面的 create table 沒有依賴排序，
-- 直接整份執行會因為外鍵順序而失敗。它的價值在於可查詢，不在於可重放。

with cols as (
  select c.relname as tbl,
         string_agg(
           format('  %I %s%s%s',
             a.attname,
             format_type(a.atttypid, a.atttypmod),
             case when a.attnotnull then ' not null' else '' end,
             case when d.adbin is not null
                  then ' default ' || pg_get_expr(d.adbin, d.adrelid) else '' end),
           E',\n' order by a.attnum) as body
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
    left join pg_attrdef d on d.adrelid = c.oid and d.adnum = a.attnum
   where n.nspname = 'public' and c.relkind in ('r', 'p')
   group by c.relname
)

-- 1 表
select 1 as sec, tbl as nm,
       format(E'-- ── table %s ──\ncreate table public.%I (\n%s\n);', tbl, tbl, body) as ddl
  from cols

union all
-- 2 約束（PK / FK / UNIQUE / CHECK）
select 2, conrelid::regclass::text || '.' || conname,
       format('alter table %s add constraint %I %s;',
              conrelid::regclass, conname, pg_get_constraintdef(oid))
  from pg_constraint
 where connamespace = 'public'::regnamespace

union all
-- 3 索引
select 3, indexname, indexdef || ';'
  from pg_indexes where schemaname = 'public'

union all
-- 4 函式與觸發器函式（最重要的一段 —— 這裡是踩坑最多的地方）
select 4, p.proname, pg_get_functiondef(p.oid) || ';'
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.prokind = 'f'

union all
-- 5 觸發器
select 5, t.tgname, pg_get_triggerdef(t.oid) || ';'
  from pg_trigger t
  join pg_class c on c.oid = t.tgrelid
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and not t.tgisinternal

union all
-- 6 RLS policy
select 6, tablename || '.' || policyname,
       format(E'-- %s on %s\ncreate policy %I on public.%I as %s for %s to %s%s%s;',
              policyname, tablename,
              policyname, tablename, permissive, cmd, array_to_string(roles, ', '),
              coalesce(E'\n  using (' || qual || ')', ''),
              coalesce(E'\n  with check (' || with_check || ')', ''))
  from pg_policies where schemaname = 'public'

union all
-- 7 哪些表啟用了 RLS
select 7, c.relname,
       format('alter table public.%I %s row level security;',
              c.relname, case when c.relrowsecurity then 'enable' else 'disable' end)
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind = 'r'

order by sec, nm;
