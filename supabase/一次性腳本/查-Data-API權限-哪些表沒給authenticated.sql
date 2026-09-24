-- 只讀。2026-10-30 起 Supabase 不再自動把新表開給 Data API（anon / authenticated / service_role）。
-- 這支列出 public 底下每一張表與 view，三個角色各有沒有權限 —— 現在跑一次留底，
-- 之後每建一張新表跑一次，「❌」就是前端會拿到 permission denied 的那張。
--
-- 本專案的規矩：authenticated（登入後的前端）與 service_role（API route）一定要有；
-- anon 不給 —— 這個系統沒有未登入就能看的資料，給了只是多一個洞。
select c.relname as 表,
       case c.relkind when 'r' then 'table' when 'v' then 'view' when 'm' then 'matview' when 'p' then 'partitioned' end as 種類,
       case when has_table_privilege('authenticated', c.oid, 'select') then '✅' else '❌' end as authenticated_讀,
       case when c.relkind in ('v','m') then '—'
            when has_table_privilege('authenticated', c.oid, 'insert') and has_table_privilege('authenticated', c.oid, 'update') and has_table_privilege('authenticated', c.oid, 'delete') then '✅'
            when has_table_privilege('authenticated', c.oid, 'insert') or has_table_privilege('authenticated', c.oid, 'update') or has_table_privilege('authenticated', c.oid, 'delete') then '部分'
            else '❌' end as authenticated_寫,
       case when has_table_privilege('service_role', c.oid, 'select') then '✅' else '❌' end as service_role,
       case when has_table_privilege('anon', c.oid, 'select') then '有（通常不需要）' else '無' end as anon,
       case when c.relkind in ('r','p') and not c.relrowsecurity then '⚠ RLS 沒開' else '' end as rls
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind in ('r','v','m','p')
 order by (has_table_privilege('authenticated', c.oid, 'select') and has_table_privilege('service_role', c.oid, 'select')), c.relname;
