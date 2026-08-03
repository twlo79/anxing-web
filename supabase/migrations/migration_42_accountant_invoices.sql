-- migration_42：讓會計能開發票 + 盤點所有表的角色權限
--
-- invoices 目前是 invoices_all（housekeeper/manager/super_admin 可讀寫）
-- 加 invoices_accountant_read（accountant 唯讀）—— 會計開不了發票。
--
-- 這裡不做欄位限制，直接給完整權限：發票本來就是會計的職掌，
-- 不像 orders 那樣夾雜著會影響營收認列的欄位。

-- ============================================================
-- 1. 會計可讀寫發票
--    追加一條新 policy，不改寫既有的 invoices_all ——
--    Postgres 的 permissive policy 是 OR 關係，追加不會動到原本的判斷。
-- ============================================================
drop policy if exists invoices_accountant_write on public.invoices;
create policy invoices_accountant_write on public.invoices
  for all
  using (current_role_of() = 'accountant')
  with check (current_role_of() = 'accountant');


-- ============================================================
-- 2. 盤點：每張表在四個角色下的讀寫權限
--
-- 「會計」是後加的角色，既有 policy 都明列角色名稱，
-- 所以每張表都要為它補一次 —— 但沒有清單能知道哪些補了、哪些沒補，
-- 結果就是等使用者撞到才發現。這支查詢就是那份清單。
--
-- 判讀方式：qual/with_check 的條件式裡有沒有出現該角色名稱。
-- 這是文字比對，不是語意分析 —— 若 policy 寫成 current_role_of() <> 'x'
-- 這種否定形式會誤判，但本專案沒有那種寫法。
-- ============================================================
with p as (
  select tablename, cmd,
         coalesce(qual, '') || ' ' || coalesce(with_check, '') as q
  from pg_policies
  where schemaname = 'public'
),
r as (
  select unnest(array['housekeeper','accountant','manager','super_admin']) as role
)
select
  t.tablename as 資料表,
  case when bool_or(p.q like '%housekeeper%')  then '✓' else '' end as 一般,
  case when bool_or(p.q like '%accountant%')   then '✓' else '' end as 會計,
  case when bool_or(p.q like '%manager%' and p.q not like '%super_admin%'
                    or p.q like '%''manager''%') then '✓' else '' end as 主管,
  case when bool_or(p.q like '%super_admin%')  then '✓' else '' end as 總經理,
  string_agg(distinct p.cmd, ', ' order by p.cmd) as 涵蓋的操作
from (select distinct tablename from pg_policies where schemaname = 'public') t
left join p on p.tablename = t.tablename
group by t.tablename
order by t.tablename;


-- ============================================================
-- 3. 更精確：會計「只有 SELECT、沒有寫入」的表
--    這些就是還沒補的洞。空結果代表都補齊了。
-- ============================================================
select tablename,
       string_agg(distinct cmd, ', ') as 會計目前可做的操作
from pg_policies
where schemaname = 'public'
  and (coalesce(qual, '') || coalesce(with_check, '')) like '%accountant%'
group by tablename
having not bool_or(cmd in ('ALL', 'INSERT', 'UPDATE', 'DELETE'))
order by tablename;
