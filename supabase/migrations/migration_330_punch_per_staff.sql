/*
 * migration_330_punch_per_staff.sql　2026-10-12
 * 打卡：每個人各自的可打卡地點（任一範圍內就成功）＋遠端打卡
 *
 * 【怎麼跑】整份貼進 Supabase SQL Editor，看最後那張自檢表。
 *          ★ 看不到自檢的表格＝整支回滾了。
 *
 * 【使用者 2026-10-12】
 *   「員工可在有選到的地點打卡就開始算上班，用 or 的概念，只要在有選定的任一範圍內打卡就成功」
 *   「加一個可遠端機制」→ A：直接算上班，紀錄標「遠端」
 *   「花：正隆、時兆　唐：正隆、時兆、台視、JPR」
 *
 * 【這一支做的事】
 *   ① staff_punch_estates：誰可以在哪幾個物業打卡（一人多筆）
 *      ★ 一筆都沒有的人 → 照舊，所有有座標的物業都能打（漏設定不會被擋在門外）
 *   ② profiles.allow_remote_punch：可以遠端打卡
 *   ③ attendance.in_remote / out_remote：這一下是遠端打的
 *   ④ punch()：照線上那一份改（2026-10-12 印出來的），只動「位置」那一段：
 *        · 只看這個人勾選的物業（沒勾就是全部）
 *        · 在任一個範圍內 → 成功，紀錄寫最近的那一個
 *        · 都不在範圍內：可遠端 → 成功、標遠端、照樣存位置與最近物業的距離；不可遠端 → 擋下（原本的訊息）
 *      時段、上下班規則、遲到早退、回傳格式都沒動。
 *   ⑤ 花、唐的地點照上面設好
 * ══════════════════════════════════════════════════════════
 */

begin;

-- ══════ ⓪ 閘門 ══════
do $do$
begin
  if to_regprocedure('public.punch(text,numeric,numeric)') is null then raise exception 'punch() 不在 —— 整支停下來'; end if;
  if to_regprocedure('public.gps_distance_m(numeric,numeric,numeric,numeric)') is null
     and not exists (select 1 from pg_proc where proname = 'gps_distance_m') then
    raise exception 'gps_distance_m() 不在 —— 整支停下來';
  end if;
end $do$;

-- ══════ ① 每人可打卡物業 ══════
create table if not exists public.staff_punch_estates (
  user_id   uuid not null references public.profiles(id) on delete cascade,
  estate_id uuid not null references public.estates(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, estate_id)
);
comment on table public.staff_punch_estates is
  '誰可以在哪幾個物業打卡（migration_330）。一筆都沒有的人＝所有有座標的物業都能打。';

alter table public.staff_punch_estates enable row level security;
drop policy if exists spe_read on public.staff_punch_estates;
create policy spe_read on public.staff_punch_estates for select
  using (user_id = auth.uid() or public.current_role_of() in ('manager', 'super_admin', 'accountant'));
drop policy if exists spe_write on public.staff_punch_estates;
create policy spe_write on public.staff_punch_estates for all
  using (public.current_role_of() in ('manager', 'super_admin'))
  with check (public.current_role_of() in ('manager', 'super_admin'));
grant select, insert, update, delete on public.staff_punch_estates to authenticated;

-- ══════ ② 可遠端打卡 ══════
alter table public.profiles add column if not exists allow_remote_punch boolean not null default false;
comment on column public.profiles.allow_remote_punch is
  '可以遠端打卡（migration_330）：不在任何可打卡範圍內也算上班，紀錄標遠端。';

/*
 * ★ 改 profiles 走函式，不直接 update —— profiles 開放 update 的話主管能改自己的 role
 *   （跟 set_work_time 同一個理由）。這支只寫 allow_remote_punch 一欄。
 */
create or replace function public.set_remote_punch(p_user uuid, p_on boolean)
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare k int;
begin
  if coalesce(public.current_role_of(), '') not in ('manager', 'super_admin') then
    return jsonb_build_object('ok', false, 'message', '只有主管、總經理可以設定遠端打卡');
  end if;
  update public.profiles set allow_remote_punch = coalesce(p_on, false) where id = p_user;
  get diagnostics k = row_count;
  if k <> 1 then return jsonb_build_object('ok', false, 'message', '找不到這個人'); end if;
  return jsonb_build_object('ok', true, 'message', case when p_on then '已開啟遠端打卡' else '已關閉遠端打卡' end);
end $fn$;
revoke all on function public.set_remote_punch(uuid, boolean) from public, anon;
grant execute on function public.set_remote_punch(uuid, boolean) to authenticated;

-- ══════ ③ 打卡紀錄標遠端 ══════
alter table public.attendance add column if not exists in_remote  boolean not null default false;
alter table public.attendance add column if not exists out_remote boolean not null default false;

-- ══════ ④ punch() ══════
CREATE OR REPLACE FUNCTION public.punch(p_kind text, p_lat numeric DEFAULT NULL::numeric, p_lng numeric DEFAULT NULL::numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  uid      uuid := auth.uid();
  today    date := (now() at time zone 'Asia/Taipei')::date;
  now_ts   timestamptz := now();
  now_t    time := (now() at time zone 'Asia/Taipei')::time;
  ws       record;          -- ★1 改成 record,裝 effective_work_settings 的結果
  win_from time; win_to time;
  mins     int;
  rec      public.attendance;
  best     record;
  in_range boolean := false;
  n_est    int;
  v_limit  boolean;         -- migration_330：這個人有沒有指定可打卡物業
  v_remote boolean;         -- migration_330：可以遠端打卡
  is_remote boolean := false;
begin
  if uid is null then
    return jsonb_build_object('ok', false, 'code', 'NO_AUTH', 'message', '請重新登入');
  end if;
  if p_kind not in ('in', 'out') then
    return jsonb_build_object('ok', false, 'code', 'BAD_KIND', 'message', '打卡類型只能是上班或下班');
  end if;

  -- ★1 這個人適用的上班時間（沒設就是公司預設）
  select * into ws from public.effective_work_settings(uid);

  -- ★2 可打卡時段。超出範圍擋下來,並指向補登申請。
  win_from := ws.work_start - make_interval(mins => ws.punch_before_min);
  win_to   := ws.work_end   + make_interval(mins => ws.punch_after_min);
  if now_t < win_from or now_t > win_to then
    return jsonb_build_object('ok', false, 'code', 'OUT_OF_WINDOW',
      'message', format('現在 %s 不在可打卡時段內（%s～%s）。'
                     || E'\n\n你的上班時間是 %s～%s，可以提早 %s 分鐘、延後 %s 分鐘打卡。'
                     || E'\n如果確實在這個時間工作，請用「補登申請」並寫明原因。',
        left(now_t::text, 5), left(win_from::text, 5), left(win_to::text, 5),
        left(ws.work_start::text, 5), left(ws.work_end::text, 5),
        ws.punch_before_min, ws.punch_after_min),
      'now', left(now_t::text, 5),
      'window_from', left(win_from::text, 5), 'window_to', left(win_to::text, 5));
  end if;

  -- ── 位置（migration_330：只看這個人勾選的物業；任一範圍內就成功；可遠端的人範圍外也算）──
  v_limit  := exists (select 1 from public.staff_punch_estates where user_id = uid);
  v_remote := coalesce((select allow_remote_punch from public.profiles where id = uid), false);

  select count(*) into n_est from public.estates e
   where e.active and e.gps_lat is not null and e.gps_lng is not null
     and (not v_limit or exists (select 1 from public.staff_punch_estates s where s.user_id = uid and s.estate_id = e.id));
  if n_est = 0 and not v_remote then
    return jsonb_build_object('ok', false, 'code', 'NO_ESTATE_CONFIGURED',
      'message', case when v_limit
        then '你可以打卡的物業都還沒設定打卡位置。請主管到「出勤 → 管理 → 打卡位置」設定座標後再打卡。'
        else '還沒有任何物業設定打卡位置。請主管到「出勤 → 管理 → 打卡位置」設定座標後再打卡。' end);
  end if;

  if p_lat is null or p_lng is null then
    return jsonb_build_object('ok', false, 'code', 'NO_GPS',
      'message', '拿不到你的位置。請確認瀏覽器的定位權限是「允許」，'
              || '而且不是用無痕視窗開啟。iPhone 要到「設定 → Safari → 位置」開啟。');
  end if;

  /*
   * ★ 任一範圍內就成功：先找「範圍內」最近的那一個；一個都沒有才看最近的（給錯誤訊息／遠端紀錄用）。
   *   只找最近的一個會出錯 —— A 物業比較近但半徑小、B 比較遠但半徑大而且在範圍內，應該算成功。
   */
  select e.id, e.name, e.gps_radius_m,
         public.gps_distance_m(p_lat, p_lng, e.gps_lat, e.gps_lng) as dist
    into best
    from public.estates e
   where e.active and e.gps_lat is not null and e.gps_lng is not null
     and (not v_limit or exists (select 1 from public.staff_punch_estates s where s.user_id = uid and s.estate_id = e.id))
     and public.gps_distance_m(p_lat, p_lng, e.gps_lat, e.gps_lng) <= e.gps_radius_m
   order by 4 limit 1;

  in_range := best.id is not null;

  if not in_range then
    select e.id, e.name, e.gps_radius_m,
           public.gps_distance_m(p_lat, p_lng, e.gps_lat, e.gps_lng) as dist
      into best
      from public.estates e
     where e.active and e.gps_lat is not null and e.gps_lng is not null
       and (not v_limit or exists (select 1 from public.staff_punch_estates s where s.user_id = uid and s.estate_id = e.id))
     order by 4 limit 1;

    if v_remote then
      is_remote := true;          -- 範圍外但可遠端：照樣打，標遠端
    else
      return jsonb_build_object('ok', false, 'code', 'OUT_OF_RANGE',
        'message', format('你不在可打卡的範圍內。最近的是「%s」，距離約 %s 公尺（允許範圍 %s 公尺）。'
                       || E'\n\n如果你確實在現場，可能是室內收不到 GPS —— 走到窗邊或戶外再試一次，'
                       || '或請主管補登。',
                       best.name, round(best.dist), best.gps_radius_m),
        'estate', best.name, 'distance_m', round(best.dist), 'radius_m', best.gps_radius_m);
    end if;
  end if;

  select * into rec from public.attendance where user_id = uid and work_date = today;

  if p_kind = 'in' then
    if rec.id is not null and rec.in_at is not null then
      return jsonb_build_object('ok', false, 'code', 'ALREADY_IN',
        'message', format('今天已經打過上班卡了（%s）。一天只能打一次。',
          to_char(rec.in_at at time zone 'Asia/Taipei', 'HH24:MI')),
        'at', to_char(rec.in_at at time zone 'Asia/Taipei', 'HH24:MI'));
    end if;
    -- ★3 用這個人自己的上班時間算遲到
    mins := greatest(0, extract(epoch from (now_t - ws.work_start))::int / 60);

    insert into public.attendance (user_id, work_date, in_at, in_lat, in_lng,
                                   in_estate_id, in_distance_m, in_in_range, in_remote, status, late_min)
    values (uid, today, now_ts, p_lat, p_lng, best.id, round(best.dist), in_range, is_remote, 'missing_out', mins)
    on conflict (user_id, work_date) do update
      set in_at = excluded.in_at, in_lat = excluded.in_lat, in_lng = excluded.in_lng,
          in_estate_id = excluded.in_estate_id, in_distance_m = excluded.in_distance_m,
          in_in_range = excluded.in_in_range, in_remote = excluded.in_remote,
          late_min = excluded.late_min, updated_at = now()
    returning * into rec;

  else  -- out
    if rec.id is null or rec.in_at is null then
      /*
       * 【migration_98 的核心規則,原封不動】
       * 還沒打上班就要打下班 —— 擋下來。
       */
      return jsonb_build_object('ok', false, 'code', 'NO_IN_YET',
        'message', '今天還沒有上班卡，不能打下班。'
                || E'\n\n如果你是昨天忘了打下班，請用「補登申請」補昨天那一筆 ——'
                || '今天的打卡不會補到昨天去，那樣兩天的工時都會錯。');
    end if;
    if rec.out_at is not null then
      return jsonb_build_object('ok', false, 'code', 'ALREADY_OUT',
        'message', format('今天已經打過下班卡了（%s）。要修改請用補登申請。',
          to_char(rec.out_at at time zone 'Asia/Taipei', 'HH24:MI')),
        'at', to_char(rec.out_at at time zone 'Asia/Taipei', 'HH24:MI'));
    end if;
    -- ★3 用這個人自己的下班時間算早退
    mins := greatest(0, extract(epoch from (ws.work_end - now_t))::int / 60);

    update public.attendance
       set out_at = now_ts, out_lat = p_lat, out_lng = p_lng,
           out_estate_id = best.id, out_distance_m = round(best.dist),
           out_in_range = in_range, out_remote = is_remote,
           early_min = mins,
           status = case when status = 'fixed' then 'fixed' else 'normal' end,
           updated_at = now()
     where id = rec.id
    returning * into rec;
  end if;

  return jsonb_build_object(
    'ok', true, 'code', 'OK',
    'message', format('%s 打卡成功 · %s · %s%s',
      case when p_kind = 'in' then '上班' else '下班' end,
      to_char(now_ts at time zone 'Asia/Taipei', 'HH24:MI'),
      case when is_remote
           then '遠端' || coalesce(format('（離「%s」約 %s 公尺）', best.name, round(best.dist)), '')
           else best.name end,
      case
        when p_kind = 'in'  and coalesce(rec.late_min, 0)  > 0
          then format(E'\n（比上班時間 %s 晚了 %s 分鐘）', left(ws.work_start::text, 5), rec.late_min)
        when p_kind = 'out' and coalesce(rec.early_min, 0) > 0
          then format(E'\n（比下班時間 %s 早了 %s 分鐘）', left(ws.work_end::text, 5), rec.early_min)
        else '' end),
    'late_min', coalesce(rec.late_min, 0),
    'early_min', coalesce(rec.early_min, 0),
    'kind', p_kind, 'estate', case when is_remote then '遠端' else best.name end,
    'remote', is_remote,
    'at', to_char(now_ts at time zone 'Asia/Taipei', 'HH24:MI'),
    'distance_m', round(best.dist),
    'is_holiday', not public.is_workday(today),
    'hours', public.attendance_hours(rec));
end $function$;

-- ══════ ⑤ 花、唐的地點（2026-10-12 David 指定）══════
insert into public.staff_punch_estates (user_id, estate_id)
select p.id, e.id
  from public.profiles p
  join public.estates e on (p.name = '花' and e.name in ('正隆', '時兆'))
                        or (p.name = '唐' and e.name in ('正隆', '時兆', '台視', 'JPR'))
 where p.role = 'housekeeper'
on conflict do nothing;

do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('330_punch_per_staff');
  end if;
end $do$;

commit;

-- ══════ 自檢（看不到這張表就是整支回滾了）══════
select p.name as 員工,
       coalesce((select string_agg(e.name || case when e.gps_lat is null then '（還沒座標）' else '' end, '、' order by e.sort)
                   from public.staff_punch_estates s join public.estates e on e.id = s.estate_id
                  where s.user_id = p.id), '（沒指定 → 有座標的物業都能打）') as 可打卡物業,
       case when p.allow_remote_punch then '可以' else '不行' end as 遠端打卡
  from public.profiles p
 where p.role = 'housekeeper' and p.name in ('花', '唐')
union all
select '★ punch() 已更新', case when position('staff_punch_estates' in pg_get_functiondef('public.punch(text,numeric,numeric)'::regprocedure)) > 0
                               then '✅' else '❌' end, ''
order by 1;
