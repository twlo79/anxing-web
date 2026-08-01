-- migration_31：人員名冊(staff)與登入帳號(profiles)對接
--
-- 問題：直接用 SQL 建的帳號只有 profiles 列，沒有對應的 staff 列。
--       admin 頁只從 staff 表 render，/api/admin/staff-account 也以 staffId 為入口，
--       所以這種帳號在後台完全隱形，無法改密碼／改權限／設離職。
--
-- 執行方式：分段跑。先跑步驟 0 確認名單，再跑步驟 1、2、3。
--          整支一次貼會直接執行，沒有回頭路。

-- ============================================================
-- 步驟 0：預覽（唯讀，不改任何資料）
-- ============================================================
select p.id,
       p.name                                          as profile_名字,
       p.role                                          as 權限,
       u.email,
       (select s.name from staff s where s.auth_uid = p.id)                        as 已連結名冊,
       (select s.name from staff s
          where s.auth_uid is null
            and (s.name = p.name or p.name = any(s.aliases))
          limit 1)                                                                 as 姓名可對到,
       case
         when exists (select 1 from staff s where s.auth_uid = p.id)               then '已連結，不動'
         when exists (select 1 from staff s where s.auth_uid is null
                        and (s.name = p.name or p.name = any(s.aliases)))          then '步驟1 會連結'
         else '步驟2 會補建'
       end                                                                         as 預計動作
from profiles p
join auth.users u on u.id = p.id
order by p.name;


-- ============================================================
-- 步驟 1：用姓名把「既有 staff 列」與「登入帳號」連起來
--         必須先做這步，否則步驟 2 會把已在名冊裡的人重複建一次
-- ============================================================
update staff s
set auth_uid = p.id,
    email    = u.email,
    role     = p.role
from profiles p
join auth.users u on u.id = p.id
where s.auth_uid is null
  and (s.name = p.name or p.name = any(s.aliases));


-- ============================================================
-- 步驟 2：剩下對不到名冊的帳號（例如 David），補建 staff 列
--         職位依權限給預設值，之後可在後台自行調整
-- ============================================================
insert into staff (name, staff_type, role, email, auth_uid, active, sort)
select p.name,
       case p.role
         when 'super_admin' then 'manager'
         when 'manager'     then 'manager'
         when 'accountant'  then 'accountant'
         else 'housekeeper'
       end,
       p.role,
       u.email,
       p.id,
       true,
       10
from profiles p
join auth.users u on u.id = p.id
where not exists (select 1 from staff s where s.auth_uid = p.id);


-- ============================================================
-- 步驟 3：驗證，應回傳 0 列
-- ============================================================
select p.id, p.name, p.role
from profiles p
where not exists (select 1 from staff s where s.auth_uid = p.id);


-- ============================================================
-- 附錄：staff_type 若有 CHECK 約束，需放寬才存得下 manager / accountant
--       先跑這句查；查不到結果就不用做下面那段
-- ============================================================
-- select conname, pg_get_constraintdef(oid)
-- from pg_constraint
-- where conrelid = 'staff'::regclass and contype = 'c';

-- 查到的話，把 <約束名稱> 換掉後執行：
-- alter table staff drop constraint <約束名稱>;
-- alter table staff add constraint staff_type_chk
--   check (staff_type in ('housekeeper','roomservice','manager','accountant','other'));
