-- migration_113：讓爬蟲做的事看得見
--
-- ============================================================
-- 【要解決的問題】
--
-- 爬蟲每天寫進資料庫，而畫面上完全看不到它做了什麼。
--
-- 兩件事混在一起，但性質完全不同，所以分兩個地方放：
--
--   新增訂單／評價  → 少量、一次性、跟人工新增是同一種事
--                     → 進「編輯紀錄」，跟人工操作並排，多一個篩選
--
--   比對出來的差異  → 大量、會重複出現、要人去修對照表
--                     → 自己一張表、自己一個分頁，而且**會自己消失**
--
--
-- ============================================================
-- 【為什麼差異不用「一次同步一批」的方式存】
--
-- 直覺會想做成 sync_runs → sync_diffs（每次同步存一批）。那會壞掉：
--
-- 同一個「房源不一致」在對照表修好之前，每天都會再出現一次。
-- 存成流水帳的話，一週之後同一個問題有七列，而且看不出哪一列還算數。
-- 就算做一個「已處理」按鈕，隔天同步又會生一列新的 —— 按了等於沒按。
--
-- 所以 sync_issues 存的是**現在還沒解決的差異**，不是歷史：
--   每次同步把當下所有差異 upsert（last_seen = 這一輪）
--   然後刪掉這一輪沒再出現的
--
-- 結果是：對照表修好之後，那一列隔天自己不見了。
-- 清單空了就代表真的沒事了 —— 這是流水帳給不了的保證。
--
-- sync_runs 仍然存流水帳，但只存數字（新增幾筆、更新幾筆）。
-- 那個看的是趨勢：「今天怎麼新增了 80 筆」是值得查的訊號。
-- ============================================================


-- ============================================================
-- 一、編輯紀錄：讓自動新增也記下來
-- ============================================================
--
-- 原本的規則是「auth.uid() 是 null 就不記新增與修改」，理由是
-- Airbnb 每天同步幾百筆會把人工操作淹掉。
--
-- 實際跑下來，**真正新增的很少**（每天個位數）—— 量大的是「更新」。
-- 所以規則改成：
--
--   INSERT   一律記（不管是人還是爬蟲）
--   UPDATE   仍然只記人工的
--   DELETE   一律記（原本就是）
--
-- 更新為什麼還是不記：那才是每天幾百筆的來源，而且「爬蟲把金額
-- 從 20000 改成 20500」這件事在新的「同步建議」分頁看得到，
-- 不需要在編輯紀錄裡再淹一次。

create or replace function public.data_audit_log() returns trigger
language plpgsql security definer set search_path = public as $fn$
declare
  uid     uuid := auth.uid();
  diff    jsonb := '{}'::jsonb;
  k       text;
  old_j   jsonb;
  new_j   jsonb;
  lbl     text;
  rec     record;
begin
  rec := coalesce(new, old);

  -- 人看得懂的識別。每張表挑最能一眼認出是哪一筆的欄位。
  lbl := case tg_table_name
    when 'expenses'               then to_jsonb(rec)->>'item_name'
    when 'purchase_requests'      then to_jsonb(rec)->>'req_no'
    when 'purchase_request_items' then to_jsonb(rec)->>'item_name'
    when 'deposits'               then coalesce(to_jsonb(rec)->>'guest_name', to_jsonb(rec)->>'room')
    when 'orders'                 then coalesce(to_jsonb(rec)->>'guest_name', to_jsonb(rec)->>'order_key')
    when 'contracts'              then coalesce(to_jsonb(rec)->>'name', to_jsonb(rec)->>'tenant_name')
    -- 評價：姓名 ＋ 幾星。看到「Kevin ★3」就知道要不要點進去
    when 'reviews'                then coalesce(to_jsonb(rec)->>'guest_name', '(無名)')
      || coalesce(' ★' || (to_jsonb(rec)->>'overall_rating'), '')
    else null end;

  -- 金額附在識別後面，列表上不用點開就看得出輕重
  if (to_jsonb(rec) ? 'amount') then
    lbl := coalesce(lbl, '') || ' $' || coalesce((to_jsonb(rec)->>'amount'), '0');
  end if;

  if tg_op = 'DELETE' then
    -- 契約重產月租單時會先把未收的那幾期刪掉再重建，一次可能 24 筆。
    -- 那是系統在算，不是人在決定要刪什麼。
    if tg_table_name = 'orders'
       and (to_jsonb(old)->>'imported_via') = 'contract'
       and (to_jsonb(old)->>'paid') = 'false' then
      return old;
    end if;

    insert into data_audit (user_id, table_name, record_id, label, action, changes)
    values (uid, tg_table_name, old.id, lbl, 'delete', to_jsonb(old));
    return old;
  end if;

  if tg_op = 'INSERT' then
    /*
     * 契約自動產生的月租單不記。
     *
     * 一份契約按下「重整」會一次生 24 筆，那不是 24 個決定，
     * 是一個決定的結果 —— 而契約本身的編輯已經被記下來了。
     * 不擋的話一次操作就佔滿整頁，真正的新增全被推到第二頁。
     */
    if tg_table_name = 'orders' and (to_jsonb(new)->>'imported_via') = 'contract' then
      return new;
    end if;

    insert into data_audit (user_id, table_name, record_id, label, action, changes)
    values (uid, tg_table_name, new.id, lbl, 'insert', to_jsonb(new));
    return new;
  end if;

  -- UPDATE：不是人操作的就不記（每天幾百筆，看「同步建議」分頁）
  if uid is null then return new; end if;

  old_j := to_jsonb(old);
  new_j := to_jsonb(new);
  for k in select jsonb_object_keys(new_j) loop
    if old_j -> k is distinct from new_j -> k then
      diff := diff || jsonb_build_object(k, jsonb_build_array(old_j -> k, new_j -> k));
    end if;
  end loop;

  -- 沒有實際變動就不寫。前端的樂觀更新常送出一模一樣的值。
  if diff = '{}'::jsonb then return new; end if;

  insert into data_audit (user_id, table_name, record_id, label, action, changes)
  values (uid, tg_table_name, new.id, lbl, 'update', diff);
  return new;
end $fn$;


-- ── 評價也掛上觸發器 ───────────────────────────────
-- data_audit.record_id 是 uuid。reviews.id 不是 uuid 的話掛上去會在
-- 每一次同步時炸掉整個匯入 —— 所以先確認，不合就跳過並講清楚。
do $$
declare
  t text;
  id_type text;
begin
  select data_type into id_type from information_schema.columns
   where table_schema = 'public' and table_name = 'reviews' and column_name = 'id';

  foreach t in array array[
    'expenses', 'purchase_requests', 'purchase_request_items',
    'deposits', 'orders', 'contracts'
  ]
  loop
    execute format('drop trigger if exists trg_data_audit_%1$s on public.%1$I', t);
    execute format(
      'create trigger trg_data_audit_%1$s after insert or update or delete on public.%1$I
         for each row execute function public.data_audit_log()', t);
  end loop;

  if id_type = 'uuid' then
    drop trigger if exists trg_data_audit_reviews on public.reviews;
    create trigger trg_data_audit_reviews
      after insert or update or delete on public.reviews
      for each row execute function public.data_audit_log();
  end if;
end $$;


-- ============================================================
-- 二、同步流水帳（只存數字）
-- ============================================================
create table if not exists public.sync_runs (
  id         bigserial primary key,
  at         timestamptz not null default now(),
  /** 'orders' | 'reviews' */
  kind       text not null,
  received   int not null default 0,
  inserted   int not null default 0,
  updated    int not null default 0,
  voided     int not null default 0,
  skipped    int not null default 0,
  /** 各類差異的筆數，以及對不到的 listing —— 明細在 sync_issues */
  detail     jsonb not null default '{}'::jsonb
);

comment on table public.sync_runs is
  '每次爬蟲同步的數字。只存趨勢用的計數 —— 「今天怎麼新增了 80 筆」'
  '是值得查的訊號。差異明細在 sync_issues,那張表存的是「現在還沒解決的」。';

create index if not exists idx_sync_runs_at on public.sync_runs (at desc);


-- ============================================================
-- 三、還沒解決的差異（會自己消失的待辦清單）
-- ============================================================
create table if not exists public.sync_issues (
  /**
   * 同一筆訂單的同一種差異只該有一列。
   * 用 (kind, code, field) 當鍵，每次同步 upsert —— 而不是每次插一列。
   */
  kind        text not null,          -- 'orders' | 'reviews'
  code        text not null,          -- Airbnb 確認碼 / 評價 id
  field       text not null,          -- '房源' | '房客姓名' | '住宿起訖' | '待人工判斷' | '對不到房源'
  first_seen  timestamptz not null default now(),
  last_seen   timestamptz not null default now(),
  from_val    text,
  to_val      text,
  listing_id  text,
  /** 額外資訊：停用房源名稱、原因說明… */
  extra       jsonb not null default '{}'::jsonb,
  primary key (kind, code, field)
);

comment on table public.sync_issues is
  '爬蟲比對出來、還沒解決的差異。每次同步全量覆寫（沒再出現的會被刪掉）,'
  '所以對照表修好之後那一列隔天自己不見 —— 清單空了就是真的沒事了。';

create index if not exists idx_sync_issues_field on public.sync_issues (kind, field);
create index if not exists idx_sync_issues_listing on public.sync_issues (listing_id);


-- ── 權限 ───────────────────────────────────────────
-- 跟編輯紀錄同一個標準：只有總經理看得到。
-- 這兩張表會露出房客姓名與金額。
alter table public.sync_runs   enable row level security;
alter table public.sync_issues enable row level security;

drop policy if exists sync_runs_read on public.sync_runs;
create policy sync_runs_read on public.sync_runs
  for select using (current_role_of() = 'super_admin');

drop policy if exists sync_issues_read on public.sync_issues;
create policy sync_issues_read on public.sync_issues
  for select using (current_role_of() = 'super_admin');

-- 沒有寫入政策 —— 只有 service key（匯入端點）寫得進去。
-- 前端能改的話這份清單就不再是「系統看到的事實」了。


-- ============================================================
-- 四、一次同步寫完的 RPC
-- ============================================================
--
-- 【為什麼包成一支函式，而不是讓端點自己下三道指令】
--
-- 「upsert 全部 → 刪掉沒再出現的」如果分兩次網路往返，中間任何一次
-- 失敗都會留下不一致的狀態：清單裡混著新舊兩輪的資料，而且沒人看得出來。
--
-- 包成一支就是一個交易：要嘛整批換掉，要嘛完全不動。
--
-- 【p_issues 的格式】
--   [{"code":"HM123","field":"房源","from":"A15","to":"舊-A15",
--     "listingId":"117862...","extra":{...}}, ...]

create or replace function public.record_sync_run(
  p_kind text,
  p_counts jsonb,        -- {received, inserted, updated, voided, skipped, detail}
  p_issues jsonb         -- 這一輪所有還沒解決的差異
) returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare
  /*
   * 【一定要用 clock_timestamp()，不能用 now()】
   *
   * now() 回的是**交易開始的時間**，在同一個交易裡永遠是同一個值。
   * 所以同一個交易裡呼叫兩次的話，第二次寫進去的 last_seen 會等於
   * 第一次的，而「刪掉 last_seen < v_now 的」就一列都刪不掉 ——
   * 待辦清單會只增不減，而且完全不報錯。
   *
   * 正式跑的時候兩次同步各自是一個交易，用 now() 剛好會過；
   * 這個 bug 只有在同一個交易裡連續呼叫時才會現形 ——
   * 也就是說，沒有下面那段驗證就永遠不會有人發現。
   *
   * clock_timestamp() 回的是真正的當下，交易裡也會往前走。
   */
  v_now  timestamptz := clock_timestamp();
  v_run  bigint;
  v_kept int;
  v_gone int;
begin
  if p_kind is null or p_kind = '' then
    return jsonb_build_object('ok', false, 'message', 'kind 不能是空的');
  end if;

  insert into sync_runs (at, kind, received, inserted, updated, voided, skipped, detail)
  values (
    v_now, p_kind,
    coalesce((p_counts->>'received')::int, 0),
    coalesce((p_counts->>'inserted')::int, 0),
    coalesce((p_counts->>'updated')::int, 0),
    coalesce((p_counts->>'voided')::int, 0),
    coalesce((p_counts->>'skipped')::int, 0),
    coalesce(p_counts->'detail', '{}'::jsonb)
  ) returning id into v_run;

  -- 這一輪看到的差異：有就更新 last_seen，沒有就新增
  insert into sync_issues (kind, code, field, first_seen, last_seen, from_val, to_val, listing_id, extra)
  select
    p_kind,
    x->>'code',
    x->>'field',
    v_now, v_now,
    x->>'from', x->>'to', x->>'listingId',
    coalesce(x->'extra', '{}'::jsonb)
  from jsonb_array_elements(coalesce(p_issues, '[]'::jsonb)) x
  where coalesce(x->>'code', '') <> '' and coalesce(x->>'field', '') <> ''
  on conflict (kind, code, field) do update set
    last_seen  = excluded.last_seen,
    from_val   = excluded.from_val,
    to_val     = excluded.to_val,
    listing_id = excluded.listing_id,
    extra      = excluded.extra;
    -- first_seen 刻意不動 —— 「這個問題放多久了」是要看的資訊
  get diagnostics v_kept = row_count;

  /*
   * 這一輪沒再出現的就是解決了。
   *
   * 只刪同一個 kind —— 訂單同步不該動到評價的清單，
   * 兩支排程差半小時跑，中間那段時間清單會憑空少一半。
   */
  delete from sync_issues where kind = p_kind and last_seen < v_now;
  get diagnostics v_gone = row_count;

  return jsonb_build_object(
    'ok', true, 'run_id', v_run, 'open', v_kept, 'resolved', v_gone);
end $fn$;

revoke all on function public.record_sync_run(text, jsonb, jsonb) from public;
-- 只有 service key 呼叫得到（service_role 繞過 grant，這裡不開給 authenticated）

comment on function public.record_sync_run(text, jsonb, jsonb) is
  '記錄一次同步：寫流水帳,並把差異清單整批換成這一輪的結果。'
  '包成一支是為了讓「換掉」是一個交易 —— 分兩次的話中間失敗會留下混合狀態。';


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('113_sync_visibility');
  end if;
end $$;


-- ============================================================
-- 驗證（結果直接是表格 —— raise notice 在 SQL Editor 看不到）
-- ============================================================
do $$
declare
  r jsonb; n int; v_id uuid; v_first timestamptz;
begin
  drop table if exists _chk113;
  create temp table _chk113 (ord int, item text, result text, detail text);

  -- 1. 表與函式都在
  insert into _chk113 values (1, 'sync_runs 表',
    case when to_regclass('public.sync_runs') is not null then '✅' else '❌' end, '');
  insert into _chk113 values (1, 'sync_issues 表',
    case when to_regclass('public.sync_issues') is not null then '✅' else '❌' end, '');
  insert into _chk113 values (1, 'record_sync_run 函式',
    case when to_regprocedure('public.record_sync_run(text,jsonb,jsonb)') is not null
         then '✅' else '❌' end, '');

  -- 2. 寫一輪：兩個差異
  r := record_sync_run('__test__',
    '{"received":10,"inserted":2,"updated":3}'::jsonb,
    '[{"code":"T1","field":"房源","from":"A15","to":"舊-A15","listingId":"999"},
      {"code":"T2","field":"房客姓名","from":"Michael","to":"Michael Hu"}]'::jsonb);
  select count(*) into n from sync_issues where kind = '__test__';
  insert into _chk113 values (2, '第一輪寫入兩個差異',
    case when n = 2 then '✅' else '❌ 實際 ' || n end, r->>'ok');

  select first_seen into v_first from sync_issues
   where kind = '__test__' and code = 'T1' and field = '房源';

  -- 3. 第二輪只剩一個 → 另一個要自己消失
  perform pg_sleep(0.01);
  r := record_sync_run('__test__', '{}'::jsonb,
    '[{"code":"T1","field":"房源","from":"A15","to":"舊-B7","listingId":"999"}]'::jsonb);
  select count(*) into n from sync_issues where kind = '__test__';
  insert into _chk113 values (3, '★ 解決掉的差異會自己消失',
    case when n = 1 then '✅' else '❌ 還剩 ' || n || ' 列' end,
    '沒再出現的就是修好了 —— 清單空了才代表真的沒事');

  insert into _chk113 values (3, '★ 還在的那筆要更新內容',
    case when exists (select 1 from sync_issues
                       where kind = '__test__' and code = 'T1' and to_val = '舊-B7')
         then '✅' else '❌ to_val 沒跟著更新' end, '');

  insert into _chk113 values (3, '★ first_seen 不能被覆蓋',
    case when (select first_seen from sync_issues
                where kind = '__test__' and code = 'T1') = v_first
         then '✅' else '❌' end, '「這個問題放多久了」是要看的資訊');

  -- 4. 不同 kind 不能互相刪掉
  perform record_sync_run('__other__', '{}'::jsonb,
    '[{"code":"O1","field":"房源"}]'::jsonb);
  perform record_sync_run('__test__', '{}'::jsonb,
    '[{"code":"T1","field":"房源"}]'::jsonb);
  insert into _chk113 values (4, '★ 訂單同步不會清掉評價的清單',
    case when exists (select 1 from sync_issues where kind = '__other__')
         then '✅' else '❌ 兩支排程差半小時跑,會互相清空' end, '');

  -- 5. 編輯紀錄：自動新增現在記得到嗎
  --    SQL Editor 裡 auth.uid() 是 null,正好就是爬蟲的情境
  -- nights 是 not null（第一次寫這段時漏了，整支被回滾）
  insert into orders (order_key, source, guest_name, amount, nights, checkin, checkout, imported_via)
  values ('__AUDIT_TEST__', 'airbnb', '__測試__', 1, 1, current_date, current_date + 1, 'auto')
  returning id into v_id;
  insert into _chk113 values (5, '★ 爬蟲新增的訂單會進編輯紀錄',
    case when exists (select 1 from data_audit
                       where record_id = v_id and action = 'insert')
         then '✅' else '❌ 觸發器還在擋 auth.uid() is null' end, '');

  -- 契約產的月租單仍然不記（一次 24 筆會佔滿整頁）
  delete from data_audit where record_id = v_id;
  delete from orders where id = v_id;
  -- nights 是 not null（第一次寫這段時漏了，整支被回滾）
  insert into orders (order_key, source, guest_name, amount, nights, checkin, checkout, imported_via)
  values ('__AUDIT_TEST2__', 'contract', '__測試__', 1, 1, current_date, current_date + 1, 'contract')
  returning id into v_id;
  insert into _chk113 values (5, '契約自動產的月租單仍然不記',
    case when not exists (select 1 from data_audit where record_id = v_id)
         then '✅' else '❌ 一次 24 筆會把真正的新增推到第二頁' end, '');

  -- 收尾
  delete from data_audit where record_id = v_id;
  delete from orders where order_key in ('__AUDIT_TEST__', '__AUDIT_TEST2__');
  delete from sync_issues where kind in ('__test__', '__other__');
  delete from sync_runs where kind in ('__test__', '__other__');

  insert into _chk113 values (6, '評價觸發器',
    case when exists (select 1 from pg_trigger
                       where tgname = 'trg_data_audit_reviews' and not tgisinternal)
         then '✅ 已掛上'
         else '－ 跳過（reviews.id 不是 uuid）' end,
    'data_audit.record_id 是 uuid,型別不合硬掛會讓每次同步整批失敗');
end $$;

select item as "檢查項目", result as "結果", detail as "說明"
from _chk113 order by ord, item;
