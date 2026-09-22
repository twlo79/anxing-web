/* ══════════════════════════════════════════════════════════════════════
 * migration_291  請假改版：一張單裝一份日期明細 ＋ 午休 ＋ 修 153 小時  2026-09-22
 *
 * ══════════════════════════════════════════════════════════
 * 【為什麼】
 *
 *   ① `request_leave()` 的時數是 `結束 − 開始` 的牆上時鐘時數：
 *        9/24 09:00 → 9/30 18:00 ＝ **153 小時**
 *      午休、晚上、週末、中秋、教師節全部算進特休。年假總共 56 小時，
 *      所以**多天請假從上線到現在一次都沒成功過**（會被擋說「不夠」）。
 *      單天看起來正常，是因為使用者自己手動避開了午休。
 *
 *   ② 使用者要的（2026-09-22）：點月曆選日子、每天各自選整天／半天／時數、
 *      一張單可以包好幾天、送出前看得到共幾天幾小時。
 *
 * 【做法：乙案 —— 送出時拆成多列，畫面收成一列】
 *
 *   每一列 `leave_requests` 還是「一天內的一段時間」，跟現在長得一模一樣，
 *   所以 `leave_hours_on()`、`attendance_report()`、`leave_no_overlap`
 *   **一行都不用改**。多的只有一欄 `batch_id` 把同一次送出的列綁在一起。
 *
 *   ★ 不選「一張單橫跨 9/24 → 9/30」：那樣 `attendance_report` 會把中秋節
 *     印成「年假」（它只問這天在不在區間內），而且 `leave_no_overlap` 會把
 *     整段六天鎖住。
 *   ★ 不選「一張單＋子表」：要改 `leave_no_overlap` —— 那是目前唯一在擋
 *     「同一天請兩次假」的東西，改壞了不會報錯。
 *
 * 【三個決定（使用者 2026-09-22）】
 *   · 主管要剔除某一天 → **整批駁回，申請人重送**（不做逐日剔除）
 *   · 午休 **12:30～13:30**，存進 `work_settings`
 *   · 舊單不動
 *
 * 【這支做什麼】
 *   1. `work_settings` 加 `lunch_start` / `lunch_end`（預設 12:30 / 13:30）
 *   2. `effective_work_settings()` 多回這兩欄
 *   3. `leave_requests` 加 `batch_id`
 *   4. 新函式 `leave_hours_between(start, end, user)`：一段時間裡的**工作時數**
 *      （扣掉午休、夾在上下班之間）—— 全站只准這一份
 *   5. 新 RPC `request_leave_batch(type, days, reason)`：一次送好幾天，
 *      **一個交易**，額度不夠就整批不寫
 *   6. 舊的 `request_leave()` 時數改走 4.（修 153 小時那個 bug）
 *
 * ★★ 自檢在 commit 後面 —— **看不到那張表就是整支回滾了**。
 * ══════════════════════════════════════════════════════════ */

begin;

-- ── 1. 午休 ────────────────────────────────────────────────
alter table public.work_settings
  add column if not exists lunch_start time not null default '12:30',
  add column if not exists lunch_end   time not null default '13:30';

comment on column public.work_settings.lunch_start is
  '午休開始（2026-09-22 使用者指定 12:30）。請假時數算法會把這一段扣掉';
comment on column public.work_settings.lunch_end is
  '午休結束（13:30）';

do $do$ begin
  alter table public.work_settings add constraint ws_lunch_chk
    check (lunch_start < lunch_end and lunch_start >= work_start and lunch_end <= work_end);
exception when duplicate_object then null; end $do$;

-- ── 2. effective_work_settings 多回午休 ────────────────────
-- ★ returns table 的簽章變了要先 drop。呼叫端都是按欄位名讀，多兩欄不影響。
drop function if exists public.effective_work_settings(uuid);
create function public.effective_work_settings(p_user uuid)
returns table (
  work_start time, work_end time, work_hours_per_day numeric,
  punch_before_min int, punch_after_min int,
  lunch_start time, lunch_end time
) language sql stable as $fn$
  select
    coalesce(p.work_start, w.work_start),
    coalesce(p.work_end, w.work_end),
    coalesce(p.work_hours_per_day, w.work_hours_per_day),
    w.punch_before_min, w.punch_after_min,
    w.lunch_start, w.lunch_end
  from public.work_settings w
  left join public.profiles p on p.id = p_user
  where w.id = 1
$fn$;
grant execute on function public.effective_work_settings(uuid) to authenticated;

-- ── 3. batch_id ────────────────────────────────────────────
alter table public.leave_requests add column if not exists batch_id uuid;
comment on column public.leave_requests.batch_id is
  '同一次送出的幾天共用一個 batch_id（migration_291）。null ＝ 舊單，一張一天。'
  '取消與駁回都是整批一起。';
create index if not exists leave_req_batch_idx on public.leave_requests (batch_id)
  where batch_id is not null;

-- ── 4. 工作時數 ────────────────────────────────────────────
/*
 * 一段時間裡有幾個「工作小時」：夾在上下班之間，扣掉午休。
 *
 * ★★★ 全站只准這一份。前端 `lib/leave-days.ts` 有一份**同樣算法**給預覽用，
 *   而 `request_leave_batch()` 會拿這裡算的跟前端送來的比 —— 對不上就擋。
 *   兩份不會安靜地長歪，因為歪了就送不出去。
 *
 * ★ 只處理**同一天**。跨天的段交給呼叫端切成一天一段再來。
 */
create or replace function public.leave_hours_between(
  p_start timestamptz, p_end timestamptz, p_user uuid
) returns numeric language plpgsql stable as $fn$
declare
  ws record;
  d  date;
  s  time; e time;
  h  numeric := 0;
  a1 time; b1 time; a2 time; b2 time;
begin
  if p_start is null or p_end is null or p_end <= p_start then return 0; end if;
  select * into ws from public.effective_work_settings(p_user);
  if ws.work_start is null then return 0; end if;

  d := (p_start at time zone 'Asia/Taipei')::date;
  if (p_end at time zone 'Asia/Taipei')::date <> d
     and not ((p_end at time zone 'Asia/Taipei')::time = '00:00' and (p_end at time zone 'Asia/Taipei')::date = d + 1) then
    -- 跨天：只算第一天那一段（呼叫端本來就不該送跨天的）
    e := '23:59:59';
  else
    e := (p_end at time zone 'Asia/Taipei')::time;
    if e = '00:00' then e := '23:59:59'; end if;
  end if;
  s := (p_start at time zone 'Asia/Taipei')::time;

  -- 上午段：work_start ~ lunch_start；下午段：lunch_end ~ work_end
  a1 := greatest(s, ws.work_start); b1 := least(e, ws.lunch_start);
  a2 := greatest(s, ws.lunch_end);  b2 := least(e, ws.work_end);
  if b1 > a1 then h := h + extract(epoch from (b1 - a1)) / 3600.0; end if;
  if b2 > a2 then h := h + extract(epoch from (b2 - a2)) / 3600.0; end if;
  return round(h, 2);
end $fn$;
grant execute on function public.leave_hours_between(timestamptz, timestamptz, uuid) to authenticated;

-- ── 5. 一次送好幾天 ────────────────────────────────────────
/*
 * p_days: jsonb 陣列，每一項 {"d":"2026-09-24","s":"09:00","e":"18:00","h":8}
 *   d 日期、s/e 當天的起訖（台北時間）、h 前端算出來的時數（拿來對）
 *
 * ★★★ 整支是一個交易：任何一天過不了（假日、重疊、時數對不上、額度不夠）
 *   就一列都不寫。拆成好幾次 PostgREST 呼叫的話會「請了一半」——
 *   跟 `DeferralPanel` 那次同一種坑。
 *
 * ★ 回 jsonb 而不是 raise：前端要拿 message 顯示在按鈕旁邊。
 *   但**寫入之後**任何錯誤都要 raise 才會回滾 —— 所以檢查全部在 insert 之前。
 */
create or replace function public.request_leave_batch(
  p_type text, p_days jsonb, p_reason text default null
) returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare
  uid     uuid := auth.uid();
  lt      public.leave_types;
  bal     public.leave_balances;
  remain  numeric;
  total   numeric := 0;
  yr      int;
  bid     uuid := gen_random_uuid();
  it      jsonb;
  d       date; s time; e time; h numeric; calc numeric;
  ts_s    timestamptz; ts_e timestamptz;
  n       int := 0;
  seen    date[] := '{}';
  n_over  int;
  first_d date; last_d date;
begin
  if uid is null then
    return jsonb_build_object('ok', false, 'code', 'NO_AUTH', 'message', '請重新登入');
  end if;
  select * into lt from public.leave_types where code = p_type and active;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'BAD_TYPE', 'message', '假別不存在或已停用');
  end if;
  if p_days is null or jsonb_typeof(p_days) <> 'array' or jsonb_array_length(p_days) = 0 then
    return jsonb_build_object('ok', false, 'code', 'NO_DAYS', 'message', '還沒選任何一天。');
  end if;

  -- ── 逐天檢查（還沒寫任何東西）──
  for it in select * from jsonb_array_elements(p_days) loop
    begin
      d := (it->>'d')::date; s := (it->>'s')::time; e := (it->>'e')::time; h := (it->>'h')::numeric;
    exception when others then
      return jsonb_build_object('ok', false, 'code', 'BAD_DAY',
        'message', format('有一天的資料格式不對：%s', it::text));
    end;
    if d = any(seen) then
      return jsonb_build_object('ok', false, 'code', 'DUP_DAY', 'message', format('%s 選了兩次。', d));
    end if;
    seen := seen || d;
    if not public.is_workday(d) then
      return jsonb_build_object('ok', false, 'code', 'NOT_WORKDAY',
        'message', format('%s 不是上班日，不用請假。', d));
    end if;
    if e <= s then
      return jsonb_build_object('ok', false, 'code', 'BAD_RANGE',
        'message', format('%s 的結束時間要晚於開始時間。', d));
    end if;
    ts_s := (d::text || ' ' || s::text)::timestamp at time zone 'Asia/Taipei';
    ts_e := (d::text || ' ' || e::text)::timestamp at time zone 'Asia/Taipei';

    -- ★★★ 時數以資料庫算的為準；前端送來的要對得上，不然就是兩邊規則長歪了
    calc := public.leave_hours_between(ts_s, ts_e, uid);
    if calc <= 0 then
      return jsonb_build_object('ok', false, 'code', 'ZERO_HOURS',
        'message', format('%s %s～%s 這段沒有工作時數（在上班時間外，或全部是午休）。', d, s, e));
    end if;
    if h is null or abs(h - calc) > 0.01 then
      return jsonb_build_object('ok', false, 'code', 'HOURS_MISMATCH',
        'message', format('%s 的時數對不上：畫面算 %s，系統算 %s。請重新整理再送一次；還是不對的話跟工程師講。', d, h, calc));
    end if;

    select count(*) into n_over from public.leave_requests r
     where r.user_id = uid and r.status in ('pending', 'approved')
       and tstzrange(r.start_at, r.end_at) && tstzrange(ts_s, ts_e);
    if n_over > 0 then
      return jsonb_build_object('ok', false, 'code', 'OVERLAP',
        'message', format('%s 已經有一張請假單（送審中或已核可）。先取消原本那張，或把這一天拿掉。', d));
    end if;

    total := total + calc; n := n + 1;
    first_d := least(coalesce(first_d, d), d); last_d := greatest(coalesce(last_d, d), d);
  end loop;

  -- ── 額度：整批一起看 ──
  -- ★ 年度看第一天。跨年的一批（12/30～1/2）不常見；真的有就分兩次送。
  yr := extract(year from first_d)::int;
  if extract(year from last_d)::int <> yr then
    return jsonb_build_object('ok', false, 'code', 'CROSS_YEAR',
      'message', '這一批跨了兩個年度，額度是分年算的 —— 請分成兩次送。');
  end if;
  if lt.has_quota then
    select * into bal from public.leave_balances
     where user_id = uid and year = yr and type_code = p_type;
    remain := coalesce(bal.quota_hours, 0) - coalesce(bal.used_hours, 0);
    if bal.id is null or coalesce(bal.quota_hours, 0) <= 0 then
      return jsonb_build_object('ok', false, 'code', 'NO_QUOTA',
        'message', format('%s 今年還沒有配額。請主管到「管理 → 假別額度」設定。', lt.name));
    end if;
    -- ★ 送審中的也要算進去，不然兩張單各自看都夠、加起來超過
    remain := remain - coalesce((
      select sum(r.hours) from public.leave_requests r
       where r.user_id = uid and r.type_code = p_type and r.status = 'pending'
         and extract(year from (r.start_at at time zone 'Asia/Taipei')) = yr), 0);
    if total > remain then
      return jsonb_build_object('ok', false, 'code', 'NOT_ENOUGH',
        'message', format('%s 不夠。這次共 %s 小時，但只剩 %s 小時（含送審中的）。拿掉幾天，或改請事假。',
                          lt.name, total, greatest(remain, 0)),
        'need', total, 'remain', greatest(remain, 0));
    end if;
  end if;

  -- ── 寫入：從這裡開始任何錯都 raise，整批回滾 ──
  for it in select * from jsonb_array_elements(p_days) loop
    d := (it->>'d')::date; s := (it->>'s')::time; e := (it->>'e')::time;
    ts_s := (d::text || ' ' || s::text)::timestamp at time zone 'Asia/Taipei';
    ts_e := (d::text || ' ' || e::text)::timestamp at time zone 'Asia/Taipei';
    insert into public.leave_requests (user_id, type_code, start_at, end_at, hours, reason, batch_id)
    values (uid, p_type, ts_s, ts_e, public.leave_hours_between(ts_s, ts_e, uid),
            nullif(btrim(p_reason), ''), bid);
  end loop;

  return jsonb_build_object('ok', true, 'code', 'OK', 'batch_id', bid, 'count', n, 'hours', total,
    'message', format('已送出 %s：%s 天共 %s 小時，等待主管與總經理核可。',
                      lt.name, n, total));
exception
  when exclusion_violation then
    raise exception '有一天跟既有的請假單重疊 —— 一列都沒寫進去。請重新整理再試。';
end $fn$;
grant execute on function public.request_leave_batch(text, jsonb, text) to authenticated;

-- ── 6. 舊的 request_leave：時數改走同一支 ────────────────
-- ★ 前端已經不叫它了，但留著的 RPC 不能是一支會算出 153 小時的。
--   只動一行：hrs 的算法。其他逐字保留（migration_99）。
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
    return jsonb_build_object('ok', false, 'code', 'BAD_RANGE', 'message', '結束時間要晚於開始時間。');
  end if;
  -- ★ migration_291：不再是 end − start（那會把午休、晚上、週末全算進去）。
  --   而且**只收同一天**：跨天的請假走 request_leave_batch()，一天一列。
  --   這裡若收跨天而只算第一天，會安靜地少算 —— 比 153 更難發現。
  if (p_start at time zone 'Asia/Taipei')::date <> (p_end at time zone 'Asia/Taipei')::date then
    return jsonb_build_object('ok', false, 'code', 'MULTI_DAY',
      'message', '跨天的請假請用新的請假表單（月曆點日子），一天一列。');
  end if;
  hrs := public.leave_hours_between(p_start, p_end, uid);
  if hrs <= 0 then
    return jsonb_build_object('ok', false, 'code', 'ZERO_HOURS',
      'message', '這段時間沒有工作時數（在上班時間外，或全部是午休）。');
  end if;
  yr  := extract(year from (p_start at time zone 'Asia/Taipei'))::int;
  select count(*) into n_over from public.leave_requests r
   where r.user_id = uid and r.status in ('pending', 'approved')
     and tstzrange(r.start_at, r.end_at) && tstzrange(p_start, p_end);
  if n_over > 0 then
    return jsonb_build_object('ok', false, 'code', 'OVERLAP',
      'message', '這段時間你已經有一張請假單（送審中或已核可）。' || E'\n請先到「我的假單」取消原本那張，或改成不重疊的時段。');
  end if;
  if lt.has_quota then
    select * into bal from public.leave_balances where user_id = uid and year = yr and type_code = p_type;
    remain := coalesce(bal.quota_hours, 0) - coalesce(bal.used_hours, 0);
    if bal.id is null or coalesce(bal.quota_hours, 0) <= 0 then
      return jsonb_build_object('ok', false, 'code', 'NO_QUOTA',
        'message', format('%s 今年還沒有配額。請主管到「打卡 → 假別額度」設定，或確認你的到職日是否已經填寫。', lt.name));
    end if;
    if hrs > remain then
      return jsonb_build_object('ok', false, 'code', 'NOT_ENOUGH',
        'message', format('%s 不夠。這次要請 %s 小時，但只剩 %s 小時（今年額度 %s、已用 %s）。' || E'\n\n可以改請事假，或縮短時段。',
                          lt.name, hrs, remain, bal.quota_hours, bal.used_hours),
        'need', hrs, 'remain', remain);
    end if;
  end if;
  insert into public.leave_requests (user_id, type_code, start_at, end_at, hours, reason)
  values (uid, p_type, p_start, p_end, hrs, p_reason) returning id into new_id;
  return jsonb_build_object('ok', true, 'code', 'OK', 'id', new_id, 'hours', hrs,
    'message', format('已送出 %s %s 小時，等待主管與總經理核可。', lt.name, hrs));
exception
  when exclusion_violation then
    return jsonb_build_object('ok', false, 'code', 'OVERLAP',
      'message', '這段時間你已經有一張請假單。請先取消原本那張，或改成不重疊的時段。');
  when others then
    return jsonb_build_object('ok', false, 'code', 'ERROR', 'message', '送出失敗：' || sqlerrm);
end $fn$;

do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('291_leave_batch');
  end if;
end $do$;

commit;

-- ══════════════════════════════════════════════════════════
-- 自檢（在 commit 後面 —— 看不到這張表就是整支回滾了）
-- ══════════════════════════════════════════════════════════
with
  ws as (select lunch_start, lunch_end, work_start, work_end from public.work_settings where id = 1),
  -- 拿一個真的 user 來算（沒有 profiles 就用 null，走公司預設）
  u as (select id from public.profiles limit 1),
  h8   as (select public.leave_hours_between('2026-09-24 09:00+08', '2026-09-24 18:00+08', (select id from u)) as h),
  ham  as (select public.leave_hours_between('2026-09-24 09:00+08', '2026-09-24 12:30+08', (select id from u)) as h),
  hpm  as (select public.leave_hours_between('2026-09-24 13:30+08', '2026-09-24 18:00+08', (select id from u)) as h),
  hx   as (select public.leave_hours_between('2026-09-24 12:00+08', '2026-09-24 14:00+08', (select id from u)) as h),
  h153 as (select public.leave_hours_between('2026-09-24 09:00+08', '2026-09-30 18:00+08', (select id from u)) as h)
select 1 as 序, '這支跑過了沒' as 檢查,
       (select count(*)::text from public.schema_migrations where name = '291_leave_batch') as 結果,
       case when exists (select 1 from public.schema_migrations where name = '291_leave_batch') then '✅' else '❌ 沒記到' end as 判定
union all select 2, '午休欄位在不在',
       (select lunch_start::text || '～' || lunch_end::text from ws),
       case when (select lunch_start from ws) = '12:30' and (select lunch_end from ws) = '13:30' then '✅' else '⚠ 不是 12:30～13:30（可能被改過）' end
union all select 3, 'batch_id 欄位在不在',
       (select count(*)::text from information_schema.columns where table_schema='public' and table_name='leave_requests' and column_name='batch_id'),
       case when exists (select 1 from information_schema.columns where table_schema='public' and table_name='leave_requests' and column_name='batch_id') then '✅' else '❌' end
union all select 4, '整天 09:00～18:00 ＝ 8 小時（扣午休）', (select h::text from h8),
       case when (select h from h8) = 8 then '✅' else '❌ 應該是 8' end
union all select 5, '上午 09:00～12:30 ＝ 3.5', (select h::text from ham),
       case when (select h from ham) = 3.5 then '✅' else '❌' end
union all select 6, '下午 13:30～18:00 ＝ 4.5', (select h::text from hpm),
       case when (select h from hpm) = 4.5 then '✅' else '❌' end
union all select 7, '跨午休 12:00～14:00 ＝ 1（扣掉 12:30～13:30）', (select h::text from hx),
       case when (select h from hx) = 1 then '✅' else '❌' end
union all select 8, '★ 那個 153 小時的輸入現在算多少', (select h::text from h153),
       case when (select h from h153) <= 8 then '✅ 不再是 153' else '❌ 還是把整段算進去' end
union all select 9, 'effective_work_settings 回得出午休',
       (select lunch_start::text || '～' || lunch_end::text from public.effective_work_settings((select id from u))),
       case when (select lunch_start from public.effective_work_settings((select id from u))) is not null then '✅' else '❌ 沒回午休' end
union all select 10, 'request_leave_batch 存在',
       (select count(*)::text from pg_proc where proname='request_leave_batch'),
       case when exists (select 1 from pg_proc where proname='request_leave_batch') then '✅' else '❌' end
union all select 11, '母體：既有請假單筆數（參考）',
       (select count(*)::text from public.leave_requests),
       case when (select count(*) from public.leave_requests) = 0 then '⚠ 一筆都沒有，第 12 列不算數' else '✅ 有東西可比' end
union all select 12, '舊單一筆都沒被動到（batch_id 全是 null）',
       (select count(*)::text from public.leave_requests where batch_id is not null),
       case when (select count(*) from public.leave_requests where batch_id is not null) = 0 then '✅' else '❌ 這支不該碰舊單' end
order by 1;
