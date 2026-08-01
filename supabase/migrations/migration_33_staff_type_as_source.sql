-- migration_33：職位改為主軸，權限由職位決定
--
-- 變更（2026-08-01 David 指定）：
--   職位（staff_type）：管家 / 房務 / 經理 / 會計 / 總經理
--   權限（role）由職位一對一決定，設定頁不再能單獨改權限：
--
--     管家   housekeeper  → 一般   housekeeper
--     房務   roomservice  → 一般   housekeeper
--     經理   manager      → 主管   manager
--     會計   accountant   → 會計   accountant
--     總經理 gm           → 總經理 super_admin
--     其他   other        → 一般   housekeeper
--
--   為什麼要綁：原本兩欄各改各的，結果同一個人可以是「管家職位 + 總經理權限」，
--   對不起來也沒人會發現。職位是人事事實，權限是它的結果。
--
--   ⚠️ role 欄位的 DB 值不變（housekeeper/accountant/manager/super_admin），
--      RLS 與 profiles_role_chk 都不用動。改的只有職位值與顯示名稱。

-- ============================================================
-- 步驟 0：先看現況（唯讀）
--
--   「跑完後職位 / 權限」已把步驟 2（super_admin → 職位 gm）算進去，
--   所以 David 會顯示 gm / super_admin，不會被降權。
--
--   ⚠️ 步驟 2 一定要在步驟 3 之前跑。跳過步驟 2 直接跑步驟 3，
--      David 的職位還是 manager，權限會被降成 manager，
--      而設定頁只有 super_admin 進得去 —— 會把自己鎖在門外。
--      步驟 3 前面的保險會擋下這種情況並中止。
-- ============================================================
select s.name,
       s.staff_type as 目前職位,
       s.role       as 目前權限,
       case when s.role = 'super_admin' then 'gm' else s.staff_type end as 跑完後職位,
       case (case when s.role = 'super_admin' then 'gm' else s.staff_type end)
         when 'housekeeper' then 'housekeeper' when 'roomservice' then 'housekeeper'
         when 'manager' then 'manager' when 'accountant' then 'accountant'
         when 'gm' then 'super_admin' else 'housekeeper' end as 跑完後權限,
       s.auth_uid is not null as 有登入帳號
from staff s order by s.sort, s.name;


-- ============================================================
-- 步驟 1：放寬 staff_type 約束，加入 gm（總經理）
-- ============================================================
alter table staff drop constraint staff_staff_type_check;

alter table staff add constraint staff_staff_type_check
  check (staff_type in ('housekeeper','roomservice','manager','accountant','gm','other'));


-- ============================================================
-- 步驟 2：David 的職位從 manager（migration_31 給的預設）改成 gm
--         他的 role 本來就是 super_admin，不用動
-- ============================================================
update staff set staff_type = 'gm'
where role = 'super_admin' and staff_type <> 'gm';


-- ============================================================
-- 步驟 3：把所有人的 role 對齊職位
--
--   保險：先確認步驟 2 真的跑過。若還有 super_admin 的職位不是 gm，
--   直接對齊會把他降成 manager 並鎖死設定頁，所以在這裡中止。
-- ============================================================
do $$
declare n int;
begin
  select count(*) into n from staff where role = 'super_admin' and staff_type <> 'gm';
  if n > 0 then
    raise exception '步驟 2 尚未執行:還有 % 位 super_admin 的職位不是 gm。直接跑步驟 3 會把總經理降權並鎖死設定頁。', n;
  end if;
  if not exists (select 1 from staff where staff_type = 'gm' and active) then
    raise exception '沒有任何在職的總經理(gm)。繼續執行會導致無人能進設定頁。';
  end if;
end $$;

update staff s
set role = case s.staff_type
             when 'housekeeper' then 'housekeeper' when 'roomservice' then 'housekeeper'
             when 'manager' then 'manager' when 'accountant' then 'accountant'
             when 'gm' then 'super_admin' else 'housekeeper' end
where s.role is distinct from (
  case s.staff_type
    when 'housekeeper' then 'housekeeper' when 'roomservice' then 'housekeeper'
    when 'manager' then 'manager' when 'accountant' then 'accountant'
    when 'gm' then 'super_admin' else 'housekeeper' end);

-- 有登入帳號的人，profiles.role 也要跟著同步，否則權限不會真的生效
update profiles p
set role = s.role
from staff s
where s.auth_uid = p.id and p.role is distinct from s.role;


-- ============================================================
-- 步驟 4：驗證，應回傳 0 列
-- ============================================================
select s.name, s.staff_type, s.role, p.role as profile_role
from staff s
left join profiles p on p.id = s.auth_uid
where s.role is distinct from (
        case s.staff_type
          when 'housekeeper' then 'housekeeper' when 'roomservice' then 'housekeeper'
          when 'manager' then 'manager' when 'accountant' then 'accountant'
          when 'gm' then 'super_admin' else 'housekeeper' end)
   or (s.auth_uid is not null and p.role is distinct from s.role);
