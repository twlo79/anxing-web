-- migration_131：新增「房務」角色，「一般」改名「管家」
--
-- ============================================================
-- 【職位早就有「房務」，角色沒有】
--
-- `staff.staff_type` 已經分得出房務（`roomservice`）與管家（`housekeeper`），
-- 但兩個都對應到同一個角色 `housekeeper` —— 所以房務打開系統，
-- 看到的是跟管家一模一樣的十四個選單項，而他每天只用其中三個。
--
-- 這次讓「房務」有自己的角色 `cleaner`，選單只留:
--
--     出勤 · 房務管理 · 清潔記錄 · 設定
--
--
-- ============================================================
-- 【這是收窄選單，不是權限隔離】（2026-08-16 使用者選擇）
--
-- **下面不會新增任何 RLS policy。** `cleaner` 在資料庫眼裡
-- 跟 `housekeeper` 一樣 —— 房務知道網址的話，`/shortterm` 還是進得去。
--
-- 為什麼先這樣:真正的隔離要改一批 policy，而漏掉一條的症狀是
-- 「他當天打不了卡」或「看不到自己的班表」——
-- 兩個都不會報錯，只會是一片空白，而他不會知道要跟誰講。
--
-- 房務是內部員工，不是外人。先把每天要用的東西整理乾淨、
-- 不用每次從十四項裡找那三項，價值已經到手了。
--
-- ⚠️ 哪天要做真的隔離（例如不讓房務看到房客電話），
--    要逐條檢查 `current_role_of() = 'housekeeper'` 與
--    `current_role_of() IS NOT NULL` 這兩種寫法 ——
--    後者會讓任何有角色的人都通過，包含 cleaner。
--
--
-- ============================================================
-- 【「一般」改名「管家」】
--
-- 只改顯示名稱，資料庫的值仍然是 `housekeeper` ——
-- 改值的話所有 RLS policy 都要跟著改，而漏一條就是有人突然不能用。
-- 名字在前端（layout.tsx 與 admin 頁的 ROLE_LABEL）。

-- ── 允許新的角色值 ─────────────────────────────────
--
-- CHECK 約束不加 cleaner 的話，改職位那一步會直接被資料庫擋下來，
-- 而畫面上只看得到一行 constraint violation。
alter table public.profiles drop constraint if exists profiles_role_chk;
alter table public.profiles add constraint profiles_role_chk
  check (role = any (array['cleaner', 'housekeeper', 'accountant', 'manager', 'super_admin']));

comment on column public.profiles.role is
  '權限角色，由 staff.staff_type 一對一推導（前端 ROLE_OF）。'
  'cleaner=房務（選單只有出勤/房務管理/清潔記錄/設定,但 RLS 同 housekeeper）、'
  'housekeeper=管家、accountant=會計、manager=主管、super_admin=總經理。';

/*
 * staff.role 沒有 CHECK 約束（只有 default）。
 *
 * 不補上去 —— 補了就要先確認現有資料全部合法，
 * 而這支 migration 的目的不是清理那張表。
 * 真正把關的是 profiles，`current_role_of()` 讀的是那裡。
 */


-- ── 把現有的房務職位換成新角色 ─────────────────────
--
-- 【為什麼要更新既有資料】
-- 只改前端對照表的話，**已經建好的房務帳號還是 housekeeper**，
-- 要等有人去權限管理把職位重存一次才會變 —— 而沒有人會想到要做那件事。
do $$
declare v_n int;
begin
  update public.profiles p
     set role = 'cleaner'
    from public.staff s
   where s.auth_uid = p.id
     and s.staff_type = 'roomservice'
     and p.role = 'housekeeper';       -- 只動還是舊值的，不覆蓋手動調過的
  get diagnostics v_n = row_count;
  raise notice '轉成房務 % 人', v_n;   -- 看不到,真正的報告在自檢

  -- staff 表上也有一份 role（顯示用）。兩邊不一致的話
  -- 權限管理那一頁會顯示舊的職稱，而實際權限是新的
  update public.staff
     set role = 'cleaner'
   where staff_type = 'roomservice' and role = 'housekeeper';
end $$;


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('131_role_cleaner');
  end if;
end $$;


-- ============================================================
-- 驗證
-- ============================================================
do $$
declare n int;
begin
  drop table if exists _chk131;
  create temp table _chk131 (ord int, item text, result text, detail text);

  insert into _chk131 values (1, 'profiles 允許 cleaner',
    case when exists (
      select 1 from pg_constraint
       where conname = 'profiles_role_chk'
         and pg_get_constraintdef(oid) like '%cleaner%')
    then '✅' else '❌' end, '');

  insert into _chk131
  select 2, '角色人數：' || coalesce(role, '(沒有角色)'), count(*)::text, ''
    from public.profiles group by role;

  -- 房務職位的人現在是什麼角色
  insert into _chk131
  select 5, '★ 職位=房務的人', count(*) || ' 人',
         string_agg(distinct coalesce(p.role, '(沒有)'), '、')
    from public.staff s
    left join public.profiles p on p.id = s.auth_uid
   where s.staff_type = 'roomservice' and s.active;

  /*
   * 這一條是要盯的：職位是房務、但角色還不是 cleaner 的人。
   *
   * 通常是還沒建帳號（auth_uid 是 null）—— 那沒關係，
   * 建帳號時會用新的對照表。有 auth_uid 卻沒轉過去的才要看。
   */
  select count(*) into n
    from public.staff s join public.profiles p on p.id = s.auth_uid
   where s.staff_type = 'roomservice' and s.active and p.role <> 'cleaner';
  insert into _chk131 values (8, '★★ 職位房務但角色不是 cleaner',
    case when n = 0 then '✅ 沒有' else '⚠ ' || n || ' 人' end,
    case when n = 0 then '' else
      (select string_agg(s.name || '（' || p.role || '）', '、')
         from public.staff s join public.profiles p on p.id = s.auth_uid
        where s.staff_type = 'roomservice' and s.active and p.role <> 'cleaner')
      || ' —— 手動調過角色的不會被自動覆蓋。確認一下是不是刻意的' end);

  select count(*) into n from public.staff where staff_type = 'roomservice' and active and auth_uid is null;
  insert into _chk131 values (9, '職位房務但還沒建帳號', n || ' 人',
    '沒有帳號就沒有角色。建帳號時會用新的對照表,不用管');
end $$;

select item as "檢查項目", result as "結果", detail as "說明"
from _chk131 order by ord, item;
