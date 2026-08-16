-- migration_132：出勤表拆成「應到」與「實到」
--
-- ============================================================
-- 【原本只要有打卡就算滿 8 小時】
--
-- `attendance_report` 的工作時數是這樣算的：
--
--     有打卡 或 有請假  →  每日工時 − 請假時數
--     其餘              →  0
--
-- 也就是**不管實際幾點到、幾點走**。遲到兩小時跟準時來，
-- 那一欄一模一樣 —— 遲到只出現在另一個小欄位（`late_min`），
-- 而看報表的人不會把兩欄放在一起讀。
--
-- 結果是:出勤表看起來每個人每天都做滿八小時，
-- 而那正是這份報表要回答的問題。
--
--
-- ============================================================
-- 【拆成兩欄】（2026-08-16 使用者指定）
--
--     due_hours     應到 = 每日工時 − 請假時數        「今天該做多久」
--     actual_hours  實到 = 下班 − 上班 − 休息          「實際做了多久」
--
-- 兩欄並排，差多少一眼就看得到。
--
-- **`work_hours` 保留不動。** 它現在等於 `due_hours` ——
-- 拿掉的話所有讀這支函式的地方都要同時改，而漏掉一個就是那一頁
-- 突然少一欄。等前端都換過去再說。
--
--
-- ============================================================
-- 【休息時間從設定推導，不寫死 1 小時】
--
--     休息 = (work_end − work_start) − work_hours_per_day
--          = (18:00 − 09:00) − 8 = 1
--
-- 寫死 1 的話，哪天有人改成六小時班，那個 1 就變成錯的 ——
-- 而它不會報錯，只會讓實到永遠少一小時。
--
-- 推導出負數（設定本身矛盾）時當 0:那是設定要修的問題，
-- 不該讓實到變成比在公司的時間還長。
--
-- 前端有一份一模一樣的算法（`lib/attendance-hours.ts`，26 個測試）——
-- 兩邊必須一致，改一邊要記得改另一邊。
--
--
-- ============================================================
-- 【沒打下班卡 → 實到是 null，不是 0】
--
-- 0 的意思是「那天做了 0 小時」，null 是「算不出來」。
-- 混在一起的話，忘記打下班卡的人會被當成整天沒做事，
-- 而那個 0 加進月合計裡沒有人看得出來。

/*
 * 一定要先 drop —— `create or replace` 改不了回傳型別。
 * 這次多兩欄，直接 replace 會噴 cannot change return type。
 */
drop function if exists public.attendance_report(uuid, date, date);

create function public.attendance_report(
  p_user uuid, p_from date, p_to date
) returns table (
  work_date    date,
  staff_name   text,
  item         text,       -- 上班日 / 假別 / 例假日 / 國定假日 / 未出勤
  in_at        text,       -- HH:MM
  out_at       text,
  work_hours   numeric,    -- 保留:等於 due_hours，等前端換完再移除
  due_hours    numeric,    -- ★ 應到
  actual_hours numeric,    -- ★ 實到（沒打下班卡是 null）
  leave_hours  numeric,
  ot_hours     numeric,
  late_min     int,
  early_min    int,
  note         text
) language sql stable as $fn$
  with cfg as (
    select *,
           /*
            * 休息時間。跨夜班（22:00–06:00）要 +24 才不會是負的。
            * 設定缺一半就當沒有休息 —— 不猜。
            */
           greatest(0, case
             when work_start is null or work_end is null then 0
             else (case
                     when work_end >= work_start
                       then extract(epoch from (work_end - work_start)) / 3600.0
                     else extract(epoch from (work_end - work_start)) / 3600.0 + 24
                   end) - work_hours_per_day
           end) as brk
      from public.effective_work_settings(p_user)
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
      c.work_hours_per_day                                             as daily,
      c.brk
    from days dy
    cross join cfg c
    left join public.attendance a on a.user_id = p_user and a.work_date = dy.d
  ), calc2 as (
    select calc.*,
      /*
       * 應到。**例假日與未出勤都是 0** ——
       * 不然一個月會憑空多出十幾天的應到時數。
       *
       * 原本的條件是「有打卡或有請假」，維持一樣:
       * 沒來也沒請假的工作日應到是 0（那是曠職，另外看「未出勤」那一欄）。
       */
      case
        when calc.in_at is not null or calc.lv > 0 then greatest(0, calc.daily - calc.lv)
        else 0
      end as due,
      -- 實到。兩張卡都有才算得出來
      case
        when calc.in_at is null or calc.out_at is null then null
        when calc.out_at <= calc.in_at then null      -- 資料壞了,不要算成負的
        else greatest(0, round(
               extract(epoch from (calc.out_at - calc.in_at)) / 3600.0 - calc.brk, 2))
      end as actual
    from calc
  )
  select
    calc2.d,
    calc2.nm,
    case
      when calc2.lv_name is not null and calc2.in_at is null then calc2.lv_name
      when calc2.lv_name is not null                         then '上班日・' || calc2.lv_name
      when calc2.in_at is not null                           then '上班日'
      when not calc2.is_work                                 then
        coalesce((select h.name from public.holidays h where h.d = calc2.d and h.kind = 'holiday'), '例假日')
      else '未出勤'
    end,
    to_char(calc2.in_at  at time zone 'Asia/Taipei', 'HH24:MI'),
    to_char(calc2.out_at at time zone 'Asia/Taipei', 'HH24:MI'),
    calc2.due,        -- work_hours（保留，等於 due_hours）
    calc2.due,
    calc2.actual,
    calc2.lv,
    calc2.ot,
    calc2.late_min,
    calc2.early_min,
    case
      when calc2.status = 'missing_out' then '沒打下班卡'
      when calc2.status = 'missing_in'  then '沒打上班卡'
      when calc2.status = 'fixed'       then '補登'
      else calc2.note
    end
  from calc2
  order by calc2.d
$fn$;

comment on function public.attendance_report(uuid, date, date) is
  '出勤表的資料來源,一天一列。**沒打卡的日子也有列**。'
  '應到 = 每日工時 − 請假；實到 = 下班 − 上班 − 休息（休息從設定推導,不寫死）。'
  '實到是 null 代表算不出來（沒打下班卡）,不是 0 ——'
  '當成 0 的話忘記打卡的人會被算成整天沒做事。'
  'work_hours 等於 due_hours,保留是為了不讓既有呼叫端一次全壞。';


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('132_attendance_due_actual');
  end if;
end $$;


-- ============================================================
-- 驗證
-- ============================================================
do $$
declare v_user uuid; n int;
begin
  drop table if exists _chk132;
  create temp table _chk132 (ord int, item text, result text, detail text);

  insert into _chk132 values (1, 'attendance_report 有 due_hours',
    case when exists (
      select 1 from information_schema.routines r
      join information_schema.parameters p on p.specific_name = r.specific_name
      where r.routine_name = 'attendance_report' and p.parameter_name = 'due_hours')
    then '✅' else '❌' end, '');

  insert into _chk132 values (1, 'attendance_report 有 actual_hours',
    case when exists (
      select 1 from information_schema.routines r
      join information_schema.parameters p on p.specific_name = r.specific_name
      where r.routine_name = 'attendance_report' and p.parameter_name = 'actual_hours')
    then '✅' else '❌' end, '');

  -- 拿一個真的有打卡紀錄的人來跑，看數字合不合理
  select user_id into v_user from public.attendance
   where in_at is not null and out_at is not null
   order by work_date desc limit 1;

  if v_user is null then
    insert into _chk132 values (5, '★ 試算', '⚠ 沒有完整的打卡紀錄', '還沒有人打過完整的上下班卡');
  else
    insert into _chk132
    select 5, '★ ' || to_char(work_date, 'MM/DD') || ' ' || staff_name,
           '應到 ' || due_hours || ' / 實到 ' || coalesce(actual_hours::text, '（沒下班卡）'),
           coalesce(in_at, '—') || '～' || coalesce(out_at, '—')
           || case when late_min > 0 then '　遲到 ' || late_min || ' 分' else '' end
      from public.attendance_report(v_user, current_date - 30, current_date)
     where in_at is not null
     order by work_date desc
     limit 5;
  end if;

  -- 休息時間推導出來是多少
  insert into _chk132
  select 8, '★ 休息時間（' || coalesce(p.name, '預設') || '）',
         greatest(0, (extract(epoch from (c.work_end - c.work_start)) / 3600.0)
                     - c.work_hours_per_day)::text || ' 小時',
         to_char(c.work_start, 'HH24:MI') || '–' || to_char(c.work_end, 'HH24:MI')
         || '，每日工時 ' || c.work_hours_per_day
    from public.profiles p
    cross join lateral public.effective_work_settings(p.id) c
   where p.id = coalesce(v_user, p.id)
   limit 3;

  /*
   * 這一條要盯：實到比應到少很多的日子。
   *
   * 少一點是正常的（提早幾分鐘走），少一半以上通常是
   * 忘記打卡或補登時間填錯 —— 那些會直接影響薪資。
   */
  select count(*) into n
    from public.attendance a
   where a.in_at is not null and a.out_at is not null
     and a.work_date >= current_date - 30
     and extract(epoch from (a.out_at - a.in_at)) / 3600.0 < 4;
  insert into _chk132 values (9, '★★ 近 30 天實到不到 4 小時的',
    case when n = 0 then '✅ 沒有' else '⚠ ' || n || ' 天' end,
    '少一點正常,少一半通常是忘記打卡或補登填錯 —— 那會直接影響薪資');
end $$;

select item as "檢查項目", result as "結果", detail as "說明"
from _chk132 order by ord, item;
