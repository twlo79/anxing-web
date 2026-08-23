-- migration_115：管家任期（誰在哪段時間管哪個物業）
--
-- ============================================================
-- 【要解決的問題】
--
-- 現在「誰負責哪個物業」是 estates.manager 一個文字欄位 —— 沒有時間。
-- 管家輪動之後把那格改成新的人，**過去所有評價的歸屬就跟著一起變**。
--
-- 具體地說：小美管時兆管到 6 月，7 月換阿華。把欄位改成阿華之後，
-- 小美在 1～6 月累積的每一則評價都變成阿華的成績單。
--
-- 這不只是「不準」——它讓評分完全失去意義：
--   · 新接手的人一上任就背著前任的分數
--   · 離開的人的貢獻憑空消失
--   · 而且沒有任何跡象顯示這件事發生過
--
--
-- ============================================================
-- 【設計：一個物業一段任期，接手就開新的一段】
--
--   estate_managers(estate_id, staff_id, start_date, end_date)
--
--   end_date 是 null 代表「至今」。
--   接手時：把前一段的 end_date 補上，再開一段新的。
--
-- 評價要算誰的，就拿**退房日**回去查那天是誰在管（使用者決定）。
-- 退房日的理由：房客住的大部分時間是新接手的人在管，
-- 而清潔與交屋正是退房那天的事。跨月長住歸給最後接手的人。
--
--
-- ============================================================
-- 【為什麼用 staff_id 而不是存名字】
--
-- 存名字的話，改一次名字（結婚改姓、打錯字修正）就會讓歷史裂成兩個人 ——
-- 而報表按名字分組，那兩半永遠合不回來，也不會有人發現。
--
-- 代價是要先有 staff 資料。這個系統本來就有（管家都在裡面），
-- 所以不是新的負擔。
--
--
-- ============================================================
-- 【為什麼要排他約束而不是靠前端擋】
--
-- 「同一個物業同一天不能有兩個管家」如果只在畫面上擋，
-- 那條規則就只在那一個按鈕上成立 —— 匯入、批次修正、直接下 SQL
-- 都會繞過去。而一旦重疊了，manager_stats 會**默默地把同一則評價
-- 算給兩個人**（join 出兩列），總數對不上但每個人的數字看起來都正常。
--
-- 排他約束是資料庫層級的，繞不過去。

create extension if not exists btree_gist;

create table if not exists public.estate_managers (
  id          uuid primary key default gen_random_uuid(),
  estate_id   uuid not null references public.estates(id) on delete cascade,
  staff_id    uuid not null references public.staff(id),
  start_date  date not null,
  /** null = 至今。接手時才把前一段補上迄日。 */
  end_date    date,
  note        text,
  created_at  timestamptz not null default now(),
  created_by  uuid,
  constraint estate_managers_dates check (end_date is null or end_date >= start_date)
);

comment on table public.estate_managers is
  '管家任期：誰在哪段時間負責哪個物業。end_date 為 null 代表至今。'
  '評價依「退房日」回查這張表決定歸屬 —— 改管家不會動到歷史成績。';

create index if not exists idx_estate_managers_estate
  on public.estate_managers (estate_id, start_date);
create index if not exists idx_estate_managers_staff
  on public.estate_managers (staff_id);

/*
 * 同一個物業的任期不能重疊。
 *
 * daterange 用 '[]'（含頭含尾）—— 因為 end_date 是「最後一天他還在管」，
 * 不是「他離開的那天」。用 '[)' 的話，前一段迄日 6/30、後一段起日 7/1
 * 是對的，但迄日 6/30、起日 6/30 也會過 —— 而那天有兩個人在管。
 */
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'estate_managers_no_overlap') then
    alter table public.estate_managers add constraint estate_managers_no_overlap
      exclude using gist (
        estate_id with =,
        daterange(start_date, coalesce(end_date, 'infinity'::date), '[]') with &&
      );
  end if;
end $$;


-- ── 權限 ───────────────────────────────────────────
alter table public.estate_managers enable row level security;

drop policy if exists em_read on public.estate_managers;
create policy em_read on public.estate_managers
  for select using (auth.role() = 'authenticated');

/*
 * 只有主管與總經理能改。
 *
 * 這張表直接決定每個人的評分成績單 —— 讓被評分的人自己能改，
 * 那個分數就不再是一個評價，而是一個可以協商的東西。
 */
drop policy if exists em_write on public.estate_managers;
create policy em_write on public.estate_managers
  for all using      (current_role_of() in ('manager', 'super_admin'))
         with check  (current_role_of() in ('manager', 'super_admin'));


-- ============================================================
-- 那一天是誰在管
-- ============================================================
create or replace function public.manager_of_estate(p_estate uuid, p_on date)
returns text language sql stable as $fn$
  select s.name
  from public.estate_managers em
  join public.staff s on s.id = em.staff_id
  where em.estate_id = p_estate
    and p_on >= em.start_date
    and (em.end_date is null or p_on <= em.end_date)
  limit 1
$fn$;

comment on function public.manager_of_estate(uuid, date) is
  '那一天誰負責這個物業。查不到回 null（那段期間還沒有登記任期）。';


-- ============================================================
-- 管家評分：改成依退房日查任期
-- ============================================================
--
-- 【跟改版前唯一的差別】
-- 原本：group by estates.manager（現在是誰，全部歷史都算他的）
-- 現在：group by 那則評價退房日當天的管家
--
-- 【查不到任期的評價會落在「未指派」】
-- 使用者決定「從登記任期之前不算」，所以剛上線時多數歷史評價會在那一格。
-- **刻意讓它看得見**：如果靜靜地把那些評價丟掉，總數會對不上，
-- 而沒有人會知道少了什麼。落在「未指派」的話，那一列的數字
-- 本身就是「還有這麼多評價沒有歸屬」的提醒。
create or replace function public.manager_stats(p_from date default null, p_to date default null)
returns table(manager text, avg_rating numeric, s5 bigint, s4 bigint, s3 bigint, s2 bigint, s1 bigint, total bigint)
language sql stable as $fn$
  select
    coalesce(m.name, '未指派'),
    round(avg(r.overall_rating), 2),
    count(*) filter (where r.overall_rating >= 5),
    count(*) filter (where r.overall_rating >= 4 and r.overall_rating < 5),
    count(*) filter (where r.overall_rating >= 3 and r.overall_rating < 4),
    count(*) filter (where r.overall_rating >= 2 and r.overall_rating < 3),
    count(*) filter (where r.overall_rating < 2),
    count(*)
  from reviews r
  join properties p on p.id = r.property_id
  join estates e on e.id = p.estate_id
  /*
   * lateral 而不是普通 join —— 普通 join 在任期重疊時會把同一則評價
   * 變成兩列（雖然有排他約束擋著，但那是兩道防線）。
   * limit 1 保證一則評價只會算一次。
   */
  left join lateral (
    select s.name
    from public.estate_managers em
    join public.staff s on s.id = em.staff_id
    where em.estate_id = e.id
      and r.checkout_date >= em.start_date
      and (em.end_date is null or r.checkout_date <= em.end_date)
    limit 1
  ) m on true
  where e.active
    and (p_from is null or r.checkout_date >= p_from)
    and (p_to   is null or r.checkout_date <= p_to)
  group by coalesce(m.name, '未指派')
  order by 1
$fn$;

comment on function public.manager_stats(date, date) is
  '管家評分。依**退房日**回查 estate_managers 決定歸屬 —— '
  '改管家不會動到歷史成績。查不到任期的落在「未指派」。';


-- ============================================================
-- estates.manager 還留著，但已經不是真相
-- ============================================================
comment on column public.estates.manager is
  '⚠️ 已由 estate_managers 取代（migration_115）。'
  '這一欄沒有時間維度，改一次就會重寫全部歷史 —— 不要再讀它。'
  '暫時保留是為了不動到還沒改完的呼叫點,確認沒人用之後可以移除。';


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('115_estate_managers');
  end if;
end $$;


-- ============================================================
-- 驗證（結果直接是表格 —— raise notice 在 SQL Editor 看不到）
-- ============================================================
do $$
declare
  v_est uuid; v_a uuid; v_b uuid; n int; nm text;
begin
  drop table if exists _chk115;
  create temp table _chk115 (ord int, item text, result text, detail text);

  insert into _chk115 values (1, 'estate_managers 表',
    case when to_regclass('public.estate_managers') is not null then '✅' else '❌' end, '');
  insert into _chk115 values (1, 'manager_of_estate 函式',
    case when to_regprocedure('public.manager_of_estate(uuid,date)') is not null
         then '✅' else '❌' end, '');

  select id into v_est from public.estates limit 1;
  select id into v_a from public.staff order by name limit 1;
  select id into v_b from public.staff where id <> v_a order by name limit 1;
  if v_est is null or v_a is null or v_b is null then
    insert into _chk115 values (2, '前置', '－ 跳過', '需要至少一個物業與兩位人員才測得起來');
  else
    delete from public.estate_managers where note = '__TEST__';

    insert into public.estate_managers (estate_id, staff_id, start_date, end_date, note)
    values (v_est, v_a, '2020-01-01', '2026-06-30', '__TEST__');
    insert into public.estate_managers (estate_id, staff_id, start_date, end_date, note)
    values (v_est, v_b, '2026-07-01', null, '__TEST__');

    insert into _chk115 values (2, '★ 換手前後查到不同的人',
      case when public.manager_of_estate(v_est, '2026-06-20')
             is distinct from public.manager_of_estate(v_est, '2026-07-10')
           then '✅' else '❌' end,
      '6/20 → ' || coalesce(public.manager_of_estate(v_est, '2026-06-20'), 'null')
      || '、7/10 → ' || coalesce(public.manager_of_estate(v_est, '2026-07-10'), 'null'));

    insert into _chk115 values (3, '★ 交接當天只有一個人',
      case when public.manager_of_estate(v_est, '2026-06-30') is not null
            and public.manager_of_estate(v_est, '2026-07-01') is not null
           then '✅' else '❌' end,
      '6/30 是前任最後一天,7/1 是新任第一天');

    -- 重疊要被資料庫擋下來
    begin
      insert into public.estate_managers (estate_id, staff_id, start_date, end_date, note)
      values (v_est, v_a, '2026-06-15', '2026-07-15', '__TEST__');
      insert into _chk115 values (4, '★★ 任期重疊要被擋',
        '❌ 沒擋住', '重疊的話同一則評價會被算給兩個人,而總數看起來仍然正常');
    exception when exclusion_violation then
      insert into _chk115 values (4, '★★ 任期重疊要被擋', '✅ 資料庫層級擋下',
        '只在畫面上擋的話,匯入與直接下 SQL 都會繞過去');
    end;

    -- 起日之前查不到人
    insert into _chk115 values (5, '登記之前查不到管家',
      case when public.manager_of_estate(v_est, '2019-01-01') is null
           then '✅ 回 null' else '❌' end,
      '那些評價會落在「未指派」—— 刻意讓它看得見,不是靜靜丟掉');

    delete from public.estate_managers where note = '__TEST__';
  end if;

  -- 目前的登記狀況
  select count(*) into n from public.estate_managers;
  insert into _chk115 values (6, '目前已登記的任期', n || ' 段',
    case when n = 0 then '還沒有任何登記 —— 到「權限管理 → 物業與負責人」開始建'
         else '' end);

  select count(*) into n from public.estates where active and not exists (
    select 1 from public.estate_managers em where em.estate_id = estates.id and em.end_date is null);
  insert into _chk115 values (7, '★ 還沒有現任管家的物業',
    case when n = 0 then '✅ 都有了' else '⚠ ' || n || ' 個' end,
    '沒有現任的話,之後的新評價會一直落在「未指派」');
end $$;

select item as "檢查項目", result as "結果", detail as "說明"
from _chk115 order by ord, item;
