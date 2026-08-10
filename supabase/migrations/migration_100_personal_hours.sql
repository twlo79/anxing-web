-- migration_100：每個人的上班時間 ＋ 可打卡時段
--
-- ============================================================
-- 【兩件事】
--
--   1. 主管可以設定「每一個員工」的上班時間 —— 房務 08:00、行政 09:00
--   2. 打卡要在可打卡時段內，超出就擋下來並指向補登申請
--
--
-- ============================================================
-- 【為什麼不是硬卡在 09:00–18:00】
--
-- 使用者說「員工要在上班時段內打卡」。字面上做的話：
-- 提早半小時到現場 → 打不了卡 → **那天完全沒有紀錄**。
--
-- 沒有紀錄比「有紀錄但標記遲到」糟糕得多：
-- 前者要事後補登、要主管介入、而且員工會覺得系統壞了，
-- 幾次之後就改用 LINE 回報出勤 —— 那時候這套系統等於不存在。
--
-- 所以做成**可設定的緩衝**：
--
--     可打卡時段 = 上班時間 − punch_before_min  ～  下班時間 + punch_after_min
--
-- 預設各 120 分鐘（上班 09:00 的人可以 07:00～20:00 打）。
-- 要收緊就把數字調小，要完全不擋就調成很大的值 —— 兩端都做得到。
--
-- 真的超出範圍（半夜兩點打卡）才擋，而且訊息直接告訴他走補登申請。


-- ============================================================
-- 1. 個人的上班時間
--
-- 三欄都可以是 null = 「照公司預設」。
-- 用 null 而不是把公司預設複製進每一列 —— 複製的話公司改了時間，
-- 已經建好的人不會跟著改，而且沒有人看得出哪些是刻意設的、哪些是複製來的。
-- ============================================================

alter table public.profiles
  add column if not exists work_start         time,
  add column if not exists work_end           time,
  add column if not exists work_hours_per_day numeric,
  -- 到職日：特休年資要用（migration_99 的 annual_leave_days）
  add column if not exists hired_on           date;

comment on column public.profiles.work_start is
  '這個人的上班時間。null = 用 work_settings 的公司預設。'
  '**不要把預設複製進來** —— 複製的話公司改了時間,已建好的人不會跟著改,'
  '而且分不出哪些是刻意設的、哪些只是複製來的。';
comment on column public.profiles.hired_on is
  '到職日。特休年資從這裡算（migration_99 的 annual_leave_days）。';


-- ============================================================
-- 2. 可打卡時段的緩衝
-- ============================================================

alter table public.work_settings
  add column if not exists punch_before_min int not null default 120,
  add column if not exists punch_after_min  int not null default 120;

comment on column public.work_settings.punch_before_min is
  '上班時間往前幾分鐘開始可以打卡。預設 120（09:00 上班的人 07:00 就能打）。'
  '調小會收緊,但**收太緊的代價是那天完全沒有紀錄** —— 沒紀錄比遲到難處理得多。';


-- ============================================================
-- 3. 這個人實際適用的設定
--
-- 個人有設就用個人的，沒設就用公司的。
-- 一個函式而不是每個呼叫端各自 coalesce —— 那樣總有一天會漏掉一處，
-- 而漏掉的症狀是「這個人的遲到時間跟別人算法不一樣」，沒有人查得出來。
-- ============================================================

create or replace function public.effective_work_settings(p_user uuid)
returns table (
  work_start time, work_end time, work_hours_per_day numeric,
  punch_before_min int, punch_after_min int
) language sql stable as $fn$
  select
    coalesce(p.work_start, w.work_start),
    coalesce(p.work_end, w.work_end),
    coalesce(p.work_hours_per_day, w.work_hours_per_day),
    w.punch_before_min, w.punch_after_min
  from public.work_settings w
  left join public.profiles p on p.id = p_user
  where w.id = 1
$fn$;


-- ============================================================
-- 4. 重新定義 punch()
--
-- **逐字保留 migration_98 的版本**，只動三處（都標了 ★）：
--   ★1 讀個人設定而不是公司單列
--   ★2 加上「可打卡時段」檢查
--   ★3 遲到／早退改用個人的上下班時間
--
-- 重寫整支的話會把 98 的「還沒打上班不能打下班」那條弄丟 ——
-- 那是這整個功能最重要的一條規則。
-- ============================================================

create or replace function public.punch(
  p_kind text, p_lat numeric default null, p_lng numeric default null
) returns jsonb
language plpgsql security definer set search_path = public as $fn$
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

  select e.id, e.name, e.gps_radius_m,
         public.gps_distance_m(p_lat, p_lng, e.gps_lat, e.gps_lng) as dist
    into best
    from public.estates e
   where e.active and e.gps_lat is not null and e.gps_lng is not null
   order by 4 limit 1;

  in_range := best.dist <= best.gps_radius_m;

  if not in_range then
    return jsonb_build_object('ok', false, 'code', 'OUT_OF_RANGE',
      'message', format('你不在任何物業的打卡範圍內。最近的是「%s」，距離約 %s 公尺（允許範圍 %s 公尺）。'
                     || E'\n\n如果你確實在現場，可能是室內收不到 GPS —— 走到窗邊或戶外再試一次，'
                     || '或請主管補登。',
                     best.name, round(best.dist), best.gps_radius_m),
      'estate', best.name, 'distance_m', round(best.dist), 'radius_m', best.gps_radius_m);
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
       * 【migration_98 的核心規則,原封不動】
       * 還沒打上班就要打下班 —— 擋下來。
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
    -- ★3 用這個人自己的下班時間算早退
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

  return jsonb_build_object(
    'ok', true, 'code', 'OK',
    'message', format('%s 打卡成功 · %s · %s%s',
      case when p_kind = 'in' then '上班' else '下班' end,
      to_char(now_ts at time zone 'Asia/Taipei', 'HH24:MI'), best.name,
      case
        when p_kind = 'in'  and coalesce(rec.late_min, 0)  > 0
          then format(E'\n（比上班時間 %s 晚了 %s 分鐘）', left(ws.work_start::text, 5), rec.late_min)
        when p_kind = 'out' and coalesce(rec.early_min, 0) > 0
          then format(E'\n（比下班時間 %s 早了 %s 分鐘）', left(ws.work_end::text, 5), rec.early_min)
        else '' end),
    'late_min', coalesce(rec.late_min, 0),
    'early_min', coalesce(rec.early_min, 0),
    'kind', p_kind, 'estate', best.name,
    'at', to_char(now_ts at time zone 'Asia/Taipei', 'HH24:MI'),
    'distance_m', round(best.dist),
    'is_holiday', not public.is_workday(today),
    'hours', public.attendance_hours(rec));
end $fn$;


notify pgrst, 'reload schema';


-- ============================================================
-- 驗證
--
-- 包在 exception 裡：驗證失敗只發警告，不要把上面的變更整包回滾掉。
-- ============================================================

do $$
declare n int; t text; r record;
begin
  select count(*) into n from information_schema.columns
   where table_schema = 'public' and table_name = 'profiles'
     and column_name in ('work_start', 'work_end', 'work_hours_per_day', 'hired_on');
  if n = 4 then raise notice '✅ profiles 的四個欄位都加上了（個人上下班時間、每日工時、到職日）';
  else raise warning '❌ 只加了 % 個欄位', n; end if;

  select count(*) into n from information_schema.columns
   where table_schema = 'public' and table_name = 'work_settings'
     and column_name in ('punch_before_min', 'punch_after_min');
  if n = 2 then raise notice '✅ 可打卡時段的緩衝欄位已加上（各預設 120 分鐘）';
  else raise warning '❌ 緩衝欄位不完整'; end if;

  -- 沒有個人設定時要退回公司預設
  select * into r from public.effective_work_settings(gen_random_uuid());
  if r.work_start = '09:00'::time and r.punch_before_min = 120 then
    raise notice '✅ 沒有個人設定時退回公司預設（09:00,前後各 120 分鐘）';
  else raise warning '❌ 預設值不對:% / %', r.work_start, r.punch_before_min; end if;

  t := pg_get_functiondef('public.punch(text, numeric, numeric)'::regprocedure);

  -- ★ 98 的核心規則不能被弄丟 —— 這一支重寫了整個 punch()
  if position('NO_IN_YET' in t) > 0 then
    raise notice '✅ migration_98 的「還沒打上班不能打下班」仍在';
  else raise warning '❌ 把 98 最重要的規則弄丟了!忘了打下班會讓隔天的卡寫成前一天'; end if;

  if position('OUT_OF_WINDOW' in t) > 0 then
    raise notice '✅ 可打卡時段檢查已加入';
  else raise warning '❌ 沒有時段檢查'; end if;

  if position('effective_work_settings' in t) > 0 then
    raise notice '✅ punch() 改用個人的上班時間';
  else raise warning '❌ punch() 還在讀公司單列設定,個人時間不會生效'; end if;

  if position('Asia/Taipei' in t) > 0 then
    raise notice '✅ 時區處理仍在';
  else raise warning '❌ 時區處理被弄丟了'; end if;

exception when others then
  raise warning '驗證區出錯（上面的變更不受影響）:%', sqlerrm;
end $$;


-- ── 可打卡時段一覽（給人核對）───────────────────────
select
  p.name                                              as 姓名,
  p.role                                              as 角色,
  coalesce(p.work_start, w.work_start)                as 上班,
  coalesce(p.work_end, w.work_end)                    as 下班,
  case when p.work_start is null then '公司預設' else '個人設定' end as 來源,
  left((coalesce(p.work_start, w.work_start) - make_interval(mins => w.punch_before_min))::text, 5)
                                                      as 可打卡從,
  left((coalesce(p.work_end, w.work_end) + make_interval(mins => w.punch_after_min))::text, 5)
                                                      as 可打卡到,
  p.hired_on                                          as 到職日
from public.profiles p
cross join public.work_settings w
where w.id = 1 and p.active
order by p.name;


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    raise notice '%', (select public.record_migration('100_personal_hours'));
  else
    raise notice '尚未建立 schema_migrations（migration_70），這支沒有被記錄';
  end if;
end $$;
