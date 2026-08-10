-- migration_97：打卡鐘（GPS 範圍、出勤紀錄、國定假日行事曆）
--
-- ============================================================
-- 【這一支的範圍】
--
--   1. 物業的 GPS 座標與允許打卡半徑
--   2. 出勤紀錄（一天一次上班、一次下班）
--   3. 台灣國定假日行事曆（先灌 2026 年）
--   4. 上班時間設定（每日工時 —— 請假換算小時要用）
--
-- 請假在 migration_98。分開是因為這兩塊各自都完整，
-- 打卡先上線也能用，不必等請假做完。
--
--
-- ============================================================
-- 【打卡規則（使用者確認）】
--
--   一天一次上班、一次下班。忘了打下班的那天標成異常，主管可以補。
--   GPS 每個物業一個範圍 —— 房務跑多個物業，在任何一個範圍內都能打，
--   而且紀錄會帶到底是在哪一個物業打的。
--
--
-- ============================================================
-- 【為什麼距離用 Haversine 而不是 PostGIS】
--
-- PostGIS 是正確的答案，但要裝擴充、要建幾何索引，
-- 而這裡的用途只有一個：判斷「這個點離那個點幾公尺」。
-- 打卡一天幾十次，不是查詢熱點。
--
-- Haversine 在幾公里的尺度誤差小於 0.5%，對「150 公尺內」這種判斷綽綽有餘。
-- 哪天真的需要空間查詢（找最近的物業、範圍重疊）再換 PostGIS。


-- ============================================================
-- 1. 物業的打卡範圍
-- ============================================================

alter table public.estates
  add column if not exists gps_lat numeric,
  add column if not exists gps_lng numeric,
  -- 500 公尺（使用者指定）。手機 GPS 在市區的誤差通常 10~50 公尺，
  -- 室內或高樓間更差；設太小會讓人站在門口卻打不了卡，
  -- 而那種失敗使用者只會覺得系統壞了，然後改用別的方式回報出勤。
  -- 每個物業可以個別調整。
  add column if not exists gps_radius_m int not null default 500;

comment on column public.estates.gps_lat is
  '打卡範圍的中心緯度。null = 這個物業不能打卡（沒設座標就不會出現在可打卡清單裡）。';
comment on column public.estates.gps_radius_m is
  '允許打卡的半徑（公尺）。預設 500 —— 手機 GPS 在市區誤差 10~50 公尺,室內更差;'
  '設太小會讓人站在門口卻打不了卡,而那種失敗使用者只會覺得系統壞了。';


-- ============================================================
-- 2. 兩點距離（公尺）
-- ============================================================

create or replace function public.gps_distance_m(
  lat1 numeric, lng1 numeric, lat2 numeric, lng2 numeric
) returns numeric language sql immutable as $fn$
  -- Haversine。6371000 是地球平均半徑（公尺）。
  select 2 * 6371000 * asin(sqrt(
    power(sin(radians(lat2 - lat1) / 2), 2)
    + cos(radians(lat1)) * cos(radians(lat2))
    * power(sin(radians(lng2 - lng1) / 2), 2)
  ))::numeric
$fn$;

comment on function public.gps_distance_m is
  '兩個經緯度之間的距離（公尺）。Haversine,幾公里尺度誤差 <0.5%,判斷打卡範圍夠用。';


-- ============================================================
-- 3. 上班設定
--
-- 單列表（id 恆為 1）。做成一列而不是一堆散落的常數，
-- 是因為「每日工時」請假換算要用、報表也要用 —— 兩邊各寫一個 8 的話，
-- 哪天改成 7.5 一定會漏掉一邊，而漏掉不會報錯，只會讓時數對不起來。
-- ============================================================

create table if not exists public.work_settings (
  id                 int primary key default 1 check (id = 1),
  work_hours_per_day numeric not null default 8,
  work_start         time    not null default '09:00',
  work_end           time    not null default '18:00',
  updated_at         timestamptz not null default now()
);
insert into public.work_settings (id) values (1) on conflict (id) do nothing;

comment on table public.work_settings is
  '單列設定表（id 恆為 1）。每日工時是請假換算小時的分母,只能有一個來源。';


-- ============================================================
-- 4. 國定假日行事曆
--
-- 每年由行政院人事行政總處公告，**不是算出來的** ——
-- 補假規則會改（2025 下半年起取消補班，只補假），農曆日期每年不同。
-- 所以存成資料，每年灌一次。
-- ============================================================

create table if not exists public.holidays (
  d       date primary key,
  name    text not null,
  -- holiday = 放假 / makeup = 補班（2026 年沒有,但制度可能再改回來）
  kind    text not null default 'holiday' check (kind in ('holiday', 'makeup')),
  note    text
);

comment on table public.holidays is
  '國定假日與補班日。每年由行政院人事行政總處公告,**不要用程式算** —— '
  '補假規則改過（2025 下半年起取消補班）,農曆日期每年不同。';

/*
 * 2026（民國 115）年。
 * 來源：行政院人事行政總處 115 年政府行政機關辦公日曆表。
 *
 * **2026 年沒有補班日** —— 2025 下半年起改為只補假不補班。
 * 例假日（週六日）不列在這裡，那是另一回事。
 */
insert into public.holidays (d, name, note) values
  ('2026-01-01', '元旦', null),
  ('2026-02-15', '小年夜', '春節連假 2/14~2/22'),
  ('2026-02-16', '農曆除夕', null),
  ('2026-02-17', '春節初一', null),
  ('2026-02-18', '春節初二', null),
  ('2026-02-19', '春節初三', null),
  ('2026-02-20', '小年夜補假', '小年夜逢週日,次一上班日補假'),
  ('2026-02-27', '和平紀念日補假', '2/28 逢週六,前一上班日補假'),
  ('2026-02-28', '和平紀念日', null),
  ('2026-04-03', '兒童節補假', null),
  ('2026-04-04', '兒童節', null),
  ('2026-04-05', '民族掃墓節', '清明'),
  ('2026-04-06', '民族掃墓節補假', null),
  ('2026-05-01', '勞動節', null),
  ('2026-06-19', '端午節', null),
  ('2026-09-25', '中秋節', null),
  ('2026-09-28', '教師節', null),
  ('2026-10-09', '國慶日補假', '10/10 逢週六,前一上班日補假'),
  ('2026-10-10', '國慶日', null),
  ('2026-10-25', '臺灣光復暨金門古寧頭大捷紀念日', null),
  ('2026-10-26', '臺灣光復節補假', '10/25 逢週日,次一上班日補假'),
  ('2026-12-25', '行憲紀念日', null)
on conflict (d) do nothing;

/** 這一天要不要上班（週六日與國定假日都算休息，補班日算上班） */
create or replace function public.is_workday(p_date date)
returns boolean language sql stable as $fn$
  select case
    when exists (select 1 from public.holidays h where h.d = p_date and h.kind = 'makeup') then true
    when exists (select 1 from public.holidays h where h.d = p_date and h.kind = 'holiday') then false
    else extract(isodow from p_date) < 6      -- 1=一 … 5=五 上班,6/7 休息
  end
$fn$;


-- ============================================================
-- 5. 出勤紀錄
--
-- 一人一天一列（唯一鍵）。上下班各自記時間、座標、在哪個物業、是否在範圍內。
--
-- **座標與「是否在範圍內」都存下來。**
-- 只存 true/false 的話，事後有人說「我明明在現場」就查不下去了；
-- 只存座標的話，物業座標之後被改動，歷史紀錄的判定會跟著變 ——
-- 那等於回頭改寫已經發生的事。兩個都存才對得起來。
-- ============================================================

create table if not exists public.attendance (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.profiles(id) on delete cascade,
  work_date     date not null,

  in_at         timestamptz,
  in_lat        numeric,
  in_lng        numeric,
  in_estate_id  uuid references public.estates(id),
  in_distance_m numeric,
  in_in_range   boolean,

  out_at        timestamptz,
  out_lat       numeric,
  out_lng       numeric,
  out_estate_id uuid references public.estates(id),
  out_distance_m numeric,
  out_in_range  boolean,

  -- 主管補登時寫明原因。誰補的靠 data_audit 查。
  note          text,
  edited_by     uuid references public.profiles(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create unique index if not exists attendance_user_date_uniq
  on public.attendance (user_id, work_date);
create index if not exists attendance_date_idx on public.attendance (work_date);

comment on table public.attendance is
  '出勤紀錄,一人一天一列。上下班的座標與「當時是否在範圍內」都存下來 —— '
  '只存判定結果的話事後查不下去,只存座標的話物業座標改了會回頭改寫歷史。';

/** 工時（小時）。沒打下班就是 null —— 不要猜一個 8 出來。 */
create or replace function public.attendance_hours(a public.attendance)
returns numeric language sql immutable as $fn$
  select case when a.in_at is null or a.out_at is null then null
              else round(extract(epoch from (a.out_at - a.in_at)) / 3600.0, 2) end
$fn$;


-- ============================================================
-- 6. RLS
--
-- 讀：自己的一律看得到；主管與總經理看全部；會計看全部（要出出勤表）
-- 寫：自己只能打自己的卡；主管與總經理可以補登任何人的
-- ============================================================

alter table public.attendance enable row level security;

drop policy if exists att_read on public.attendance;
create policy att_read on public.attendance for select
  using (user_id = auth.uid()
         or current_role_of() = any (array['manager', 'super_admin', 'accountant']));

drop policy if exists att_self_write on public.attendance;
create policy att_self_write on public.attendance for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists att_admin_write on public.attendance;
create policy att_admin_write on public.attendance for all
  using (current_role_of() = any (array['manager', 'super_admin']))
  with check (current_role_of() = any (array['manager', 'super_admin']));

-- 行事曆與設定：所有人可讀，主管以上可改
alter table public.holidays enable row level security;
drop policy if exists hol_read on public.holidays;
create policy hol_read on public.holidays for select using (current_role_of() is not null);
drop policy if exists hol_write on public.holidays;
create policy hol_write on public.holidays for all
  using (current_role_of() = any (array['manager', 'super_admin']))
  with check (current_role_of() = any (array['manager', 'super_admin']));

alter table public.work_settings enable row level security;
drop policy if exists ws_read on public.work_settings;
create policy ws_read on public.work_settings for select using (current_role_of() is not null);
drop policy if exists ws_write on public.work_settings;
create policy ws_write on public.work_settings for all
  using (current_role_of() = any (array['manager', 'super_admin']))
  with check (current_role_of() = any (array['manager', 'super_admin']));


notify pgrst, 'reload schema';


-- ============================================================
-- 驗證
--
-- 包在 exception 裡：驗證失敗只發警告，不要把上面的變更整包回滾掉。
-- ============================================================

do $$
declare n int; dist numeric;
begin
  select count(*) into n from information_schema.tables
   where table_schema = 'public' and table_name in ('attendance', 'holidays', 'work_settings');
  if n = 3 then raise notice '✅ attendance / holidays / work_settings 都建立了';
  else raise warning '❌ 只建立了 % 張表', n; end if;

  select count(*) into n from information_schema.columns
   where table_schema = 'public' and table_name = 'estates' and column_name like 'gps%';
  if n = 3 then raise notice '✅ 物業的 GPS 三個欄位都加上了';
  else raise warning '❌ estates 只加了 % 個 GPS 欄位', n; end if;

  -- 距離函式：台北車站 → 101 直線約 4.4 公里,誤差不該超過 5%
  select public.gps_distance_m(25.0478, 121.5170, 25.0339, 121.5645) into dist;
  if dist between 4200 and 4800 then
    raise notice '✅ 距離函式正確（台北車站→101 算出 % 公尺）', round(dist);
  else raise warning '❌ 距離函式算錯,台北車站→101 應約 4400 公尺,算出 %', round(dist); end if;

  -- 同一點距離必須是 0
  if public.gps_distance_m(25.0, 121.5, 25.0, 121.5) < 0.01 then
    raise notice '✅ 同一點距離為 0';
  else raise warning '❌ 同一點距離不是 0'; end if;

  select count(*) into n from public.holidays where extract(year from d) = 2026;
  if n >= 20 then raise notice '✅ 2026 年國定假日已灌入 % 天', n;
  else raise warning '❌ 2026 年只有 % 天,應該有 22 天', n; end if;

  -- is_workday：元旦不上班、1/2 上班、週六不上班
  if not public.is_workday('2026-01-01') and public.is_workday('2026-01-02')
     and not public.is_workday('2026-01-03') then
    raise notice '✅ is_workday 正確（元旦休、1/2 上班、週六休）';
  else raise warning '❌ is_workday 判斷有誤'; end if;

  select count(*) into n from pg_tables
   where schemaname = 'public' and tablename = 'attendance' and rowsecurity;
  if n = 1 then raise notice '✅ 出勤紀錄的 RLS 已啟用（自己看自己,主管看全部）';
  else raise warning '❌ attendance 的 RLS 沒開'; end if;

exception when others then
  raise warning '驗證區出錯（上面的變更不受影響）:%', sqlerrm;
end $$;


-- ── 2026 年上班日統計（給人核對）─────────────────────
--
-- 這一段踩過兩個坑，都讓整支 migration 回滾過（Supabase 是單一交易）：
--
--   1. `column reference "d" is ambiguous`
--      generate_series 的別名是 d，holidays 也有一欄叫 d。
--      → 每個都要寫成 g.d
--
--   2. `function is_workday(timestamp with time zone) does not exist`
--      **generate_series(date, date, interval) 回傳的是 timestamp，不是 date。**
--      → 在子查詢裡先轉成 date 一次，外面就都是真的 date
--
-- 轉型放在來源而不是每個用到的地方各轉一次 —— 那樣漏掉一處就又是一次回滾。
select
  to_char(g.d, 'YYYY-MM')                            as 月份,
  count(*) filter (where public.is_workday(g.d))     as 上班日,
  count(*) filter (where not public.is_workday(g.d)) as 休息日,
  string_agg(h.name, '、' order by g.d)              as 國定假日
from (
  select gs::date as d
    from generate_series('2026-01-01'::date, '2026-12-31'::date, '1 day') gs
) g
left join public.holidays h on h.d = g.d and h.kind = 'holiday'
group by 1 order by 1;


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    raise notice '%', (select public.record_migration('97_attendance'));
  else
    raise notice '尚未建立 schema_migrations（migration_70），這支沒有被記錄';
  end if;
end $$;
