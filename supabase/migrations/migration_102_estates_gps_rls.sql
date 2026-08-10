-- migration_102：打卡位置設定的權限（estates）
--
-- ============================================================
-- 【為什麼要有這一支】
--
-- 出勤頁的「管理」分頁讓主管設定物業的打卡座標，寫的是 public.estates。
-- 但 estates 的 RLS 只在 migration_44 補過會計那條，主管那條不知道在不在
-- （基礎政策是在 migrations 之外建的，這個 repo 裡看不到）。
--
-- 這件事不能用「試試看」處理。Supabase 的 UPDATE 被 RLS 擋掉時
-- **不會回錯誤** —— 回的是「成功，影響 0 列」。前端會顯示「已更新」，
-- 主管以為設好了，員工卻永遠打不了卡，而且沒有任何人看得到失敗訊息。
-- （payment_accounts 就發生過同一件事。）
--
-- 所以這裡明確補上，並在最後把 estates 的所有政策列出來給人看。
--
--
-- ============================================================
-- 【為什麼是整張表而不是只有座標欄】
--
-- PostgreSQL 的 RLS 是列級的，沒有辦法只開放某幾欄。
-- 主管本來就在管房務、看得到所有物業，開放 estates 的寫入
-- 不會讓他碰到原本碰不到的資料。真正敏感的（角色、金流帳號）
-- 在別的表，不受這支影響。
-- ============================================================

-- 讀：有角色的人都要讀得到。
-- 員工的打卡頁要顯示「可打卡的物業有哪些」，讀不到的話那份清單是空的，
-- 而空清單長得跟「主管還沒設定」一模一樣 —— 兩種情況的處理方式完全不同。
drop policy if exists estates_read_all on public.estates;
create policy estates_read_all on public.estates
  for select using (current_role_of() is not null);

-- 寫：主管與總經理。
-- 會計那條（estates_accountant_all）留著不動，policy 之間是 OR。
drop policy if exists estates_admin_write on public.estates;
create policy estates_admin_write on public.estates
  for all
  using      (current_role_of() in ('manager', 'super_admin'))
  with check (current_role_of() in ('manager', 'super_admin'));


-- ── 半徑的下限 ─────────────────────────────────────
--
-- 半徑填 0 或負數 = 全公司都打不了卡，而錯誤訊息只會說「距離 37 公尺」，
-- 沒有人會聯想到是半徑被設成 0。手機 GPS 在市區誤差就有 10~50 公尺，
-- 低於 50 的半徑實務上不可用，直接擋在資料庫。
alter table public.estates drop constraint if exists estates_gps_radius_chk;
alter table public.estates add constraint estates_gps_radius_chk
  check (gps_radius_m is null or gps_radius_m >= 50)
  not valid;   -- 既有資料若已經被設成 0,交給下面的查詢挑出來,不要整支 rollback

comment on column public.estates.gps_radius_m is
  '打卡半徑（公尺），預設 500。下限 50 —— 手機 GPS 市區誤差 10~50 公尺，'
  '半徑設太小會讓人站在門口卻打不了卡,而那種失敗員工只會覺得系統壞了。';


-- ── 座標填反的防呆 ─────────────────────────────────
--
-- 台灣的緯度 21~26、經度 119~123。填反（lat 填成 121）是最常見的錯誤，
-- 而結果是所有人都打不了卡、訊息只說「距離 8000 公尺」。
-- 範圍寫寬一點（含離島與海域邊界），只擋明顯錯誤，不擋合法但邊緣的值。
alter table public.estates drop constraint if exists estates_gps_range_chk;
alter table public.estates add constraint estates_gps_range_chk
  check (
    (gps_lat is null or gps_lat between 20 and 27)
    and (gps_lng is null or gps_lng between 118 and 124)
  )
  not valid;   -- 既有資料若已經填錯,交給下面的查詢挑出來,不要整支 rollback

comment on constraint estates_gps_range_chk on public.estates is
  '座標必須落在台灣範圍內。擋的是經緯度填反 —— 填反之後所有人都打不了卡,'
  '而錯誤訊息只會說「距離 8000 公尺」,沒有人猜得到原因。';


-- ── 現況 ───────────────────────────────────────────

-- 1) estates 上實際有哪些政策（確認主管那條真的建起來了）
select
  policyname                                   as "政策",
  cmd                                          as "動作",
  coalesce(qual, '—')                          as "讀取條件",
  coalesce(with_check, '—')                    as "寫入條件"
from pg_policies
where schemaname = 'public' and tablename = 'estates'
order by policyname;

-- 2) 目前的打卡位置設定；順便把超出台灣範圍的挑出來
select
  e.name                                       as "物業",
  case when e.gps_lat is null then '未設定' else e.gps_lat::text end as "緯度",
  case when e.gps_lng is null then '未設定' else e.gps_lng::text end as "經度",
  e.gps_radius_m                               as "半徑",
  case
    when e.gps_lat is null or e.gps_lng is null then '尚未設定,這個物業不能打卡'
    when e.gps_lat not between 20 and 27
      or e.gps_lng not between 118 and 124     then '⚠ 座標不在台灣範圍內,很可能經緯度填反了'
    else '✓'
  end                                          as "檢查"
from public.estates e
where e.active
order by e.sort, e.name;


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    raise notice '%', (select public.record_migration('102_estates_gps_rls'));
  else
    raise notice '尚未建立 schema_migrations（migration_70），這支沒有被記錄';
  end if;
end $$;
