-- migration_58：房務排班統計
--
-- 把排班紀錄換算成「每人工作量」與「各房源打掃次數／床單用量」。
-- 原本是人工點 TimeTree 再手填 Excel。
--
-- 兩個計數方式不一樣，這是整套邏輯的核心：
--
--   間數(某人某日)   = 該人的工作項數量
--                      兩人合掃同一間 → 兩人各 +1（各自的工作量都算數）
--
--   打掃次數(某房源) = Σ_日期 該日不重複的清掃次數
--                      兩人合掃同一間 → 只算 1 次
--                      理由：次數會乘上「幾床」推算床單用量，
--                            用人頭計次會讓布巾量直接翻倍
--
-- 房源主檔獨立於 public.properties。房務的單位跟可出租的房源對不起來：
-- 「時兆公區」「開封整棟」「復興」不是房源，而 A1~A18 這套代碼
-- 在 ERP 裡是另一種命名。硬併進去會讓營收報表跑出「公區」這種東西。

-- ============================================================
-- 1. 人員對照
-- ============================================================
create table if not exists public.hk_staff (
  id            uuid primary key default gen_random_uuid(),
  source_name   text not null unique,        -- 排班表上的顯示名，比對用
  code          text not null,               -- UNA / 庭玉 / LIU
  name          text not null,
  -- rooms = 計間數（Una、庭玉）
  -- hours = 只計時數，間數不算（劉姐）
  -- none  = 不列入統計（入住準備組）
  count_mode    text not null default 'none' check (count_mode in ('rooms','hours','none')),
  -- 計不計入「打掃次數」。劉姐是 hours 但她掃過的房間仍要算次數，
  -- 否則那幾間的床單用量會憑空少掉。
  count_cleans  boolean not null default true,
  color         text,                        -- 報表底色，如 FCE4D6
  leave_prefix  text,                        -- 休假標題前綴：U休 / A休
  active        boolean not null default true,
  sort          int not null default 0
);

comment on table public.hk_staff is '房務人員對照。source_name 是排班表上的顯示名，用來把事件的負責人對到系統代號。';

insert into public.hk_staff (source_name, code, name, count_mode, count_cleans, color, leave_prefix, sort) values
  ('SHAO-YING HSIEH', 'UNA',  'Una',  'rooms', true,  'FCE4D6', 'U休', 1),
  ('Ayu',             '庭玉', '庭玉', 'rooms', true,  'E2EFDA', 'A休', 2),
  ('劉姐',            'LIU',  '劉姐', 'hours', true,  'D9D9D9', null,  3),
  ('綠庭清潔',        'GT',   '綠庭清潔(外包)', 'none', true, null, null, 4),
  ('月(Dianne)',      'DIA',  '月 Dianne', 'none', false, null, null, 10),
  ('Carol芊芊',       'CAR',  'Carol 芊芊', 'none', false, null, null, 11),
  ('唐筑萱',          'TCH',  '唐筑萱', 'none', false, null, null, 12),
  ('花花',            'HUA',  '花花',   'none', false, null, null, 13),
  ('Jessica',         'JES',  'Jessica','none', false, null, null, 14)
on conflict (source_name) do nothing;


-- ============================================================
-- 2. 房源主檔
--
-- linen_group 對應 Excel 右側的三張表（不同布巾供應商／區域）：
--   kai = 開整棟系、ab = A/B 系、zl = 正隆、other = 未歸類
-- ============================================================
create table if not exists public.hk_property (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique,
  name        text,
  aliases     text[] not null default '{}',   -- 標題裡可能出現的別名
  beds        int,                            -- null = 尚未建檔，公區為 0
  linen_group text not null default 'other' check (linen_group in ('kai','ab','zl','other')),
  is_common   boolean not null default false, -- 公區：不算床，但要統計次數
  active      boolean not null default true,
  sort        int not null default 0
);

comment on column public.hk_property.aliases is
  '標題裡可能出現的寫法。解析時先抽候選字串再比對別名，比純 regex 穩 —— 例如「開封整棟」要對到「開整棟」。';

insert into public.hk_property (code, aliases, beds, linen_group, is_common, sort) values
  -- 區塊一：開整棟系
  ('開整棟', array['開封整棟'],          8, 'kai', false, 1),
  ('開4',   array['開封4'],              3, 'kai', false, 2),
  ('開3',   array['開封3'],              2, 'kai', false, 3),
  ('開2',   array['開封2'],              3, 'kai', false, 4),
  ('開2-2', '{}',                        1, 'kai', false, 5),
  ('開2-1', '{}',                        2, 'kai', false, 6),
  ('南五',  '{}',                        3, 'kai', false, 7),
  ('亞曼尼', array['亞'],                2, 'kai', false, 8),
  ('RMJ',   '{}',                        4, 'kai', false, 9),
  ('JPR1',  '{}',                        2, 'kai', false, 10),
  ('JPR2',  '{}',                        2, 'kai', false, 11),
  ('M',     '{}',                        3, 'kai', false, 12),
  ('V',     '{}',                        1, 'kai', false, 13),
  ('C',     '{}',                        1, 'kai', false, 14),
  ('台1+2', array['台1', '台2+1'],       2, 'kai', false, 15),
  ('台3',   '{}',                        1, 'kai', false, 16),
  ('台4',   '{}',                        1, 'kai', false, 17),
  ('復興',  '{}',                        0, 'kai', false, 18),
  -- 公區：不算床，但要統計次數
  ('台視公區', '{}',                     0, 'kai', true,  19),
  ('時兆公區', '{}',                     0, 'kai', true,  20),
  ('開封公區', array['開封樓梯公共區域'], 0, 'kai', true,  21)
on conflict (code) do nothing;

-- A 系（A10、A12 不存在，比照 Excel）
insert into public.hk_property (code, beds, linen_group, sort)
select 'A' || n, 1, 'ab', 100 + n
from unnest(array[1,2,3,4,5,6,7,8,9,11,13,14,15,16,17,18]) as n
on conflict (code) do nothing;

-- B 系
insert into public.hk_property (code, beds, linen_group, sort)
select 'B' || n, 1, 'ab', 200 + n
from generate_series(1, 8) as n
on conflict (code) do nothing;

-- 正隆
insert into public.hk_property (code, beds, linen_group, sort) values
  ('3A3', 4, 'zl', 301), ('3A5', 4, 'zl', 302),
  ('4B1', 4, 'zl', 303), ('4B2', 4, 'zl', 304),
  ('4B3', 3, 'zl', 305), ('4B5', 3, 'zl', 306),
  ('7B1', 4, 'zl', 307), ('9A5', 4, 'zl', 308),
  ('10A5', 4, 'zl', 309), ('13A5', 4, 'zl', 310),
  ('14A5', 4, 'zl', 311), ('14B1', 4, 'zl', 312),
  ('14B2', 4, 'zl', 313), ('14B3', 3, 'zl', 314),
  ('14B5', 3, 'zl', 315)
on conflict (code) do nothing;

-- 待補建檔：出現在排班表但還沒有幾床。beds = null 會在報表上標黃提醒。
insert into public.hk_property (code, aliases, beds, linen_group, is_common, sort) values
  ('17B5', '{}', null, 'other', false, 400),
  ('18B5', '{}', null, 'other', false, 401),
  ('19B2', '{}', null, 'other', false, 402),
  ('6B2',  '{}', null, 'other', false, 403),
  ('J1',   '{}', null, 'other', false, 404),
  ('J2',   '{}', null, 'other', false, 405),
  ('台S',  '{}', null, 'other', false, 406),
  ('台2',  '{}', null, 'other', false, 409),
  ('JPR整棟', array['JPR'], null, 'other', false, 407),
  ('時兆二樓', array['時兆2樓','時兆二樓公區'], 0, 'other', true, 408)
on conflict (code) do nothing;


-- ============================================================
-- 3. 原始事件
--
-- 保留原文。解析規則之後一定會改，屆時要能從原始資料重跑，
-- 而不是回頭再爬一次。
-- ============================================================
create table if not exists public.hk_event (
  id          uuid primary key default gen_random_uuid(),
  period      text not null,                  -- YYYYMM
  event_date  date not null,
  title       text not null,
  label       text,                           -- 入住 / 退房 / 清潔 / 休假 / 其他
  assignees   text[] not null default '{}',   -- 原始負責人字串
  external_id text,                           -- 來源系統的 event id
  -- 解析結果一併留著，之後要重跑或稽核才有依據
  parsed_code text,                           -- 解析出的房源代碼，null = 未識別
  work_type   text,
  excluded    text,                           -- 被排除的原因：leave / no_assignee / not_counted
  imported_at timestamptz not null default now(),
  unique (period, event_date, title, external_id)
);

create index if not exists hk_event_period_idx on public.hk_event (period, event_date);


-- ============================================================
-- 4. 工作項（事件 × 負責人展開）
-- ============================================================
create table if not exists public.hk_work_item (
  id            uuid primary key default gen_random_uuid(),
  event_id      uuid not null references public.hk_event(id) on delete cascade,
  period        text not null,
  work_date     date not null,
  property_code text,                          -- null = 無房源（協助行政、洗烘折毛巾）
  work_type     text not null default '清潔',
  staff_id      uuid not null references public.hk_staff(id),
  created_at    timestamptz not null default now()
);

create index if not exists hk_wi_period_idx on public.hk_work_item (period, work_date);
create index if not exists hk_wi_prop_idx   on public.hk_work_item (period, property_code);


-- ============================================================
-- 5. 每日狀態（休假、時數）
--
-- 休假不是「沒有工作項」—— 那兩件事在報表上意義不同：
-- 沒排班是空白，休假要明確標示，而且要能算月休天數。
-- ============================================================
create table if not exists public.hk_day (
  period    text not null,
  work_date date not null,
  staff_id  uuid not null references public.hk_staff(id) on delete cascade,
  status    text,                              -- 休 / 特休 / 請假 / 颱風假 / 報到 …
  hours     numeric,                           -- 劉姐時數，手動填
  note      text,
  primary key (work_date, staff_id)
);


-- ============================================================
-- 6. 月份 × 房源的手動變數
-- ============================================================
create table if not exists public.hk_month_property (
  period         text not null,
  property_code  text not null,
  count_override int,      -- 次數覆寫。null = 用自動算的
  linen_taken    int not null default 0,   -- 額外領用的床單
  primary key (period, property_code)
);

comment on column public.hk_month_property.count_override is
  '手動覆寫打掃次數。自動算錯或有系統外的清掃時用，null 表示採用自動值。';


-- ============================================================
-- 7. 月份設定
-- ============================================================
create table if not exists public.hk_period (
  period      text primary key,
  count_mode  text not null default 'clean' check (count_mode in ('clean','headcount')),
  include_gift boolean not null default true,
  note        text,
  updated_at  timestamptz not null default now()
);

comment on column public.hk_period.count_mode is
  'clean = 同日同房源多人合掃算 1 次（預設，布巾量才不會翻倍）；headcount = 人頭計次。';


-- ============================================================
-- 8. RLS：主管與總經理。房務排班牽涉個人工作量與出勤。
-- ============================================================
do $$
declare t text;
begin
  foreach t in array array['hk_staff','hk_property','hk_event','hk_work_item',
                           'hk_day','hk_month_property','hk_period']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_all', t);
    execute format($f$
      create policy %I on public.%I for all
        using (current_role_of() in ('manager','super_admin'))
        with check (current_role_of() in ('manager','super_admin'))
    $f$, t || '_all', t);
  end loop;
end $$;


-- ============================================================
-- 驗證
-- ============================================================
select count(*) as 人員 from public.hk_staff;
select linen_group, count(*) as 房源數, count(*) filter (where beds is null) as 待補幾床
from public.hk_property group by linen_group order by 1;
