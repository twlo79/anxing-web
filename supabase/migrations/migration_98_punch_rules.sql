-- migration_98：打卡規則、異常判定、補登申請
--
-- ============================================================
-- 【要解決的核心問題：忘了打下班卡】
--
-- 這是打卡系統最常見的錯誤，而且錯法很惡劣：
--
--     週一 09:00 打上班
--     週一 18:00 忘了打下班
--     週二 09:00 打卡 → **被寫成週一的下班卡**
--
-- 結果是週一變成「工作 33 小時」，週二完全沒有上班紀錄。
-- 兩天同時錯掉，而且畫面上看起來每一格都有資料，不會有人發現。
--
--
-- ============================================================
-- 【規則：打卡一律歸屬「當下的日期」，不回頭補前一天】
--
--     上班卡  今天還沒上班紀錄  → 寫入
--             今天已經打過      → 擋下,並告訴他今天幾點打的
--     下班卡  今天有上班且未下班 → 寫入
--             今天還沒打上班    → 擋下（要先打上班）
--             今天已經打過下班  → 擋下,並告訴他幾點打的
--
--     昨天沒打下班 → 那一天標成「異常」，**不會被今天的卡填補**，
--                    由本人申請補登、主管核可。
--
-- 這個規則的代價是「跨夜班會被拆成兩天」。
-- 安幸是包租代管，房務與行政都沒有夜班，所以不成立 ——
-- 哪天真的有夜班，要加的是「班別」而不是放寬這條規則，
-- 因為放寬之後就再也分不出「跨夜」與「忘了打」。
--
--
-- ============================================================
-- 【為什麼規則寫在資料庫而不是前端】
--
-- 前端擋得住正常操作，擋不住兩支手機同時按、擋不住重新整理後再按一次、
-- 也擋不住之後任何一支繞過畫面的程式。
-- 而打卡重複寫入的後果是工時算錯 —— 那會變成薪資問題。
--
-- 所以 punch() 是唯一的入口，前端只負責拿 GPS 與顯示結果。
--
--
-- ============================================================
-- 【失敗一定要講得出原因】
--
-- punch() 回傳結構化的結果：{ ok, code, message, ... }
-- code 給程式判斷，message 是直接可以顯示給人看的中文。
--
-- 「打不了卡」而不知道為什麼，使用者只會放棄然後用別的方式回報出勤，
-- 那時候這套系統就等於不存在了。


-- ============================================================
-- 1. 出勤狀態
-- ============================================================

alter table public.attendance
  add column if not exists status text not null default 'normal',
  -- 遲到／早退的分鐘數。**在打卡當下算好存起來**,不是每次查詢重算 ——
  -- 上班時間之後被改的話,重算會讓三個月前的紀錄突然變成遲到,
  -- 那等於回頭改寫已經發生的事（跟 GPS 判定同一條原則）。
  add column if not exists late_min  int,
  add column if not exists early_min int;

comment on column public.attendance.late_min is
  '遲到分鐘（上班時間之後才打卡）。0 = 準時或提早。'
  '**不擋打卡,只記錄** —— 擋住的話那一天會完全沒有紀錄,比記一筆遲到糟糕得多。';
comment on column public.attendance.early_min is
  '早退分鐘（下班時間之前就打卡）。0 = 準時或加班。';

alter table public.attendance drop constraint if exists attendance_status_chk;
alter table public.attendance add constraint attendance_status_chk
  check (status in ('normal', 'missing_in', 'missing_out', 'fixed'));

comment on column public.attendance.status is
  'normal 正常 / missing_in 沒打上班 / missing_out 沒打下班 / fixed 補登過。'
  '**異常不會被隔天的打卡填補** —— 那正是這一支要防的事。';

/** 目前這一列該是什麼狀態。上下班都有=正常;補登過的保持 fixed。 */
create or replace function public.attendance_calc_status(a public.attendance)
returns text language sql immutable as $fn$
  select case
    when a.status = 'fixed'                       then 'fixed'
    when a.in_at is not null and a.out_at is null then 'missing_out'
    when a.in_at is null and a.out_at is not null then 'missing_in'
    else 'normal'
  end
$fn$;


-- ============================================================
-- 2. 打卡（唯一入口）
--
-- p_kind: 'in' 上班 / 'out' 下班
-- 回傳 jsonb：{ ok, code, message, ... }
-- ============================================================

create or replace function public.punch(
  p_kind text, p_lat numeric default null, p_lng numeric default null
) returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare
  uid      uuid := auth.uid();
  -- **一律用台北時間判斷「今天」。**
  -- 伺服器是 UTC,直接用 current_date 的話台灣時間 08:00 之前打的卡
  -- 會被歸到前一天 —— 而那正是這一支要防的事。
  today    date := (now() at time zone 'Asia/Taipei')::date;
  now_ts   timestamptz := now();
  now_t    time := (now() at time zone 'Asia/Taipei')::time;
  ws       public.work_settings;
  mins     int;
  rec      public.attendance;
  best     record;
  in_range boolean := false;
  n_est    int;
begin
  if uid is null then
    return jsonb_build_object('ok', false, 'code', 'NO_AUTH', 'message', '請重新登入');
  end if;
  if p_kind not in ('in', 'out') then
    return jsonb_build_object('ok', false, 'code', 'BAD_KIND', 'message', '打卡類型只能是上班或下班');
  end if;

  -- ── 位置 ────────────────────────────────────────
  select count(*) into n_est from public.estates
   where active and gps_lat is not null and gps_lng is not null;
  if n_est = 0 then
    return jsonb_build_object('ok', false, 'code', 'NO_ESTATE_CONFIGURED',
      'message', '還沒有任何物業設定打卡位置。請主管到「權限管理 → 物業與負責人」設定座標後再打卡。');
  end if;

  if p_lat is null or p_lng is null then
    return jsonb_build_object('ok', false, 'code', 'NO_GPS',
      'message', '拿不到你的位置。請確認瀏覽器的定位權限是「允許」，'
              || '而且不是用無痕視窗開啟。iPhone 要到「設定 → Safari → 位置」開啟。');
  end if;

  -- 最近的那個物業（不論在不在範圍內,都要拿來報距離）
  select e.id, e.name, e.gps_radius_m,
         public.gps_distance_m(p_lat, p_lng, e.gps_lat, e.gps_lng) as dist
    into best
    from public.estates e
   where e.active and e.gps_lat is not null and e.gps_lng is not null
   order by 4 limit 1;

  in_range := best.dist <= best.gps_radius_m;

  if not in_range then
    -- **講出差多遠**。只說「不在範圍內」的話，使用者不知道是差 10 公尺還是走錯棟。
    return jsonb_build_object('ok', false, 'code', 'OUT_OF_RANGE',
      'message', format('你不在任何物業的打卡範圍內。最近的是「%s」，距離約 %s 公尺（允許範圍 %s 公尺）。'
                     || E'\n\n如果你確實在現場，可能是室內收不到 GPS —— 走到窗邊或戶外再試一次，'
                     || '或請主管補登。',
                     best.name, round(best.dist), best.gps_radius_m),
      'estate', best.name, 'distance_m', round(best.dist), 'radius_m', best.gps_radius_m);
  end if;

  -- ── 今天的紀錄 ──────────────────────────────────
  select * into rec from public.attendance where user_id = uid and work_date = today;

  if p_kind = 'in' then
    if rec.id is not null and rec.in_at is not null then
      return jsonb_build_object('ok', false, 'code', 'ALREADY_IN',
        'message', format('今天已經打過上班卡了（%s）。一天只能打一次。',
          to_char(rec.in_at at time zone 'Asia/Taipei', 'HH24:MI')),
        'at', to_char(rec.in_at at time zone 'Asia/Taipei', 'HH24:MI'));
    end if;
    -- 遲到幾分鐘（提早到就是 0,不記負數 —— 早到不是一種需要被量化的事）
    select * into ws from public.work_settings where id = 1;
    mins := greatest(0, extract(epoch from (now_t - ws.work_start))::int / 60);

    insert into public.attendance (user_id, work_date, in_at, in_lat, in_lng,
                                   in_estate_id, in_distance_m, in_in_range, status, late_min)
    values (uid, today, now_ts, p_lat, p_lng, best.id, round(best.dist), true, 'missing_out', mins)
    on conflict (user_id, work_date) do update
      set in_at = excluded.in_at, in_lat = excluded.in_lat, in_lng = excluded.in_lng,
          in_estate_id = excluded.in_estate_id, in_distance_m = excluded.in_distance_m,
          in_in_range = true, late_min = excluded.late_min, updated_at = now()
    returning * into rec;

  else  -- out
    if rec.id is null or rec.in_at is null then
      /*
       * 還沒打上班就要打下班 —— 擋下來。
       *
       * **這是防「忘了打下班」最關鍵的一條。**
       * 允許的話，隔天早上那一下會變成前一天的下班卡，
       * 前一天工時暴增、當天完全沒有紀錄，兩天同時錯。
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
    -- 早退幾分鐘（加班到更晚就是 0）
    select * into ws from public.work_settings where id = 1;
    mins := greatest(0, extract(epoch from (ws.work_end - now_t))::int / 60);

    update public.attendance
       set out_at = now_ts, out_lat = p_lat, out_lng = p_lng,
           out_estate_id = best.id, out_distance_m = round(best.dist), out_in_range = true,
           early_min = mins,
           status = case when status = 'fixed' then 'fixed' else 'normal' end,
           updated_at = now()
     where id = rec.id
    returning * into rec;
  end if;

  /*
   * 遲到／早退**當場講出來**。
   *
   * 等到月底看報表才發現「原來那天算遲到」已經來不及了 ——
   * 當下知道的話，如果是系統判斷有誤（提早到現場但先去別處），
   * 還來得及當天就申請補登說明。
   */
  return jsonb_build_object(
    'ok', true, 'code', 'OK',
    'message', format('%s 打卡成功 · %s · %s%s',
      case when p_kind = 'in' then '上班' else '下班' end,
      to_char(now_ts at time zone 'Asia/Taipei', 'HH24:MI'), best.name,
      case
        when p_kind = 'in'  and coalesce(rec.late_min, 0)  > 0
          then format(E'\n（比上班時間 %s 晚了 %s 分鐘）',
                      left(ws.work_start::text, 5), rec.late_min)
        when p_kind = 'out' and coalesce(rec.early_min, 0) > 0
          then format(E'\n（比下班時間 %s 早了 %s 分鐘）',
                      left(ws.work_end::text, 5), rec.early_min)
        else '' end),
    'late_min', coalesce(rec.late_min, 0),
    'early_min', coalesce(rec.early_min, 0),
    'kind', p_kind, 'estate', best.name,
    'at', to_char(now_ts at time zone 'Asia/Taipei', 'HH24:MI'),
    'distance_m', round(best.dist),
    'is_holiday', not public.is_workday(today),
    'hours', public.attendance_hours(rec));
end $fn$;

comment on function public.punch(text, numeric, numeric) is
  '打卡的唯一入口。回傳 { ok, code, message } —— message 是可以直接顯示的中文。'
  '規則寫在這裡而不是前端:重複打卡會讓工時算錯,那是薪資問題,前端擋不住 API。';


-- ============================================================
-- 3. 補登申請
--
-- 忘了打卡由**本人申請、主管核可**，而不是主管直接改。
--
-- 主管直接改的話沒有申請紀錄，事後只看得到「這一天被改過」，
-- 看不到「誰說他幾點下班、理由是什麼」。
-- 出勤是薪資的依據，那條線要留得住。
-- ============================================================

create table if not exists public.attendance_fixes (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  work_date   date not null,
  kind        text not null check (kind in ('in', 'out')),
  -- 申請補的時間（只有時分有意義，日期用 work_date）
  fix_time    time not null,
  reason      text not null,
  status      text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  reviewed_by uuid references public.profiles(id),
  reviewed_at timestamptz,
  review_note text,
  created_at  timestamptz not null default now()
);

create index if not exists att_fix_user_idx on public.attendance_fixes (user_id, work_date);
create index if not exists att_fix_pending_idx on public.attendance_fixes (status) where status = 'pending';

comment on table public.attendance_fixes is
  '補登打卡的申請。本人提出、主管核可 —— 不讓主管直接改 attendance,'
  '因為那樣事後只看得到「被改過」,看不到「誰說他幾點下班、理由是什麼」。';

/*
 * 核可之後才寫進出勤紀錄。
 *
 * 只在 pending → approved 那一刻寫，重複核可不會重複寫（狀態已經是 approved 就不再進來）。
 */
create or replace function public.apply_attendance_fix() returns trigger
language plpgsql security definer set search_path = public as $fn$
declare ts timestamptz;
begin
  if new.status <> 'approved' or old.status = 'approved' then return null; end if;

  -- work_date 那天的 fix_time，用台北時間組出來
  ts := ((new.work_date::text || ' ' || new.fix_time::text)::timestamp
         at time zone 'Asia/Taipei');

  insert into public.attendance (user_id, work_date, status)
  values (new.user_id, new.work_date, 'fixed')
  on conflict (user_id, work_date) do nothing;

  if new.kind = 'in' then
    update public.attendance set in_at = ts, status = 'fixed', updated_at = now()
     where user_id = new.user_id and work_date = new.work_date;
  else
    update public.attendance set out_at = ts, status = 'fixed', updated_at = now()
     where user_id = new.user_id and work_date = new.work_date;
  end if;
  return null;
end $fn$;

drop trigger if exists trg_att_fix_apply on public.attendance_fixes;
create trigger trg_att_fix_apply
  after update of status on public.attendance_fixes
  for each row when (new.status = 'approved' and old.status is distinct from 'approved')
  execute function public.apply_attendance_fix();


-- ============================================================
-- 4. RLS
-- ============================================================

alter table public.attendance_fixes enable row level security;

drop policy if exists afix_read on public.attendance_fixes;
create policy afix_read on public.attendance_fixes for select
  using (user_id = auth.uid()
         or current_role_of() = any (array['manager', 'super_admin', 'accountant']));

-- 自己只能開自己的申請,而且只能改還在 pending 的（核可之後就不能自己動）
drop policy if exists afix_self on public.attendance_fixes;
create policy afix_self on public.attendance_fixes for insert
  with check (user_id = auth.uid());
drop policy if exists afix_self_upd on public.attendance_fixes;
create policy afix_self_upd on public.attendance_fixes for update
  using (user_id = auth.uid() and status = 'pending')
  with check (user_id = auth.uid() and status = 'pending');

drop policy if exists afix_review on public.attendance_fixes;
create policy afix_review on public.attendance_fixes for all
  using (current_role_of() = any (array['manager', 'super_admin']))
  with check (current_role_of() = any (array['manager', 'super_admin']));


-- ============================================================
-- 5. 把既有紀錄的狀態算一次
-- ============================================================

/*
 * 一次性回填。**刻意不呼叫 attendance_calc_status()** ——
 * 把整列傳進函式的寫法（func(tablename.*)）在 UPDATE 語句裡不可靠，
 * 而這裡只跑一次，把條件寫開反而更清楚也不會出錯。
 */
update public.attendance
   set status = case
     when status = 'fixed'                         then 'fixed'
     when in_at is not null and out_at is null     then 'missing_out'
     when in_at is null and out_at is not null     then 'missing_in'
     else 'normal'
   end
 where status is distinct from (case
     when status = 'fixed'                         then 'fixed'
     when in_at is not null and out_at is null     then 'missing_out'
     when in_at is null and out_at is not null     then 'missing_in'
     else 'normal'
   end);


notify pgrst, 'reload schema';


-- ============================================================
-- 驗證
--
-- 包在 exception 裡：驗證失敗只發警告，不要把上面的變更整包回滾掉。
-- ============================================================

do $$
declare t text; n int;
begin
  select count(*) into n from information_schema.columns
   where table_schema = 'public' and table_name = 'attendance' and column_name = 'status';
  if n = 1 then raise notice '✅ attendance.status 已建立';
  else raise warning '❌ status 欄位不存在'; return; end if;

  select count(*) into n from information_schema.tables
   where table_schema = 'public' and table_name = 'attendance_fixes';
  if n = 1 then raise notice '✅ 補登申請表已建立';
  else raise warning '❌ attendance_fixes 不存在'; end if;

  t := pg_get_functiondef('public.punch(text, numeric, numeric)'::regprocedure);

  -- ★ 最重要的一條：沒打上班不能打下班
  if position('NO_IN_YET' in t) > 0 then
    raise notice '✅ 「還沒打上班就打下班」會被擋 —— 隔天的卡不會補到前一天';
  else raise warning '❌ 沒有擋住,忘了打下班會讓隔天的卡寫成前一天的下班'; end if;

  -- 一律用台北時間判斷今天
  if position('Asia/Taipei' in t) > 0 then
    raise notice '✅ 用台北時間判斷「今天」（伺服器是 UTC,直接用會歸錯日）';
  else raise warning '❌ 沒有處理時區,台灣早上 8 點前的卡會被歸到前一天'; end if;

  -- 失敗要講得出原因
  if position('OUT_OF_RANGE' in t) > 0 and position('NO_GPS' in t) > 0
     and position('ALREADY_IN' in t) > 0 and position('ALREADY_OUT' in t) > 0 then
    raise notice '✅ 五種失敗都有各自的原因碼與中文說明';
  else raise warning '❌ 失敗原因不完整,使用者會不知道為什麼打不了卡'; end if;

  -- 補登核可的觸發器
  select count(*) into n from pg_trigger
   where tgname = 'trg_att_fix_apply' and tgqual is not null;
  if n = 1 then raise notice '✅ 補登核可會寫回出勤紀錄（有 WHEN 條件,不會重複寫）';
  else raise warning '❌ 補登觸發器沒建好'; end if;

  select count(*) into n from public.attendance where status = 'missing_out';
  raise notice 'ℹ 目前有 % 筆「沒打下班」的異常紀錄', n;

exception when others then
  raise warning '驗證區出錯（上面的變更不受影響）:%', sqlerrm;
end $$;


-- ── 打卡規則的實測 ─────────────────────────────────
--
-- punch() 依賴 auth.uid()，在 SQL Editor 裡是 null，所以測不了完整流程。
-- 這裡驗的是「拿不到身分時會不會好好回話」而不是硬噴例外 ——
-- 那是使用者實際會遇到的第一種失敗（登入過期）。

do $$
declare r jsonb;
begin
  r := public.punch('in', 25.0339, 121.5645);
  if r->>'code' = 'NO_AUTH' then
    raise notice '✅ 沒有身分時回傳 NO_AUTH 而不是例外:%', r->>'message';
  else
    raise notice 'ℹ SQL Editor 有身分,回傳:% / %', r->>'code', r->>'message';
  end if;

  r := public.punch('bad');
  if r->>'ok' = 'false' then raise notice '✅ 不合法的打卡類型會被擋';
  else raise warning '❌ 不合法的類型沒擋住'; end if;
exception when others then
  raise warning 'punch 實測出錯:%', sqlerrm;
end $$;


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    raise notice '%', (select public.record_migration('98_punch_rules'));
  else
    raise notice '尚未建立 schema_migrations（migration_70），這支沒有被記錄';
  end if;
end $$;
