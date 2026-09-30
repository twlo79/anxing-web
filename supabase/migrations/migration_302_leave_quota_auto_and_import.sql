/* ══════════════════════════════════════════════════════════════════════
 * migration_302  假別額度只記「應有」：公司多給全公司統一、年假與補休自動算、
 *                上線前紀錄匯入                                          2026-09-29
 *
 * 【為什麼】David（2026-09-29）：
 *   「公司多給是統一的」「這邊只計應該有的假，不要算請多少」
 *   「概念是 應有假 − 請假 ＝ 剩餘假，然後可以往前看考勤的狀況」
 *   「補休、請假狀況獨自一張，這些是 +/− 的關係」
 *   「之前的病假、補休假、加班、特休請假的計入」→ Excel 匯入
 *
 * 【這支做什麼】
 *   1. work_settings 加 annual_extra_days（公司多給，全公司一個數，單位「天」）。
 *      初始值從既有的「公司特休」額度推：4 個人都填一樣的話就用那個數（÷ 每日工時），
 *      不一樣就 0 並在自檢裡標 ⚠（要人來決定，不猜）。
 *   2. 「公司特休」假別停用；它的請假單改記到年假（歷史不消失）。
 *   3. 年假應有 ＝ 法定（勞基法 38 條，年資算到當年 12/31）＋ 公司多給，
 *      由 ensure_leave_quotas(年) 寫進 leave_balances.quota_hours ——
 *      request_leave_batch() 擋額度時讀的還是同一欄，那支一個字都不用改。
 *      到職日、每日工時、公司多給一改就自動重算（觸發器）；前端載入時也叫一次
 *      （跨年那天才有新一年的列）。
 *   4. 補休額度 ＝ 當年已核可的加班時數，加班單一有變動就重算（觸發器）。
 *      已請補休走原本的 used_hours；餘額 ＝ quota − used，請超過會被原本的守衛擋。
 *   5. import_leave_history(jsonb)：主管／總經理把上線前的紀錄整批倒進來 ——
 *      請假進 leave_requests（已核可、事由開頭「上線前匯入」）、加班進 overtime_requests。
 *      同一人同一天已有單就跳過（skip），一列壞不影響其他列（逐列 savepoint）。
 *      delete_imported_leave(id, kind)：只刪得掉匯入的那種（事由開頭「上線前匯入」）。
 *
 * 【假設】未滿 6 個月的新人也拿公司多給（稿子當「也給」，David 沒說不）。
 *   要改成「滿 6 個月才給」：annual_quota_hours() 裡那個 case 改一行即可。
 *
 * 【不動的】request_leave_batch、leave_hours_between、原本重算 used_hours 的機制。
 *
 * ★★ 自檢在 commit 後面 —— 看不到那張表就是整支回滾了。
 * ══════════════════════════════════════════════════════════ */

begin;

-- ── 1. 公司多給（全公司統一） ─────────────────────────────
alter table public.work_settings
  add column if not exists annual_extra_days numeric not null default 0;
comment on column public.work_settings.annual_extra_days is
  '公司多給的年假天數，全公司一個數（migration_302）。年假應有 ＝ 法定 ＋ 這個。';

create temp table _m302 (k text primary key, v text);

do $$
declare
  yr    int := extract(year from (now() at time zone 'Asia/Taipei'))::int;
  n_val int; v numeric; hpd numeric;
begin
  select work_hours_per_day into hpd from public.work_settings where id = 1;
  -- 既有「公司特休」額度：只看今年、只看在職的人
  select count(distinct b.quota_hours), min(b.quota_hours) into n_val, v
    from public.leave_balances b join public.profiles p on p.id = b.user_id
   where b.type_code = 'company_annual' and b.year = yr and p.active and b.quota_hours > 0;
  if n_val = 1 then
    update public.work_settings set annual_extra_days = round(v / hpd, 2) where id = 1;
    insert into _m302 values ('extra_from', format('%s 人的公司特休都是 %s 小時 → 公司多給 %s 天',
      (select count(*) from public.leave_balances b join public.profiles p on p.id = b.user_id
        where b.type_code = 'company_annual' and b.year = yr and p.active and b.quota_hours > 0), v, round(v / hpd, 2)));
  elsif n_val = 0 then
    insert into _m302 values ('extra_from', '沒有人填過公司特休 → 公司多給先設 0，到「管理 → 假別額度」填');
  else
    insert into _m302 values ('extra_from', format('⚠ 公司特休有 %s 種不同的額度，不猜 → 公司多給先設 0，到「管理 → 假別額度」填', n_val));
  end if;
end $$;

-- ── 2. 公司特休停用、假單併進年假 ─────────────────────────
update public.leave_types set active = false,
  note = coalesce(note, '') || '（migration_302 停用：公司多給併進年假，改在 work_settings.annual_extra_days）'
 where code = 'company_annual';

do $$
declare n int;
begin
  update public.leave_requests set type_code = 'annual' where type_code = 'company_annual';
  get diagnostics n = row_count;
  insert into _m302 values ('moved_req', n::text);
end $$;

-- ── 3. 法定特休（資料庫版，跟 lib/annual-leave.ts 同一套規則） ───
create or replace function public.statutory_annual_days(p_hired date, p_asof date)
returns numeric language plpgsql stable as $fn$
declare
  m   int;
  top record;
  r   record;
begin
  if p_hired is null or p_asof is null or p_asof < p_hired then return null; end if;
  -- 足月：age() 到了同一個日子才算一個月（1/31 → 2/28 是 0 個月）
  m := (extract(year from age(p_asof, p_hired)) * 12 + extract(month from age(p_asof, p_hired)))::int;
  select threshold_months, days into top from public.leave_seniority order by threshold_months desc limit 1;
  if top.threshold_months is not null and top.threshold_months >= 120 and m >= top.threshold_months then
    -- 10 年以上：每多滿一年 +1，滿 10 年那年先 +1（15 → 16），上限 30
    return least(30, top.days + floor((m - top.threshold_months) / 12.0) + 1);
  end if;
  for r in select threshold_months, days from public.leave_seniority order by threshold_months desc loop
    if m >= r.threshold_months then return r.days; end if;
  end loop;
  return 0;
end $fn$;
comment on function public.statutory_annual_days(date, date) is
  '勞基法 38 條特休天數（級距在 leave_seniority）。跟 src/lib/annual-leave.ts annualLeaveDays() 同一套規則 —— 改一邊要改另一邊。';

-- 年假應有（小時）＝（法定 ＋ 公司多給）× 每日工時。沒到職日回 null（＝算不出來，不是 0）
create or replace function public.annual_quota_hours(p_user uuid, p_year int)
returns numeric language sql stable as $fn$
  select case
           when p.hired_on is null then null
           when public.statutory_annual_days(p.hired_on, make_date(p_year, 12, 31)) is null then null
           else round((public.statutory_annual_days(p.hired_on, make_date(p_year, 12, 31))
                       + w.annual_extra_days)                       -- ★ 未滿 6 個月也給公司多給（假設）
                      * coalesce(p.work_hours_per_day, w.work_hours_per_day), 2)
         end
    from public.profiles p, public.work_settings w
   where p.id = p_user and w.id = 1
$fn$;

-- ── 4. 補休額度 ＝ 當年已核可加班 ─────────────────────────
create or replace function public.refresh_comp_quota(p_user uuid, p_year int)
returns void language plpgsql security definer set search_path = public as $fn$
declare h numeric;
begin
  select coalesce(sum(hours), 0) into h from public.overtime_requests
   where user_id = p_user and status = 'approved' and extract(year from work_date)::int = p_year;
  insert into public.leave_balances (user_id, year, type_code, quota_hours, note)
  values (p_user, p_year, 'comp', h, '＝今年已核可的加班時數，系統自動算（migration_302）')
  on conflict (user_id, year, type_code) do update
    set quota_hours = excluded.quota_hours, updated_at = clock_timestamp()
    where leave_balances.quota_hours is distinct from excluded.quota_hours;
end $fn$;

create or replace function public.trg_ot_comp_quota() returns trigger
language plpgsql security definer set search_path = public as $fn$
begin
  if tg_op in ('INSERT', 'UPDATE') then
    perform public.refresh_comp_quota(new.user_id, extract(year from new.work_date)::int);
  end if;
  if tg_op in ('DELETE', 'UPDATE') then
    perform public.refresh_comp_quota(old.user_id, extract(year from old.work_date)::int);
  end if;
  return null;
end $fn$;
drop trigger if exists trg_ot_comp_quota on public.overtime_requests;
create trigger trg_ot_comp_quota
  after insert or update or delete on public.overtime_requests
  for each row execute function public.trg_ot_comp_quota();

-- ── 5. 已請時數重算（匯入與搬單之後用；跟原本的 recalc 算同一件事） ─
create or replace function public.recount_leave_used(p_user uuid, p_year int, p_type text)
returns void language plpgsql security definer set search_path = public as $fn$
declare h numeric;
begin
  select coalesce(sum(hours), 0) into h from public.leave_requests
   where user_id = p_user and type_code = p_type and status = 'approved'
     and extract(year from (start_at at time zone 'Asia/Taipei'))::int = p_year;
  insert into public.leave_balances (user_id, year, type_code, quota_hours, used_hours)
  values (p_user, p_year, p_type, 0, h)
  on conflict (user_id, year, type_code) do update
    set used_hours = excluded.used_hours, updated_at = clock_timestamp()
    where leave_balances.used_hours is distinct from excluded.used_hours;
end $fn$;

-- ── 6. 把每個人的「應有」寫進 leave_balances ───────────────
create or replace function public.ensure_leave_quotas(p_year int default null)
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare
  yr  int := coalesce(p_year, extract(year from (now() at time zone 'Asia/Taipei'))::int);
  r   record;
  q   numeric;
  n_a int := 0; n_c int := 0;
begin
  if yr < 2000 or yr > 2100 then return jsonb_build_object('ok', false, 'message', '年度不對'); end if;
  -- 年假
  for r in select id from public.profiles where active and hired_on is not null loop
    q := public.annual_quota_hours(r.id, yr);
    if q is null then continue; end if;
    insert into public.leave_balances (user_id, year, type_code, quota_hours, note)
    values (r.id, yr, 'annual', q, '應有＝法定＋公司多給，系統自動算（migration_302）')
    on conflict (user_id, year, type_code) do update
      set quota_hours = excluded.quota_hours, note = excluded.note, updated_at = clock_timestamp()
      where leave_balances.quota_hours is distinct from excluded.quota_hours;
    if found then n_a := n_a + 1; end if;
  end loop;
  -- 補休：有加班單的、或已經有補休列的，全部對一次
  for r in
    select u.user_id from (
      select user_id from public.overtime_requests where extract(year from work_date)::int = yr
      union
      select user_id from public.leave_balances where year = yr and type_code = 'comp'
    ) u
  loop
    perform public.refresh_comp_quota(r.user_id, yr);
    n_c := n_c + 1;
  end loop;
  return jsonb_build_object('ok', true, 'year', yr, 'annual_changed', n_a, 'comp_checked', n_c);
end $fn$;
grant execute on function public.ensure_leave_quotas(int) to authenticated;

-- 到職日／工時／在職 一改、公司多給或每日工時一改 → 今年與明年重算
create or replace function public.trg_leave_quota_refresh() returns trigger
language plpgsql security definer set search_path = public as $fn$
declare yr int := extract(year from (now() at time zone 'Asia/Taipei'))::int;
begin
  perform public.ensure_leave_quotas(yr);
  perform public.ensure_leave_quotas(yr + 1);
  return null;
end $fn$;
drop trigger if exists trg_profiles_leave_quota on public.profiles;
create trigger trg_profiles_leave_quota
  after update of hired_on, work_hours_per_day, active on public.profiles
  for each statement execute function public.trg_leave_quota_refresh();
drop trigger if exists trg_ws_leave_quota on public.work_settings;
create trigger trg_ws_leave_quota
  after update of annual_extra_days, work_hours_per_day on public.work_settings
  for each statement execute function public.trg_leave_quota_refresh();

-- 這支跑的當下就算一次（今年＋明年），搬過去的公司特休假單也重算年假已請
do $$
declare yr int := extract(year from (now() at time zone 'Asia/Taipei'))::int; r record;
begin
  perform public.ensure_leave_quotas(yr);
  perform public.ensure_leave_quotas(yr + 1);
  for r in select distinct user_id, extract(year from (start_at at time zone 'Asia/Taipei'))::int as y
             from public.leave_requests where type_code = 'annual' and status = 'approved' loop
    perform public.recount_leave_used(r.user_id, r.y, 'annual');
  end loop;
end $$;

-- ── 7. 匯入上線前紀錄 ─────────────────────────────────────
/*
 * p_rows：[{ "user_id": uuid, "d": "2026-03-12", "kind": "annual"|"sick"|…|"overtime", "hours": 8, "note": "…" }, …]
 * 回：{ ok, inserted, skipped, errors, rows: [{ i, status: 'ok'|'skip'|'error', message }] }
 *
 * ★ 逐列 savepoint：一列壞（假別不存在、重疊）只算那一列 error，其他照進。
 * ★ 同一人同一天已有單（送審中或已核可）→ skip，不蓋、不重複。
 * ★ 時段：請假從上班時間起算、跨午休就跳過午休、最晚到下班；加班從下班時間起算。
 *   時數以檔案填的為準（那是人事記的），時段只是為了重疊檢查與日曆顯示。
 */
create or replace function public.import_leave_history(p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare
  uid     uuid := auth.uid();
  role_   text;
  it      jsonb;
  i       int := 0;
  r_user  uuid; r_date date; r_kind text; r_hours numeric; r_note text; r_reason text;
  ws      record;
  ts_s    timestamptz; ts_e timestamptz; lunch interval;
  n_ins   int := 0; n_skip int := 0; n_err int := 0;
  results jsonb := '[]'::jsonb;
  touched text[] := '{}';
  k       text;
  clash   text;
begin
  if uid is null then
    return jsonb_build_object('ok', false, 'message', '請重新登入');
  end if;
  select role into role_ from public.profiles where id = uid;
  if role_ is null or role_ not in ('manager', 'super_admin') then
    return jsonb_build_object('ok', false, 'message', '只有主管與總經理可以匯入');
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    return jsonb_build_object('ok', false, 'message', '沒有東西可以匯入');
  end if;

  for it in select * from jsonb_array_elements(p_rows) loop
    i := i + 1;
    begin
      r_user  := (it->>'user_id')::uuid;
      r_date  := (it->>'d')::date;
      r_kind  := btrim(it->>'kind');
      r_hours := round((it->>'hours')::numeric, 2);
      r_note  := nullif(btrim(coalesce(it->>'note', '')), '');
      if r_user is null or r_date is null or r_kind is null or r_hours is null then
        raise exception '欄位不完整';
      end if;
      if r_hours <= 0 or r_hours > 24 then
        raise exception '小時要在 0 ～ 24 之間';
      end if;
      if not exists (select 1 from public.profiles where id = r_user) then
        raise exception '找不到這個人';
      end if;
      select * into ws from public.effective_work_settings(r_user);
      r_reason := '上線前匯入' || coalesce('：' || r_note, '');

      if r_kind = 'overtime' then
        if exists (select 1 from public.overtime_requests
                    where user_id = r_user and work_date = r_date and status in ('pending', 'approved')) then
          n_skip := n_skip + 1;
          results := results || jsonb_build_object('i', i, 'status', 'skip', 'message', '那天已經有加班單');
          continue;
        end if;
        ts_s := (r_date::text || ' ' || ws.work_end::text)::timestamp at time zone 'Asia/Taipei';
        ts_e := ts_s + make_interval(mins => round(r_hours * 60)::int);
        insert into public.overtime_requests
          (user_id, work_date, start_at, end_at, hours, reason, status, manager_by, manager_at)
        values (r_user, r_date, ts_s, ts_e, r_hours, r_reason, 'approved', uid, clock_timestamp());
      else
        if not exists (select 1 from public.leave_types where code = r_kind) then
          raise exception '假別 % 不存在', r_kind;
        end if;
        ts_s := (r_date::text || ' ' || ws.work_start::text)::timestamp at time zone 'Asia/Taipei';
        ts_e := ts_s + make_interval(mins => round(r_hours * 60)::int);
        lunch := ws.lunch_end - ws.lunch_start;
        if (ts_e at time zone 'Asia/Taipei')::time > ws.lunch_start then ts_e := ts_e + lunch; end if;
        if (ts_e at time zone 'Asia/Taipei')::time > ws.work_end
           or (ts_e at time zone 'Asia/Taipei')::date > r_date then
          ts_e := (r_date::text || ' ' || ws.work_end::text)::timestamp at time zone 'Asia/Taipei';
        end if;
        select lt.name into clash from public.leave_requests r join public.leave_types lt on lt.code = r.type_code
         where r.user_id = r_user and r.status in ('pending', 'approved')
           and tstzrange(r.start_at, r.end_at) && tstzrange(ts_s, ts_e)
         limit 1;
        if clash is not null then
          n_skip := n_skip + 1;
          results := results || jsonb_build_object('i', i, 'status', 'skip', 'message', format('那天已經有%s單', clash));
          continue;
        end if;
        insert into public.leave_requests
          (user_id, type_code, start_at, end_at, hours, reason, status, manager_by, manager_at, admin_by, admin_at)
        values (r_user, r_kind, ts_s, ts_e, r_hours, r_reason, 'approved',
                uid, clock_timestamp(), uid, clock_timestamp());
        touched := touched || (r_user::text || '|' || extract(year from r_date)::int || '|' || r_kind);
      end if;
      n_ins := n_ins + 1;
      results := results || jsonb_build_object('i', i, 'status', 'ok');
    exception when others then
      n_err := n_err + 1;
      results := results || jsonb_build_object('i', i, 'status', 'error', 'message', sqlerrm);
    end;
  end loop;

  for k in select distinct unnest(touched) loop
    perform public.recount_leave_used(split_part(k, '|', 1)::uuid, split_part(k, '|', 2)::int, split_part(k, '|', 3));
  end loop;

  return jsonb_build_object('ok', true, 'inserted', n_ins, 'skipped', n_skip, 'errors', n_err, 'rows', results);
end $fn$;
grant execute on function public.import_leave_history(jsonb) to authenticated;

-- 只刪得掉匯入的那種（事由開頭「上線前匯入」）—— 正常送審的單走原本的取消
create or replace function public.delete_imported_leave(p_id uuid, p_kind text)
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare
  uid   uuid := auth.uid();
  role_ text;
  n     int;
  r_user uuid; r_year int; r_type text;
begin
  select role into role_ from public.profiles where id = uid;
  if role_ is null or role_ not in ('manager', 'super_admin') then
    return jsonb_build_object('ok', false, 'message', '只有主管與總經理可以刪');
  end if;
  if p_kind = 'overtime' then
    delete from public.overtime_requests where id = p_id and reason like '上線前匯入%';
    get diagnostics n = row_count;
  else
    select user_id, extract(year from (start_at at time zone 'Asia/Taipei'))::int, type_code
      into r_user, r_year, r_type
      from public.leave_requests where id = p_id and reason like '上線前匯入%';
    delete from public.leave_requests where id = p_id and reason like '上線前匯入%';
    get diagnostics n = row_count;
    if n = 1 then perform public.recount_leave_used(r_user, r_year, r_type); end if;
  end if;
  if n <> 1 then
    return jsonb_build_object('ok', false, 'message', '找不到這筆，或它不是匯入的紀錄（正常送審的單請走取消）');
  end if;
  return jsonb_build_object('ok', true);
end $fn$;
grant execute on function public.delete_imported_leave(uuid, text) to authenticated;

do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('302_leave_quota_auto_and_import');
  end if;
end $do$;

commit;

-- ═══ 自檢（在 commit 後面 —— 看不到這張表就是整支回滾了） ═══════════
with yr as (select extract(year from (now() at time zone 'Asia/Taipei'))::int as y)
select 1 as 序, '這支跑過了沒' as 檢查,
       (select count(*)::text from public.schema_migrations where name = '302_leave_quota_auto_and_import') as 結果,
       case when exists (select 1 from public.schema_migrations where name = '302_leave_quota_auto_and_import') then '✅' else '❌' end as 判定
union all select 2, '母體：在職的人（是 0 的話下面全部不算數）',
       (select count(*)::text from public.profiles where active),
       case when (select count(*) from public.profiles where active) > 0 then '✅' else '⚠ 沒有東西可檢查' end
union all select 3, '公司多給（天）從哪來',
       (select v from _m302 where k = 'extra_from'),
       case when (select v from _m302 where k = 'extra_from') like '⚠%' then '⚠ 要人決定' else '✅' end
union all select 4, '公司多給現在是幾天',
       (select annual_extra_days::text from public.work_settings where id = 1), 'ℹ 到「管理 → 假別額度」可改'
union all select 5, '公司特休停用了沒',
       (select active::text from public.leave_types where code = 'company_annual'),
       case when (select active from public.leave_types where code = 'company_annual') = false then '✅' else '❌' end
union all select 6, '公司特休的假單搬到年假（筆）',
       (select v from _m302 where k = 'moved_req'), 'ℹ 歷史不消失'
union all select 7, '在職且有到職日的人，今年都有年假應有列',
       (select count(*)::text || ' / ' || (select count(*) from public.profiles where active and hired_on is not null)
          from public.leave_balances b join public.profiles p on p.id = b.user_id, yr
         where p.active and p.hired_on is not null and b.type_code = 'annual' and b.year = yr.y),
       case when (select count(*) from public.leave_balances b join public.profiles p on p.id = b.user_id, yr
                   where p.active and p.hired_on is not null and b.type_code = 'annual' and b.year = yr.y)
                 = (select count(*) from public.profiles where active and hired_on is not null)
            then '✅' else '❌ 有人沒算到' end
union all select 8, '今年每個人的年假應有（小時）',
       coalesce((select string_agg(p.name || ' ' || b.quota_hours, '、' order by p.name)
                   from public.leave_balances b join public.profiles p on p.id = b.user_id, yr
                  where p.active and b.type_code = 'annual' and b.year = yr.y), '（沒有）'),
       'ℹ ＝（法定 ＋ 公司多給）× 每日工時'
union all select 9, '沒填到職日的在職者（算不出年假）',
       coalesce((select string_agg(name, '、' order by name) from public.profiles where active and hired_on is null), '沒有'),
       case when exists (select 1 from public.profiles where active and hired_on is null) then '⚠ 到「管理 → 假別額度」填到職日' else '✅' end
union all select 10, '補休額度 ＝ 今年已核可加班（對不上的人數）',
       (select count(*)::text from (
          select o.user_id, sum(o.hours) as h from public.overtime_requests o, yr
           where o.status = 'approved' and extract(year from o.work_date)::int = yr.y group by o.user_id) t
          left join public.leave_balances b on b.user_id = t.user_id and b.type_code = 'comp' and b.year = (select y from yr)
         where b.quota_hours is distinct from t.h),
       case when (select count(*) from (
          select o.user_id, sum(o.hours) as h from public.overtime_requests o, yr
           where o.status = 'approved' and extract(year from o.work_date)::int = yr.y group by o.user_id) t
          left join public.leave_balances b on b.user_id = t.user_id and b.type_code = 'comp' and b.year = (select y from yr)
         where b.quota_hours is distinct from t.h) = 0 then '✅' else '❌' end
union all select 11, '函式都在（要 7）',
       (select count(*)::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.prokind in ('f','p')
           and p.proname in ('statutory_annual_days','annual_quota_hours','ensure_leave_quotas','refresh_comp_quota','recount_leave_used','import_leave_history','delete_imported_leave')),
       case when (select count(distinct p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.prokind in ('f','p')
           and p.proname in ('statutory_annual_days','annual_quota_hours','ensure_leave_quotas','refresh_comp_quota','recount_leave_used','import_leave_history','delete_imported_leave')) = 7 then '✅' else '❌' end
union all select 12, '觸發器都在（要 3）',
       (select count(*)::text from pg_trigger where tgname in ('trg_ot_comp_quota','trg_profiles_leave_quota','trg_ws_leave_quota') and not tgisinternal),
       case when (select count(*) from pg_trigger where tgname in ('trg_ot_comp_quota','trg_profiles_leave_quota','trg_ws_leave_quota') and not tgisinternal) = 3 then '✅' else '❌' end
union all select 13, '法定算法抽查：2023-03-01 到職、算到 2026-12-31（要 14）',
       public.statutory_annual_days('2023-03-01', '2026-12-31')::text,
       case when public.statutory_annual_days('2023-03-01', '2026-12-31') = 14 then '✅' else '❌ 跟 lib/annual-leave.ts 不一致' end
union all select 14, '法定算法抽查：2016-06-01 到職、算到 2026-12-31（要 16）',
       public.statutory_annual_days('2016-06-01', '2026-12-31')::text,
       case when public.statutory_annual_days('2016-06-01', '2026-12-31') = 16 then '✅' else '❌' end
order by 1;
