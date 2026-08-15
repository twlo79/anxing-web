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
-- 步驟 0.5：放寬 staff_type 的 CHECK 約束
--
--   約束 staff_staff_type_check 建在本 repo 的 migrations 之外，
--   原本只允許 housekeeper / roomservice / other。
--   不放寬的話：步驟 2 會失敗，而且後台新增的「主管/會計」選項也存不進去。
--
--   執行前先確認現有資料沒有本清單以外的值：
--     select staff_type, count(*) from staff group by 1;
-- ============================================================
alter table staff drop constraint staff_staff_type_check;

alter table staff add constraint staff_staff_type_check
  check (staff_type in ('housekeeper','roomservice','manager','accountant','other'));


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
-- 執行紀錄：2026-08-01 已於正式站執行完畢
--
--   步驟 0.5  放寬約束。原本的 staff_staff_type_check 只允許
--             housekeeper / roomservice / other，插入 manager 會噴 23514。
--   步驟 1    0 列受影響（現有名冊 7 人本來就沒有登入帳號）
--   步驟 2    補建 David（super_admin → 職位 manager）
--   步驟 3    0 列，通過
--
--   另：justwork0117@gmail.com（Property manager，建立後從未登入）
--       於此次一併刪除，profiles 與 auth.users 兩邊都已清除。
--
--   踩到的坑：步驟 0.5 的 DDL 會讓 PostgREST 重載 schema cache，
--             執行後短時間內前端可能讀到空資料（200 + 空陣列，不是錯誤），
--             重新整理即可，不是權限或資料問題。
