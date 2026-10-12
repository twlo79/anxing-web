/*
 * 只查、不改：attendance_fixes 的權限規則與觸發器（2026-10-08）
 *   上一支 SQL Editor 只顯示最後一張表，所以這支把規則併成一張表。
 */
select '規則：' || polname as 項目,
       case polcmd when 'r' then 'SELECT' when 'a' then 'INSERT' when 'w' then 'UPDATE'
            when 'd' then 'DELETE' else 'ALL' end as 動作,
       coalesce(pg_get_expr(polqual, polrelid), '') as 能看哪些,
       coalesce(pg_get_expr(polwithcheck, polrelid), '') as 能寫哪些
  from pg_policy where polrelid = 'public.attendance_fixes'::regclass
union all
select '觸發器：' || tgname, '', pg_get_triggerdef(oid), ''
  from pg_trigger where tgrelid = 'public.attendance_fixes'::regclass and not tgisinternal
union all
select 'user_id 預設值', '', coalesce(column_default, '（沒有）'), ''
  from information_schema.columns
 where table_schema = 'public' and table_name = 'attendance_fixes' and column_name = 'user_id'
union all
select 'RLS 開著嗎', '', case when relrowsecurity then '開' else '關' end, ''
  from pg_class where oid = 'public.attendance_fixes'::regclass;
