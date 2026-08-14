-- migration_118：建議可以「套用」、可以「忽略」，而且查得到歷史
--
-- ============================================================
-- 【三件事】
--
--   1. 一鍵套用   金額與住宿起訖，按一下就把 Airbnb 的值寫進訂單
--   2. 忽略       確認沒問題的，按掉。但**數字再變就重新跳出來**
--   3. 一生       每條建議何時出現、何時消失、怎麼消失的
--
--
-- ============================================================
-- 【忽略為什麼要記「當時的值」】
--
-- 忽略的是「這個差額」，不是「這筆訂單」。
--
-- 只記「這條被忽略了」的話，同一筆訂單之後**真的**被改了金額，
-- 那條建議會被當成同一條而永遠不再出現 —— 等於一次忽略把那筆訂單
-- 永久變成盲點，而且沒有人會記得自己什麼時候按過。
--
-- 所以存 dismissed_sig（忽略當下的 from|to）。下一輪算出來的簽章
-- 只要不一樣，就把 dismissed 清掉讓它重新跳出來。
--
--
-- ============================================================
-- 【為什麼歷史要存「一生」而不是每天一份快照】
--
-- 每天存一份的話，同一個問題掛一週就有七列 —— 那正是 migration_113
-- 當初把 sync_issues 做成自清清單、而不是流水帳的原因。
--
-- 存一生就沒有這個問題：一條建議一列，出現時開一列，消失時補上
-- 消失時間與消失原因。查「8/14 有哪些建議」是一個區間查詢，
-- 查「這筆訂單被處理過幾次」也是一個查詢。
--
--
-- ============================================================
-- 【套用為什麼要留痕跡】
--
-- 套用會改到營收數字。它必須跟人工編輯一樣進 data_audit ——
-- 而且它**本來就是**人工編輯：是人看過建議之後按下去的。
--
-- 副作用是那筆訂單之後被標記為 manually_edited，爬蟲更不會動它。
-- 那是對的：人已經確認過那個數字了。

-- ============================================================
-- 一、忽略
-- ============================================================
alter table public.sync_issues
  add column if not exists dismissed_at  timestamptz,
  add column if not exists dismissed_by  uuid references public.profiles(id),
  /** 忽略當下的 from|to。跟現在算出來的不一樣就代表數字又變了 */
  add column if not exists dismissed_sig text;

comment on column public.sync_issues.dismissed_sig is
  '忽略當下的「from|to」。下一輪簽章不同就清掉 dismissed —— '
  '忽略的是這個差額，不是這筆訂單。';

create index if not exists idx_sync_issues_open
  on public.sync_issues (kind, severity)
  where dismissed_at is null;


-- ============================================================
-- 二、每條建議的一生
-- ============================================================
create table if not exists public.sync_issue_log (
  id          bigserial primary key,
  kind        text not null,
  code        text not null,
  field       text not null,
  from_val    text,
  to_val      text,
  reason      text,
  severity    text,
  /** 這條建議第一次出現的時間 */
  opened_at   timestamptz not null,
  closed_at   timestamptz not null default now(),
  /**
   * 怎麼消失的：
   *   applied   人按了套用，值已經寫進訂單
   *   dismissed 人按了忽略
   *   resolved  下一輪同步沒再出現（自己好了，或被人手動改好了）
   */
  resolution  text not null,
  acted_by    uuid references public.profiles(id)
);

comment on table public.sync_issue_log is
  '每條同步建議的一生：何時出現、何時消失、怎麼消失的。'
  '不是每天一份快照 —— 那樣同一個問題掛一週就有七列。';

create index if not exists idx_sync_issue_log_closed
  on public.sync_issue_log (closed_at desc);
create index if not exists idx_sync_issue_log_code
  on public.sync_issue_log (code);

alter table public.sync_issue_log enable row level security;
drop policy if exists sil_read on public.sync_issue_log;
create policy sil_read on public.sync_issue_log
  for select using (auth.role() = 'authenticated');


-- ============================================================
-- 三、record_sync_run：忽略要會失效，消失要寫進歷史
-- ============================================================
create or replace function public.record_sync_run(
  p_kind text, p_counts jsonb, p_issues jsonb
) returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare
  /*
   * 【一定要用 clock_timestamp()，不能用 now()】
   * now() 是交易開始時間，同一交易裡呼叫兩次會讓「刪掉沒再出現的」
   * 一列都刪不掉，清單只增不減且完全不報錯。詳見 migration_113。
   */
  v_now  timestamptz := clock_timestamp();
  v_run  bigint;
  v_kept int;
  v_gone int;
begin
  if p_kind is null or p_kind = '' then
    return jsonb_build_object('ok', false, 'message', 'kind 不能是空的');
  end if;

  insert into sync_runs (at, kind, received, inserted, updated, voided, skipped, detail,
                         scan_from, scan_to)
  values (
    v_now, p_kind,
    coalesce((p_counts->>'received')::int, 0),
    coalesce((p_counts->>'inserted')::int, 0),
    coalesce((p_counts->>'updated')::int, 0),
    coalesce((p_counts->>'voided')::int, 0),
    coalesce((p_counts->>'skipped')::int, 0),
    coalesce(p_counts->'detail', '{}'::jsonb),
    nullif(p_counts->>'scanFrom', '')::date,
    nullif(p_counts->>'scanTo', '')::date
  ) returning id into v_run;

  insert into sync_issues (
    kind, code, field, first_seen, last_seen,
    from_val, to_val, listing_id, extra,
    severity, reason, airbnb_changed)
  select
    p_kind, x->>'code', x->>'field', v_now, v_now,
    x->>'from', x->>'to', x->>'listingId',
    coalesce(x->'extra', '{}'::jsonb),
    coalesce(x->>'severity', 'mid'),
    x->>'reason',
    coalesce((x->>'airbnbChanged')::boolean, false)
  from jsonb_array_elements(coalesce(p_issues, '[]'::jsonb)) x
  where coalesce(x->>'code', '') <> '' and coalesce(x->>'field', '') <> ''
  on conflict (kind, code, field) do update set
    last_seen      = excluded.last_seen,
    from_val       = excluded.from_val,
    to_val         = excluded.to_val,
    listing_id     = excluded.listing_id,
    extra          = excluded.extra,
    severity       = excluded.severity,
    reason         = excluded.reason,
    airbnb_changed = excluded.airbnb_changed,
    /*
     * 數字又變了就把「忽略」清掉，讓它重新跳出來。
     *
     * 忽略的是那個差額，不是那筆訂單 —— 不清的話，一次忽略
     * 會把那筆訂單永久變成盲點，而且沒有人會記得自己按過。
     */
    dismissed_at  = case when sync_issues.dismissed_sig
                           is distinct from coalesce(excluded.from_val,'') || '|' || coalesce(excluded.to_val,'')
                         then null else sync_issues.dismissed_at end,
    dismissed_by  = case when sync_issues.dismissed_sig
                           is distinct from coalesce(excluded.from_val,'') || '|' || coalesce(excluded.to_val,'')
                         then null else sync_issues.dismissed_by end,
    dismissed_sig = case when sync_issues.dismissed_sig
                           is distinct from coalesce(excluded.from_val,'') || '|' || coalesce(excluded.to_val,'')
                         then null else sync_issues.dismissed_sig end;
    -- first_seen 刻意不動 —— 「這個問題放多久了」是要看的資訊
  get diagnostics v_kept = row_count;

  -- 這一輪沒再出現的 = 解決了。先寫進歷史，再刪。
  insert into sync_issue_log
    (kind, code, field, from_val, to_val, reason, severity, opened_at, closed_at, resolution)
  select kind, code, field, from_val, to_val, reason, severity, first_seen, v_now, 'resolved'
  from sync_issues where kind = p_kind and last_seen < v_now;

  delete from sync_issues where kind = p_kind and last_seen < v_now;
  get diagnostics v_gone = row_count;

  return jsonb_build_object(
    'ok', true, 'run_id', v_run, 'open', v_kept, 'resolved', v_gone);
end $fn$;

revoke all on function public.record_sync_run(text, jsonb, jsonb) from public;


-- ============================================================
-- 四、忽略一條建議
-- ============================================================
create or replace function public.dismiss_sync_issue(
  p_kind text, p_code text, p_field text
) returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare r sync_issues;
begin
  if current_role_of() not in ('manager', 'super_admin', 'accountant') then
    return jsonb_build_object('ok', false, 'message', '你的角色不能處理同步建議');
  end if;

  select * into r from sync_issues
   where kind = p_kind and code = p_code and field = p_field;
  if not found then
    return jsonb_build_object('ok', false, 'message', '這條建議已經不在了,重新整理看看');
  end if;

  update sync_issues
     set dismissed_at  = clock_timestamp(),
         dismissed_by  = auth.uid(),
         dismissed_sig = coalesce(r.from_val, '') || '|' || coalesce(r.to_val, '')
   where kind = p_kind and code = p_code and field = p_field;

  insert into sync_issue_log
    (kind, code, field, from_val, to_val, reason, severity, opened_at, resolution, acted_by)
  values (r.kind, r.code, r.field, r.from_val, r.to_val, r.reason, r.severity,
          r.first_seen, 'dismissed', auth.uid());

  return jsonb_build_object('ok', true);
end $fn$;


-- ============================================================
-- 五、套用一條建議
-- ============================================================
--
-- 只有金額與住宿起訖能套用 —— 那兩種的 to_val 就是「該寫進去的值」。
-- 房源不給套用：房源不一致的正解是去修「房源管理」的 listing 對照表，
-- 改單一筆只是把症狀蓋掉，明天新訂單還是會掛錯。
create or replace function public.apply_sync_issue(
  p_kind text, p_code text, p_field text
) returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare
  r      sync_issues;
  v_amt  numeric;
  v_in   date;
  v_out  date;
  n      int;
begin
  if current_role_of() not in ('manager', 'super_admin', 'accountant') then
    return jsonb_build_object('ok', false, 'message', '你的角色不能處理同步建議');
  end if;

  select * into r from sync_issues
   where kind = p_kind and code = p_code and field = p_field;
  if not found then
    return jsonb_build_object('ok', false, 'message', '這條建議已經不在了,重新整理看看');
  end if;

  if r.field = '金額' then
    v_amt := nullif(r.to_val, '')::numeric;
    if v_amt is null then
      return jsonb_build_object('ok', false, 'message', '這條建議沒有可套用的金額');
    end if;
    update orders set amount = v_amt where order_key = p_code;

  elsif r.field = '住宿起訖' then
    -- to_val 長這樣：2026-07-21~2026-08-20
    v_in  := nullif(split_part(r.to_val, '~', 1), '')::date;
    v_out := nullif(split_part(r.to_val, '~', 2), '')::date;
    if v_in is null or v_out is null then
      return jsonb_build_object('ok', false, 'message', '這條建議的日期格式不對:' || coalesce(r.to_val, ''));
    end if;
    update orders
       set checkin = v_in, checkout = v_out,
           nights = greatest(v_out - v_in, 0)
     where order_key = p_code;

  else
    return jsonb_build_object('ok', false,
      'message', r.field || '不能一鍵套用。房源不一致請到「房源管理」修對照表 —— 改單一筆只是把症狀蓋掉');
  end if;

  /*
   * 【一定要檢查有沒有真的改到】
   * RLS 擋下的 update 會回「成功」而且影響 0 列 —— 不檢查的話，
   * 畫面顯示套用成功、資料一個字都沒變，而那比報錯更難查。
   */
  get diagnostics n = row_count;
  if n = 0 then
    return jsonb_build_object('ok', false, 'message', '找不到訂單 ' || p_code || ',或你沒有權限改它');
  end if;

  insert into sync_issue_log
    (kind, code, field, from_val, to_val, reason, severity, opened_at, resolution, acted_by)
  values (r.kind, r.code, r.field, r.from_val, r.to_val, r.reason, r.severity,
          r.first_seen, 'applied', auth.uid());

  -- 套用完就從清單移除。等下一輪同步才消失的話，人會以為沒生效而按第二次
  delete from sync_issues where kind = p_kind and code = p_code and field = p_field;

  return jsonb_build_object('ok', true, 'applied', r.to_val);
end $fn$;

grant execute on function public.dismiss_sync_issue(text, text, text) to authenticated;
grant execute on function public.apply_sync_issue(text, text, text)   to authenticated;


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('118_sync_actions');
  end if;
end $$;


-- ============================================================
-- 驗證
-- ============================================================
do $$
declare n int; v_dis timestamptz;
begin
  drop table if exists _chk118;
  create temp table _chk118 (ord int, item text, result text, detail text);

  insert into _chk118 values (1, 'sync_issue_log 表',
    case when to_regclass('public.sync_issue_log') is not null then '✅' else '❌' end, '');
  insert into _chk118 values (1, '忽略與套用兩支函式',
    case when to_regprocedure('public.dismiss_sync_issue(text,text,text)') is not null
          and to_regprocedure('public.apply_sync_issue(text,text,text)') is not null
         then '✅' else '❌' end, '');

  -- 忽略之後數字再變 → 要重新跳出來
  delete from sync_issues where kind = '__t118__';
  insert into sync_issues (kind, code, field, from_val, to_val, severity)
  values ('__t118__', 'X', '金額', '100', '200', 'high');
  update sync_issues set dismissed_at = clock_timestamp(), dismissed_sig = '100|200'
   where kind = '__t118__';

  -- 同樣的值再送一次 → 忽略要留著
  perform public.record_sync_run('__t118__', '{}'::jsonb,
    '[{"code":"X","field":"金額","from":"100","to":"200","severity":"high"}]'::jsonb);
  select dismissed_at into v_dis from sync_issues where kind = '__t118__';
  insert into _chk118 values (2, '★ 值沒變,忽略要留著',
    case when v_dis is not null then '✅' else '❌' end,
    '不然按了忽略隔天又冒出來,那個按鈕等於沒用');

  -- 值變了 → 忽略要失效
  perform public.record_sync_run('__t118__', '{}'::jsonb,
    '[{"code":"X","field":"金額","from":"100","to":"999","severity":"high"}]'::jsonb);
  select dismissed_at into v_dis from sync_issues where kind = '__t118__';
  insert into _chk118 values (3, '★★ 值變了,忽略要失效',
    case when v_dis is null then '✅' else '❌' end,
    '忽略的是那個差額,不是那筆訂單 —— 不失效的話一次忽略等於永久盲點');

  -- 沒再出現 → 寫進歷史再刪掉
  delete from sync_issue_log where kind = '__t118__';
  perform public.record_sync_run('__t118__', '{}'::jsonb, '[]'::jsonb);
  select count(*) into n from sync_issues where kind = '__t118__';
  insert into _chk118 values (4, '解決掉的會從清單消失',
    case when n = 0 then '✅' else '❌ 還剩 ' || n end, '');

  select count(*) into n from sync_issue_log
   where kind = '__t118__' and resolution = 'resolved';
  insert into _chk118 values (4, '★ 消失之前有寫進歷史',
    case when n = 1 then '✅' else '❌ ' || n || ' 列' end,
    '沒寫的話「昨天那條建議後來怎麼了」永遠查不到');

  delete from sync_issue_log where kind = '__t118__';
  delete from sync_issues   where kind = '__t118__';
  delete from sync_runs     where kind = '__t118__';

  select count(*) into n from sync_issues where dismissed_at is null;
  insert into _chk118 values (5, '目前還沒處理的建議', n || ' 條', '');
end $$;

select item as "檢查項目", result as "結果", detail as "說明"
from _chk118 order by ord, item;
