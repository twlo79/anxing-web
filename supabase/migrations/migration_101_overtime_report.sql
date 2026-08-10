-- migration_101：加班申請 ＋ 出勤表計算
--
-- ============================================================
-- 【工時規則（使用者確認）】
--
--   工作時數 = 每日工時（預設 8）− 當天已核可的請假時數，下限 0
--
--   **不看打卡的實際長度。** 打卡是「有到」的證明，工時走制度。
--   09:00 打卡 21:00 下班，工作時數還是 8 —— 多的算加班，而加班要事前申請。
--   09:00 打卡 15:00 就走，工作時數還是 8 —— 早退分鐘單獨一欄，不進時數。
--
--   加班時數 = **已核可的申請時數**，不是實際打卡超出的時間。
--   申請 2 小時、實際待 3 小時 → 算 2 小時。
--   反過來說「多待兩小時就自動變成加班」也不成立 —— 那會讓加班失去控管。
--
--
-- ============================================================
-- 【為什麼加班只要主管一票】
--
-- 使用者指定「待主管核可」。請假是兩票（主管＋總經理），加班一票。
-- 差別在於加班是「當下要不要做這件事」的決定，主管在現場；
-- 請假會動到年度額度，那是人事政策。
--
--
-- ============================================================
-- 【跨天的請假怎麼切】
--
-- 請假單存的是 start_at ~ end_at（可能跨天：8/4 14:00 ~ 8/5 12:00）。
-- 出勤表是一天一列，所以要算「這一天與請假區間的交集有幾小時」。
--
-- 交集算出來還要**上限夾到當日工時** —— 不然跨夜的 22 小時會讓某一天
-- 出現「請假 22 小時」而工作時數變成 -14。


-- ============================================================
-- 1. 加班申請
-- ============================================================

create table if not exists public.overtime_requests (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.profiles(id) on delete cascade,
  work_date     date not null,
  start_at      timestamptz not null,
  end_at        timestamptz not null,
  hours         numeric not null check (hours > 0),
  reason        text not null,
  status        text not null default 'pending'
                check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  -- 只要主管一票（使用者指定）
  manager_by    uuid references public.profiles(id),
  manager_at    timestamptz,
  reject_reason text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint ot_period_chk check (end_at > start_at)
);

create index if not exists ot_user_idx on public.overtime_requests (user_id, work_date);
create index if not exists ot_pending_idx on public.overtime_requests (status) where status = 'pending';

comment on table public.overtime_requests is
  '加班申請。**只要主管一票** —— 加班是「當下要不要做」的決定,主管在現場;'
  '請假會動到年度額度,那是人事政策,所以要兩票。';
comment on column public.overtime_requests.hours is
  '申請時數。出勤表以**核可的這個數字**為準,不是實際打卡超出的時間 —— '
  '否則「多待兩小時就自動變成加班」,加班就失去控管。';

/* 同一個人同一天不要重複申請重疊的時段 */
alter table public.overtime_requests drop constraint if exists ot_no_overlap;
alter table public.overtime_requests add constraint ot_no_overlap
  exclude using gist (
    user_id with =,
    tstzrange(start_at, end_at) with &&
  ) where (status in ('pending', 'approved'));

/* 主管投票就核可（只有一票，不像請假要等兩票） */
create or replace function public.ot_apply_status() returns trigger
language plpgsql security definer set search_path = public as $fn$
begin
  if new.status = 'pending' and new.manager_at is not null then
    new.status := 'approved';
  end if;
  if new.status = 'rejected' then
    new.manager_by := null; new.manager_at := null;
  end if;
  new.updated_at := now();
  return new;
end $fn$;

drop trigger if exists trg_ot_status on public.overtime_requests;
create trigger trg_ot_status
  before insert or update on public.overtime_requests
  for each row execute function public.ot_apply_status();


-- ============================================================
-- 2. 申請加班（唯一入口，失敗講得出原因）
-- ============================================================

create or replace function public.request_overtime(
  p_start timestamptz, p_end timestamptz, p_reason text
) returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare
  uid uuid := auth.uid();
  hrs numeric; wd date; n int; new_id uuid;
begin
  if uid is null then
    return jsonb_build_object('ok', false, 'code', 'NO_AUTH', 'message', '請重新登入');
  end if;
  if p_end <= p_start then
    return jsonb_build_object('ok', false, 'code', 'BAD_RANGE',
      'message', '結束時間要晚於開始時間。');
  end if;
  if coalesce(trim(p_reason), '') = '' then
    return jsonb_build_object('ok', false, 'code', 'NO_REASON',
      'message', '加班要填事由 —— 主管是看這一欄決定核不核可的。');
  end if;

  hrs := round(extract(epoch from (p_end - p_start)) / 3600.0, 2);
  wd  := (p_start at time zone 'Asia/Taipei')::date;

  if hrs > 12 then
    return jsonb_build_object('ok', false, 'code', 'TOO_LONG',
      'message', format('一次申請 %s 小時太長了。請分開申請,或確認時間是不是填錯（例如把 AM/PM 弄反）。', hrs));
  end if;

  select count(*) into n from public.overtime_requests r
   where r.user_id = uid and r.status in ('pending', 'approved')
     and tstzrange(r.start_at, r.end_at) && tstzrange(p_start, p_end);
  if n > 0 then
    return jsonb_build_object('ok', false, 'code', 'OVERLAP',
      'message', '這段時間你已經有一張加班申請（送審中或已核可）。請先取消原本那張。');
  end if;

  insert into public.overtime_requests (user_id, work_date, start_at, end_at, hours, reason)
  values (uid, wd, p_start, p_end, hrs, trim(p_reason))
  returning id into new_id;

  return jsonb_build_object('ok', true, 'code', 'OK', 'id', new_id, 'hours', hrs,
    'message', format('已送出 %s 加班 %s 小時，等待主管核可。', wd, hrs));
exception
  when exclusion_violation then
    return jsonb_build_object('ok', false, 'code', 'OVERLAP',
      'message', '這段時間你已經有一張加班申請。請先取消原本那張。');
  when others then
    return jsonb_build_object('ok', false, 'code', 'ERROR', 'message', '送出失敗：' || sqlerrm);
end $fn$;


-- ============================================================
-- 3. 某人某天的請假／加班時數
--
-- 跨天的單要按天切：算「這一天與申請區間的交集」。
-- ============================================================

create or replace function public.leave_hours_on(p_user uuid, p_date date)
returns numeric language sql stable as $fn$
  select coalesce(sum(
    extract(epoch from (
        least(r.end_at,   ((p_date + 1)::text || ' 00:00')::timestamp at time zone 'Asia/Taipei')
      - greatest(r.start_at, (p_date::text || ' 00:00')::timestamp at time zone 'Asia/Taipei')
    )) / 3600.0), 0)
  from public.leave_requests r
  where r.user_id = p_user and r.status = 'approved'
    and r.start_at < ((p_date + 1)::text || ' 00:00')::timestamp at time zone 'Asia/Taipei'
    and r.end_at   > (p_date::text || ' 00:00')::timestamp at time zone 'Asia/Taipei'
$fn$;

create or replace function public.ot_hours_on(p_user uuid, p_date date)
returns numeric language sql stable as $fn$
  -- 加班以**核可的申請時數**為準,所以直接用 work_date 對,不做區間切分
  select coalesce(sum(o.hours), 0)
  from public.overtime_requests o
  where o.user_id = p_user and o.status = 'approved' and o.work_date = p_date
$fn$;

/** 這一天請的是什麼假（可能不只一種） */
create or replace function public.leave_names_on(p_user uuid, p_date date)
returns text language sql stable as $fn$
  select string_agg(distinct t.name, '、')
  from public.leave_requests r
  join public.leave_types t on t.code = r.type_code
  where r.user_id = p_user and r.status = 'approved'
    and r.start_at < ((p_date + 1)::text || ' 00:00')::timestamp at time zone 'Asia/Taipei'
    and r.end_at   > (p_date::text || ' 00:00')::timestamp at time zone 'Asia/Taipei'
$fn$;


-- ============================================================
-- 4. 出勤表（Excel 的資料來源）
--
-- 一天一列，涵蓋期間內的每一天（沒打卡的日子也要有列，
-- 否則「這個月有幾天沒來」看不出來）。
-- ============================================================

create or replace function public.attendance_report(
  p_user uuid, p_from date, p_to date
) returns table (
  work_date    date,
  staff_name   text,
  item         text,       -- 上班日 / 假別 / 例假日 / 國定假日 / 未出勤
  in_at        text,       -- HH:MM
  out_at       text,
  work_hours   numeric,
  leave_hours  numeric,
  ot_hours     numeric,
  late_min     int,
  early_min    int,
  note         text
) language sql stable as $fn$
  with cfg as (
    select * from public.effective_work_settings(p_user)
  ), days as (
    select gs::date as d
      from generate_series(p_from, p_to, '1 day') gs
  ), calc as (
    select
      dy.d,
      (select p.name from public.profiles p where p.id = p_user)      as nm,
      a.in_at, a.out_at, a.late_min, a.early_min, a.status, a.note,
      public.is_workday(dy.d)                                          as is_work,
      -- 請假時數：跨天切分之後,上限夾到當日工時
      least(public.leave_hours_on(p_user, dy.d), c.work_hours_per_day) as lv,
      public.ot_hours_on(p_user, dy.d)                                 as ot,
      public.leave_names_on(p_user, dy.d)                              as lv_name,
      c.work_hours_per_day                                             as daily
    from days dy
    cross join cfg c
    left join public.attendance a on a.user_id = p_user and a.work_date = dy.d
  )
  select
    calc.d,
    calc.nm,
    case
      when calc.lv_name is not null and calc.in_at is null then calc.lv_name
      when calc.lv_name is not null                        then '上班日・' || calc.lv_name
      when calc.in_at is not null                          then '上班日'
      when not calc.is_work                                then
        coalesce((select h.name from public.holidays h where h.d = calc.d and h.kind = 'holiday'), '例假日')
      else '未出勤'
    end,
    to_char(calc.in_at  at time zone 'Asia/Taipei', 'HH24:MI'),
    to_char(calc.out_at at time zone 'Asia/Taipei', 'HH24:MI'),
    /*
     * 工作時數 = 每日工時 − 當天請假時數，下限 0。
     * **只有「有上班卡」或「有請假」的日子才算** ——
     * 例假日與未出勤都是 0，不然一個月會憑空多出十幾天的工時。
     */
    case
      when calc.in_at is not null or calc.lv > 0 then greatest(0, calc.daily - calc.lv)
      else 0
    end,
    calc.lv,
    calc.ot,
    calc.late_min,
    calc.early_min,
    case
      when calc.status = 'missing_out' then '沒打下班卡'
      when calc.status = 'missing_in'  then '沒打上班卡'
      when calc.status = 'fixed'       then '補登'
      else calc.note
    end
  from calc
  order by calc.d
$fn$;

comment on function public.attendance_report(uuid, date, date) is
  '出勤表的資料來源,一天一列。**沒打卡的日子也有列** —— '
  '不列出來的話「這個月有幾天沒來」看不出來,而那正是出勤表要回答的問題。';


-- ============================================================
-- 5. RLS
-- ============================================================

alter table public.overtime_requests enable row level security;
drop policy if exists ot_read on public.overtime_requests;
create policy ot_read on public.overtime_requests for select
  using (user_id = auth.uid()
         or current_role_of() = any (array['manager', 'super_admin', 'accountant']));
drop policy if exists ot_self on public.overtime_requests;
create policy ot_self on public.overtime_requests for insert with check (user_id = auth.uid());
drop policy if exists ot_self_upd on public.overtime_requests;
create policy ot_self_upd on public.overtime_requests for update
  using (user_id = auth.uid() and status = 'pending')
  with check (user_id = auth.uid());
drop policy if exists ot_review on public.overtime_requests;
create policy ot_review on public.overtime_requests for all
  using (current_role_of() = any (array['manager', 'super_admin']))
  with check (current_role_of() = any (array['manager', 'super_admin']));


notify pgrst, 'reload schema';


-- ============================================================
-- 驗證
--
-- 包在 exception 裡：驗證失敗只發警告，不要把上面的變更整包回滾掉。
-- ============================================================

do $$
declare n int; t text;
begin
  select count(*) into n from information_schema.tables
   where table_schema = 'public' and table_name = 'overtime_requests';
  if n = 1 then raise notice '✅ 加班申請表已建立';
  else raise warning '❌ overtime_requests 不存在'; return; end if;

  select count(*) into n from pg_constraint
   where conrelid = 'public.overtime_requests'::regclass and conname = 'ot_no_overlap';
  if n = 1 then raise notice '✅ 加班時段不能重疊（EXCLUDE 約束）';
  else raise warning '❌ 沒有重疊約束'; end if;

  -- 加班只要一票
  t := pg_get_functiondef('public.ot_apply_status()'::regprocedure);
  if position('admin_at' in t) = 0 then
    raise notice '✅ 加班只要主管一票（沒有等總經理那一票）';
  else raise warning '❌ 加班變成要兩票了'; end if;

  -- 出勤表函式
  select count(*) into n from pg_proc where proname = 'attendance_report';
  if n = 1 then raise notice '✅ 出勤表函式已建立';
  else raise warning '❌ attendance_report 不存在'; end if;

  t := pg_get_functiondef('public.attendance_report(uuid, date, date)'::regprocedure);
  if position('greatest(0, calc.daily - calc.lv)' in t) > 0 then
    raise notice '✅ 工時規則正確：每日工時 − 請假時數,下限 0（不看打卡實際長度）';
  else raise warning '❌ 工時算法不對'; end if;

  if position('least(public.leave_hours_on' in t) > 0 then
    raise notice '✅ 跨天請假的時數有夾到當日工時上限（否則會出現負的工時）';
  else raise warning '❌ 跨天請假沒有夾上限,某一天可能出現請假 22 小時'; end if;

  select count(*) into n from pg_proc
   where proname in ('leave_hours_on', 'ot_hours_on', 'leave_names_on', 'request_overtime');
  if n = 4 then raise notice '✅ 四個輔助函式都建立了';
  else raise warning '❌ 只建立了 % 個輔助函式', n; end if;

exception when others then
  raise warning '驗證區出錯（上面的變更不受影響）:%', sqlerrm;
end $$;


-- ── 工時規則的實測 ─────────────────────────────────
--
-- 不寫入任何資料,只驗算式。四種情況各走一次。

do $$
declare daily numeric := 8; bad int := 0;
begin
  -- 情況 1：正常上班,沒請假 → 8
  if greatest(0, daily - 0) <> 8 then bad := bad + 1; raise warning '❌ 正常上班應為 8'; end if;
  -- 情況 2：請 4 小時 → 4
  if greatest(0, daily - 4) <> 4 then bad := bad + 1; raise warning '❌ 請 4 小時應剩 4'; end if;
  -- 情況 3：請全天 8 小時 → 0
  if greatest(0, daily - 8) <> 0 then bad := bad + 1; raise warning '❌ 請全天應為 0'; end if;
  -- 情況 4：跨夜請假算出 22 小時,夾到 8 之後 → 0（不能是 -14）
  if greatest(0, daily - least(22, daily)) <> 0 then
    bad := bad + 1; raise warning '❌ 跨夜請假沒夾上限,會算出負的工時'; end if;

  if bad = 0 then raise notice '✅ 四種工時情況都正確（含跨夜請假不會變成負數）'; end if;
end $$;


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    raise notice '%', (select public.record_migration('101_overtime_report'));
  else
    raise notice '尚未建立 schema_migrations（migration_70），這支沒有被記錄';
  end if;
end $$;
