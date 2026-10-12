/*
 * 只查、不改：管家「花」補登 10/06 下班卡被擋（2026-10-08）
 *   送出失敗：new row violates row-level security policy for table "attendance_fixes"
 *
 * 要看三件事：
 *   ① attendance_fixes 的 RLS 規則寫了什麼（INSERT 的 with check）
 *   ② 有沒有觸發器在 insert 時補 user_id 或另外擋
 *   ③ 花那一天到底有沒有打卡紀錄、她的帳號角色是什麼
 *   ★ 這支只讀，不改任何東西。三張表都貼回來。
 */

-- ① RLS 規則
select polname as 規則, case polcmd when 'r' then 'SELECT' when 'a' then 'INSERT' when 'w' then 'UPDATE'
         when 'd' then 'DELETE' else 'ALL' end as 動作,
       pg_get_expr(polqual, polrelid) as 能看哪些,
       pg_get_expr(polwithcheck, polrelid) as 能寫哪些
  from pg_policy where polrelid = 'public.attendance_fixes'::regclass
 order by 1;

-- ② 觸發器與 user_id 預設值
select tgname as 觸發器, pg_get_triggerdef(oid) as 定義
  from pg_trigger where tgrelid = 'public.attendance_fixes'::regclass and not tgisinternal
union all
select 'user_id 預設值', coalesce(column_default, '（沒有）')
  from information_schema.columns
 where table_schema = 'public' and table_name = 'attendance_fixes' and column_name = 'user_id';

-- ③ 花：角色、10/06 有沒有打卡、以前有沒有補登成功過
select p.name as 姓名, p.role as 角色,
       (select count(*) from public.attendance a where a.user_id = p.id and a.work_date = '2026-10-06') as "10/06 打卡筆數",
       (select count(*) from public.attendance_fixes f where f.user_id = p.id) as 以前送過的補登,
       (select count(*) from public.attendance_fixes f where f.user_id = p.id and f.status = 'approved') as 其中核可的
  from public.profiles p
 where p.name like '%花%';
