-- migration_99：請假（假別、特休年資表、時數餘額、兩票核可）
--
-- ============================================================
-- 【單位是小時，不是天】
--
-- 使用者指定。所有額度與已用時數都存小時：
--
--     特休 10 天 × 每日 8 小時 = 80 小時
--
-- 「每日 8 小時」來自 work_settings（migration_97），不是寫死的 8 ——
-- 兩個地方各寫一個 8 的話，哪天改成 7.5 一定會漏掉一邊，
-- 而漏掉不會報錯，只會讓時數對不起來。
--
--
-- ============================================================
-- 【特休天數是資料，不是程式】
--
-- 勞基法第 38 條的年資級距會修，公司政策也會變。
-- 寫死在程式裡的話，每次調整都要改程式、推版、而且改漏一處沒人發現。
--
-- 所以做成 leave_seniority 這張表，主管在畫面上改。
--
-- 灌入的預設值 = **勞基法 ＋ 第一年多三天**（使用者指定）：
--
--     年資        勞基法   安幸
--     滿 6 個月     3 天    6 天   ← +3
--     滿 1 年       7 天   10 天   ← +3
--     滿 2 年      10 天   10 天
--     滿 3 年      14 天   14 天
--     滿 5 年      15 天   15 天
--     滿 10 年     16 天   16 天   （之後每年 +1，上限 30）
--
-- ⚠️ 「第一年多三天」的解讀請確認：我理解成前兩級各 +3。
--    不對的話直接改 leave_seniority 那張表，不用改程式。
--
--
-- ============================================================
-- 【為什麼餘額是一張表而不是算出來的】
--
-- 「還剩幾小時」理論上可以用「額度 − 已核可的請假時數」即時算。
-- 但那樣有兩個問題：
--
--   1. 期初匯入的餘額沒地方放（使用者要求「把人員剩餘的假匯進來」）
--   2. 年度結轉、特休折現、主管手動調整，都不是「請假」但會動到餘額
--
-- 所以額度存下來，已用時數由觸發器維護 —— 兩個數字都看得到，
-- 對不上的時候查得出來是哪一筆造成的。


-- ============================================================
-- 1. 假別
-- ============================================================

create table if not exists public.leave_types (
  code        text primary key,
  name        text not null,
  -- 有沒有額度上限。事假通常無上限（但要扣薪）,特休有。
  has_quota   boolean not null default true,
  -- 這種假要不要扣薪（只記錄,薪資系統不在這裡）
  paid        boolean not null default true,
  sort        int not null default 0,
  active      boolean not null default true,
  note        text
);

insert into public.leave_types (code, name, has_quota, paid, sort, note) values
  ('annual',   '年假（特休）', true,  true,  10, '依年資給,見 leave_seniority'),
  ('sick',     '病假',        true,  true,  20, '勞工請假規則:一年 30 日內半薪'),
  ('personal', '事假',        false, false, 30, '一年上限 14 日,不給薪')
on conflict (code) do update set name = excluded.name, note = excluded.note;


-- ============================================================
-- 2. 特休年資表
--
-- threshold_months = 年資達到幾個月適用這一級。
-- 取「小於等於年資」裡最大的那一級。
-- ============================================================

create table if not exists public.leave_seniority (
  threshold_months int primary key,
  days             numeric not null,
  note             text
);

insert into public.leave_seniority (threshold_months, days, note) values
  (6,   6,  '勞基法 3 天 + 安幸加給 3 天'),
  (12,  10, '勞基法 7 天 + 安幸加給 3 天'),
  (24,  10, '勞基法滿 2 年'),
  (36,  14, '勞基法滿 3 年'),
  (60,  15, '勞基法滿 5 年'),
  (120, 16, '勞基法滿 10 年,之後每年加 1 天,上限 30 天')
on conflict (threshold_months) do nothing;

comment on table public.leave_seniority is
  '特休年資表。**這是資料不是程式** —— 勞基法會修、公司政策會變,'
  '寫死在程式裡每次調整都要推版,而且改漏一處沒人發現。';

/** 到職滿 N 個月時的特休天數。滿 10 年之後每年加 1 天,上限 30。 */
create or replace function public.annual_leave_days(p_months int)
returns numeric language sql stable as $fn$
  select case
    when p_months >= 120 then
      -- 滿 10 年 16 天,之後每滿一年加 1,上限 30
      least(30, 16 + floor((p_months - 120) / 12.0))
    else coalesce(
      (select s.days from public.leave_seniority s
        where s.threshold_months <= p_months and s.threshold_months < 120
        order by s.threshold_months desc limit 1), 0)
  end
$fn$;


-- ============================================================
-- 3. 每人每年的假別餘額
--
-- 一人 × 一年 × 一種假 = 一列。
-- quota_hours 是額度（可以匯入、可以手改），used_hours 由觸發器維護。
-- ============================================================

create table if not exists public.leave_balances (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.profiles(id) on delete cascade,
  year         int  not null,
  type_code    text not null references public.leave_types(code),
  quota_hours  numeric not null default 0,
  -- 由觸發器維護,前端不要寫
  used_hours   numeric not null default 0,
  note         text,
  updated_at   timestamptz not null default now()
);

create unique index if not exists leave_bal_uniq
  on public.leave_balances (user_id, year, type_code);

comment on column public.leave_balances.used_hours is
  '已用時數。**由觸發器維護,前端不要寫** —— 兩邊都能寫的話總有一天會不一致,'
  '而不一致的症狀是「明明還有假卻請不了」,使用者查不出原因。';

/** 剩餘時數。無額度上限的假別（事假）回 null,代表「不限」。 */
create or replace function public.leave_remaining_hours(b public.leave_balances)
returns numeric language sql stable as $fn$
  select case when (select t.has_quota from public.leave_types t where t.code = b.type_code)
              then b.quota_hours - b.used_hours else null end
$fn$;


-- ============================================================
-- 4. 請假單
--
-- 兩票核可（主管 + 總經理），跟請款單同一套規則。
-- ============================================================

create table if not exists public.leave_requests (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.profiles(id) on delete cascade,
  type_code     text not null references public.leave_types(code),
  start_at      timestamptz not null,
  end_at        timestamptz not null,
  hours         numeric not null check (hours > 0),
  reason        text,
  status        text not null default 'pending'
                check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  manager_by    uuid references public.profiles(id),
  manager_at    timestamptz,
  admin_by      uuid references public.profiles(id),
  admin_at      timestamptz,
  reject_reason text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint leave_period_chk check (end_at > start_at)
);

create index if not exists leave_req_user_idx on public.leave_requests (user_id, start_at);
create index if not exists leave_req_pending_idx on public.leave_requests (status) where status = 'pending';
create index if not exists leave_req_range_idx on public.leave_requests (start_at, end_at);

/*
 * 同一個人的假不能在時間上重疊。
 *
 * 只擋 pending 與 approved —— 駁回與取消的不算數。
 * 不擋的話同一個下午可以同時請事假與病假,而餘額會各扣一次。
 *
 * 用 EXCLUDE 而不是觸發器：這是「兩列之間的關係」,
 * 觸發器要自己處理併發（兩張單同時送出都看不到對方），EXCLUDE 由索引保證。
 */
create extension if not exists btree_gist;

alter table public.leave_requests drop constraint if exists leave_no_overlap;
alter table public.leave_requests add constraint leave_no_overlap
  exclude using gist (
    user_id with =,
    tstzrange(start_at, end_at) with &&
  ) where (status in ('pending', 'approved'));


-- ============================================================
-- 5. 兩票到齊就核可，核可才扣時數
-- ============================================================

create or replace function public.leave_apply_status() returns trigger
language plpgsql security definer set search_path = public as $fn$
begin
  -- 兩票都有 → approved
  if new.status = 'pending' and new.manager_at is not null and new.admin_at is not null then
    new.status := 'approved';
  end if;
  -- 駁回時清票,重送才不會帶著舊的票直接過關
  if new.status = 'rejected' then
    new.manager_by := null; new.manager_at := null;
    new.admin_by := null;   new.admin_at := null;
  end if;
  new.updated_at := now();
  return new;
end $fn$;

drop trigger if exists trg_leave_status on public.leave_requests;
create trigger trg_leave_status
  before insert or update on public.leave_requests
  for each row execute function public.leave_apply_status();

/*
 * 重算某人某年某假別的已用時數。
 *
 * **整個重算而不是加減。** 加減會在「核可後改時數」「取消再恢復」
 * 這些路徑上慢慢累積誤差，而誤差不會報錯，只會讓餘額愈來愈不準。
 * 重算的成本是掃該人該年的假單 —— 一年幾十筆，可以忽略。
 */
create or replace function public.recalc_leave_used(
  p_user uuid, p_year int, p_type text
) returns void language plpgsql security definer set search_path = public as $fn$
begin
  insert into public.leave_balances (user_id, year, type_code, quota_hours)
  values (p_user, p_year, p_type, 0)
  on conflict (user_id, year, type_code) do nothing;

  update public.leave_balances b
     set used_hours = coalesce((
           select sum(r.hours) from public.leave_requests r
            where r.user_id = p_user and r.type_code = p_type
              and r.status = 'approved'
              and extract(year from (r.start_at at time zone 'Asia/Taipei')) = p_year), 0),
         updated_at = now()
   where b.user_id = p_user and b.year = p_year and b.type_code = p_type;
end $fn$;

create or replace function public.sync_leave_used() returns trigger
language plpgsql security definer set search_path = public as $fn$
declare r public.leave_requests;
begin
  r := coalesce(new, old);
  perform public.recalc_leave_used(
    r.user_id,
    extract(year from (r.start_at at time zone 'Asia/Taipei'))::int,
    r.type_code);
  -- 改過假別或跨年改期間的話,舊的那一組也要重算
  if tg_op = 'UPDATE' and (old.type_code <> new.type_code or old.start_at <> new.start_at) then
    perform public.recalc_leave_used(
      old.user_id,
      extract(year from (old.start_at at time zone 'Asia/Taipei'))::int,
      old.type_code);
  end if;
  return null;
end $fn$;

drop trigger if exists trg_leave_used on public.leave_requests;
create trigger trg_leave_used
  after insert or update or delete on public.leave_requests
  for each row execute function public.sync_leave_used();


-- ============================================================
-- 6. 請假（唯一入口，失敗一定講得出原因）
--
-- 跟 punch() 同一套設計：回傳 { ok, code, message }，
-- message 是可以直接顯示的中文。
-- ============================================================

create or replace function public.request_leave(
  p_type text, p_start timestamptz, p_end timestamptz, p_reason text default null
) returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare
  uid     uuid := auth.uid();
  yr      int;
  hrs     numeric;
  lt      public.leave_types;
  bal     public.leave_balances;
  remain  numeric;
  n_over  int;
  new_id  uuid;
begin
  if uid is null then
    return jsonb_build_object('ok', false, 'code', 'NO_AUTH', 'message', '請重新登入');
  end if;

  select * into lt from public.leave_types where code = p_type and active;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'BAD_TYPE', 'message', '假別不存在或已停用');
  end if;

  if p_end <= p_start then
    return jsonb_build_object('ok', false, 'code', 'BAD_RANGE',
      'message', '結束時間要晚於開始時間。');
  end if;

  hrs := round(extract(epoch from (p_end - p_start)) / 3600.0, 2);
  yr  := extract(year from (p_start at time zone 'Asia/Taipei'))::int;

  -- 時間重疊（EXCLUDE 也會擋,但先講清楚是跟哪一張撞到）
  select count(*) into n_over from public.leave_requests r
   where r.user_id = uid and r.status in ('pending', 'approved')
     and tstzrange(r.start_at, r.end_at) && tstzrange(p_start, p_end);
  if n_over > 0 then
    return jsonb_build_object('ok', false, 'code', 'OVERLAP',
      'message', '這段時間你已經有一張請假單（送審中或已核可）。'
              || E'\n請先到「我的假單」取消原本那張，或改成不重疊的時段。');
  end if;

  -- 額度
  if lt.has_quota then
    select * into bal from public.leave_balances
     where user_id = uid and year = yr and type_code = p_type;
    remain := coalesce(bal.quota_hours, 0) - coalesce(bal.used_hours, 0);
    if bal.id is null or coalesce(bal.quota_hours, 0) <= 0 then
      return jsonb_build_object('ok', false, 'code', 'NO_QUOTA',
        'message', format('%s 今年還沒有配額。請主管到「打卡 → 假別額度」設定，'
                       || '或確認你的到職日是否已經填寫。', lt.name));
    end if;
    if hrs > remain then
      return jsonb_build_object('ok', false, 'code', 'NOT_ENOUGH',
        'message', format('%s 不夠。這次要請 %s 小時，但只剩 %s 小時'
                       || E'（今年額度 %s、已用 %s）。\n\n可以改請事假，或縮短時段。',
                       lt.name, hrs, remain, bal.quota_hours, bal.used_hours),
        'need', hrs, 'remain', remain);
    end if;
  end if;

  insert into public.leave_requests (user_id, type_code, start_at, end_at, hours, reason)
  values (uid, p_type, p_start, p_end, hrs, p_reason)
  returning id into new_id;

  return jsonb_build_object('ok', true, 'code', 'OK', 'id', new_id, 'hours', hrs,
    'message', format('已送出 %s %s 小時，等待主管與總經理核可。', lt.name, hrs));
exception
  when exclusion_violation then
    return jsonb_build_object('ok', false, 'code', 'OVERLAP',
      'message', '這段時間你已經有一張請假單。請先取消原本那張，或改成不重疊的時段。');
  when others then
    return jsonb_build_object('ok', false, 'code', 'ERROR', 'message', '送出失敗：' || sqlerrm);
end $fn$;


-- ============================================================
-- 7. RLS
-- ============================================================

alter table public.leave_requests enable row level security;
drop policy if exists lr_read on public.leave_requests;
create policy lr_read on public.leave_requests for select
  using (user_id = auth.uid()
         or current_role_of() = any (array['manager', 'super_admin', 'accountant']));
drop policy if exists lr_self on public.leave_requests;
create policy lr_self on public.leave_requests for insert with check (user_id = auth.uid());
drop policy if exists lr_self_upd on public.leave_requests;
create policy lr_self_upd on public.leave_requests for update
  using (user_id = auth.uid() and status = 'pending')
  with check (user_id = auth.uid());
drop policy if exists lr_review on public.leave_requests;
create policy lr_review on public.leave_requests for all
  using (current_role_of() = any (array['manager', 'super_admin']))
  with check (current_role_of() = any (array['manager', 'super_admin']));

alter table public.leave_balances enable row level security;
drop policy if exists lb_read on public.leave_balances;
create policy lb_read on public.leave_balances for select
  using (user_id = auth.uid()
         or current_role_of() = any (array['manager', 'super_admin', 'accountant']));
drop policy if exists lb_write on public.leave_balances;
create policy lb_write on public.leave_balances for all
  using (current_role_of() = any (array['manager', 'super_admin']))
  with check (current_role_of() = any (array['manager', 'super_admin']));

alter table public.leave_types enable row level security;
drop policy if exists lt_read on public.leave_types;
create policy lt_read on public.leave_types for select using (current_role_of() is not null);
drop policy if exists lt_write on public.leave_types;
create policy lt_write on public.leave_types for all
  using (current_role_of() = 'super_admin') with check (current_role_of() = 'super_admin');

alter table public.leave_seniority enable row level security;
drop policy if exists ls_read on public.leave_seniority;
create policy ls_read on public.leave_seniority for select using (current_role_of() is not null);
drop policy if exists ls_write on public.leave_seniority;
create policy ls_write on public.leave_seniority for all
  using (current_role_of() = 'super_admin') with check (current_role_of() = 'super_admin');


notify pgrst, 'reload schema';


-- ============================================================
-- 驗證
--
-- 包在 exception 裡：驗證失敗只發警告，不要把上面的變更整包回滾掉。
-- ============================================================

do $$
declare n int; d numeric; t text;
begin
  select count(*) into n from information_schema.tables
   where table_schema = 'public'
     and table_name in ('leave_types', 'leave_seniority', 'leave_balances', 'leave_requests');
  if n = 4 then raise notice '✅ 四張請假相關的表都建立了';
  else raise warning '❌ 只建立了 % 張', n; end if;

  -- 特休年資：第一年多三天
  if public.annual_leave_days(6) = 6 and public.annual_leave_days(12) = 10
     and public.annual_leave_days(24) = 10 and public.annual_leave_days(36) = 14 then
    raise notice '✅ 特休年資表正確（滿6月 6 天、滿1年 10 天、滿2年 10 天、滿3年 14 天）';
  else
    raise warning '❌ 特休天數不對：6月=% 12月=% 24月=% 36月=%',
      public.annual_leave_days(6), public.annual_leave_days(12),
      public.annual_leave_days(24), public.annual_leave_days(36);
  end if;

  -- 未滿半年沒有特休
  if public.annual_leave_days(5) = 0 then raise notice '✅ 未滿 6 個月沒有特休';
  else raise warning '❌ 未滿 6 個月不該有特休,卻是 %', public.annual_leave_days(5); end if;

  -- 滿 10 年之後每年 +1、上限 30
  if public.annual_leave_days(120) = 16 and public.annual_leave_days(132) = 17
     and public.annual_leave_days(600) = 30 then
    raise notice '✅ 滿 10 年後每年加 1 天,上限 30 天';
  else raise warning '❌ 滿 10 年後的遞增算錯：120月=% 132月=% 600月=%',
    public.annual_leave_days(120), public.annual_leave_days(132), public.annual_leave_days(600); end if;

  -- 時間重疊的 EXCLUDE 約束
  select count(*) into n from pg_constraint
   where conrelid = 'public.leave_requests'::regclass and conname = 'leave_no_overlap';
  if n = 1 then raise notice '✅ 同一人的假不能時間重疊（EXCLUDE 約束,併發安全）';
  else raise warning '❌ 沒有重疊約束,同一個下午可以同時請兩種假,餘額會各扣一次'; end if;

  -- request_leave 的失敗原因
  t := pg_get_functiondef('public.request_leave(text, timestamptz, timestamptz, text)'::regprocedure);
  if position('NOT_ENOUGH' in t) > 0 and position('OVERLAP' in t) > 0
     and position('NO_QUOTA' in t) > 0 and position('BAD_RANGE' in t) > 0 then
    raise notice '✅ 請不了假的四種原因都有中文說明';
  else raise warning '❌ 失敗原因不完整,使用者會不知道為什麼請不了假'; end if;

  select count(*) into n from public.leave_types where active;
  raise notice 'ℹ 假別 % 種：%', n,
    (select string_agg(name, '、' order by sort) from public.leave_types where active);

exception when others then
  raise warning '驗證區出錯（上面的變更不受影響）:%', sqlerrm;
end $$;


-- ── 特休年資對照（給人核對）─────────────────────────
select
  m.months                                as 年資月數,
  (m.months / 12) || ' 年 ' || (m.months % 12) || ' 個月' as 年資,
  public.annual_leave_days(m.months)      as 特休天數,
  public.annual_leave_days(m.months) * (select work_hours_per_day from public.work_settings where id = 1)
                                          as 換算小時
from (values (3), (6), (12), (18), (24), (36), (48), (60), (84), (120), (180), (300), (600)) m(months)
order by m.months;


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    raise notice '%', (select public.record_migration('99_leave'));
  else
    raise notice '尚未建立 schema_migrations（migration_70），這支沒有被記錄';
  end if;
end $$;
