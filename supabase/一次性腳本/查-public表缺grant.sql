/*
 * 查-public表缺grant.sql　2026-10-20（只讀，不改任何東西）
 *
 * Supabase 2026-10-30 起，public 底下「新建的表」不再自動開給 Data API（supabase-js 讀不到）。
 * 這支列出 public 每一張表：登入的人（authenticated）與後台（service_role）有沒有讀寫權限。
 * 「缺」的那幾列就是前端會回 permission denied 的表。
 *
 * 現在跑：應該全部都是 ✅（舊表不受影響）。10/30 之後建了新表，再跑一次確認。
 * 整份貼進 Supabase SQL Editor，看最後那一張表（缺的排最上面）。
 */
select c.relname as 表,
       case when has_table_privilege('authenticated', c.oid, 'select')
             and has_table_privilege('authenticated', c.oid, 'insert')
             and has_table_privilege('authenticated', c.oid, 'update')
             and has_table_privilege('authenticated', c.oid, 'delete') then '✅'
            when has_table_privilege('authenticated', c.oid, 'select') then '只能讀'
            else '❌ 缺' end as 登入的人,
       case when has_table_privilege('service_role', c.oid, 'select')
             and has_table_privilege('service_role', c.oid, 'insert') then '✅' else '❌ 缺' end as 後台,
       case when c.relrowsecurity then '有' else '⚠ 沒開' end as RLS
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind in ('r', 'p')
 order by (has_table_privilege('authenticated', c.oid, 'select') and has_table_privilege('service_role', c.oid, 'select')),
          c.relname;
