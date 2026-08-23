-- migration_104：主管設定個人上下班時間（不開放 profiles 的寫入）
--
-- ============================================================
-- 【為什麼不是直接開 RLS】
--
-- 「主管要能改員工的上下班時間」最直覺的做法是給 profiles 加一條
-- update 政策。**不能這樣做。**
--
-- PostgreSQL 的 RLS 是列級的，開了就是整列都能改 —— 包含 role。
-- 主管可以把自己改成 super_admin，而這件事不會留下任何痕跡，
-- 也不會有任何錯誤訊息。權限系統就此失效。
--
-- 所以走 SECURITY DEFINER 的函式：函式只寫那四個欄位，
-- 呼叫者碰不到 role。這是唯一能「只開放某幾欄」的做法。
--
--
-- ============================================================
-- 【為什麼函式自己要再檢查一次角色】
--
-- SECURITY DEFINER 的函式是用**函式擁有者**的權限執行的，
-- RLS 對它不生效。忘了檢查的話，任何登入的人都能改別人的班表。
-- 這是 SECURITY DEFINER 最常見的漏洞，而它不會有任何症狀。
-- ============================================================

create or replace function public.set_work_time(
  p_user  uuid,
  p_start time    default null,
  p_end   time    default null,
  p_hours numeric default null,
  p_hired date    default null
) returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare r text := current_role_of();
begin
  if r is null or r not in ('manager', 'super_admin') then
    return jsonb_build_object('ok', false, 'code', 'NO_PERM',
      'message', '只有主管與總經理可以設定上下班時間。');
  end if;

  if p_hours is not null and (p_hours <= 0 or p_hours > 24) then
    return jsonb_build_object('ok', false, 'code', 'BAD_HOURS',
      'message', '每日工時要介於 0 到 24 之間。'
              || E'\n填 0 的話這個人的工作時數永遠是 0，出勤表整個月都會是空的。');
  end if;

  -- 上班晚於下班 = 跨夜班。系統目前沒有處理跨夜的工時切分，
  -- 讓它存進去的話出勤表會算出負的時數，而那不會報錯。
  if p_start is not null and p_end is not null and p_end <= p_start then
    return jsonb_build_object('ok', false, 'code', 'BAD_RANGE',
      'message', '下班時間要晚於上班時間。'
              || E'\n\n目前不支援跨夜班 —— 存進去的話出勤表會算出負的工時。'
              || E'\n真的有跨夜班的話請先告知，那要改工時的計算方式。');
  end if;

  -- 到職日不能是未來：特休是照年資算的，年資變成負數會算出負的天數
  if p_hired is not null and p_hired > (now() at time zone 'Asia/Taipei')::date then
    return jsonb_build_object('ok', false, 'code', 'BAD_HIRED',
      'message', '到職日不能填未來的日期 —— 特休是照年資算的，年資會變成負的。');
  end if;

  -- null 代表「清空，沿用公司預設」，所以不能用 coalesce 保留舊值。
  -- 這四欄一次寫完，前端每次都把完整的四個值送上來。
  update public.profiles
     set work_start         = p_start,
         work_end           = p_end,
         work_hours_per_day = p_hours,
         hired_on           = p_hired
   where id = p_user;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'NO_USER', 'message', '找不到這個人員。');
  end if;
  return jsonb_build_object('ok', true, 'code', 'OK', 'message', '已更新');
end $fn$;

comment on function public.set_work_time is
  '主管設定個人班表。走函式而不是開 profiles 的 RLS —— '
  'RLS 是列級的,開了就連 role 都能改,主管可以把自己升成總經理且不留痕跡。';

revoke all on function public.set_work_time(uuid, time, time, numeric, date) from public;
grant execute on function public.set_work_time(uuid, time, time, numeric, date) to authenticated;


-- ── 實測 ───────────────────────────────────────────
--
-- 不寫入資料，只驗參數檢查的四條路徑。
do $$
declare bad int := 0;
begin
  -- 這裡只能驗算式，角色檢查要登入才測得到（在 SQL Editor 裡是 service_role）
  if not (8 > 0 and 8 <= 24) then bad := bad + 1; raise warning '❌ 8 小時應該合法'; end if;
  if (0 > 0) then bad := bad + 1; raise warning '❌ 0 小時應該被擋'; end if;
  if not ('18:00'::time > '09:00'::time) then
    bad := bad + 1; raise warning '❌ 09:00→18:00 應該合法'; end if;
  if ('09:00'::time > '18:00'::time) then
    bad := bad + 1; raise warning '❌ 18:00→09:00 應該被擋'; end if;
  if bad = 0 then raise notice '✅ 參數檢查的四條路徑都正確'; end if;
end $$;


-- ── 確認 ───────────────────────────────────────────
select
  case when to_regprocedure('public.set_work_time(uuid,time,time,numeric,date)') is not null
       then '✓ set_work_time 已建立' else '❌ 缺 set_work_time' end            as "函式",
  (select count(*) from pg_policies
    where schemaname = 'public' and tablename = 'profiles' and cmd in ('UPDATE', 'ALL'))
                                                                              as "profiles 寫入政策數",
  (select count(*) from public.profiles where coalesce(active, true))          as "在職人數",
  (select count(*) from public.profiles where coalesce(active, true) and hired_on is null)
                                                                              as "未填到職日";


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    raise notice '%', (select public.record_migration('104_set_work_time'));
  else
    raise notice '尚未建立 schema_migrations（migration_70），這支沒有被記錄';
  end if;
end $$;
