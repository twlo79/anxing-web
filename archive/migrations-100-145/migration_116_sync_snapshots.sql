-- migration_116：爬蟲快照 ＋ 建議分級 ＋ 訂單去重
--
-- ============================================================
-- 【一、爬蟲要記得上次看到什麼】
--
-- 現在每天早上爬蟲做的事是「Airbnb 現在說什麼」對「ERP 裡是什麼」。
-- 這個比對只回答得了一句話：兩邊不一樣。
--
-- 它回答不了真正要緊的那句：**是誰動了？**
--
--   · Airbnb 昨天說 105,479、今天說 175,799 → Airbnb 改了，這是新事件
--   · Airbnb 一直說 175,799，ERP 一直是 105,479 → 這是舊帳，等人去修
--
-- 兩者現在混在同一份清單裡，長得一模一樣。結果是每天早上看到的
-- 都是同一批熟面孔，而真正今天才發生的那一筆藏在裡面 ——
-- 幾天之後就沒有人在看那份清單了。
--
-- 存了快照就分得出來，而且**講得出原因**：
-- 「搭檔收款從 $0 變成 $70,320」比「金額不一致」有用得多。
--
--
-- ============================================================
-- 【二、建議要分級】
--
-- sync_issues 現在每一列都一樣重。但它們的後果差很多：
--
--   金額不一致      營收數字是錯的
--   對不到房源      訂單根本沒進系統，那筆錢完全不存在
--   房源不一致      錢進來了，但算到別的物業頭上
--   住宿起訖已更新  系統已經改好了，只是通知你一聲
--
-- 不分級的話，最後一種（每天最多）會把前兩種蓋掉。
--
--
-- ============================================================
-- 【三、訂單去重】
--
-- orders.order_key 一直**沒有唯一索引**。
--
-- 爬蟲翻頁時同一筆訂單出現在兩頁是常態（Airbnb 的分頁是依時間切的，
-- 邊界那幾筆會重複）。同一次匯入裡同一個確認碼出現兩次，
-- 程式會判斷兩次「這是新訂單」，然後**插入兩列**。
--
-- 而重複的訂單在報表上看起來完全正常 —— 只是那個月多了一筆錢。
-- 2026-07 多算 33,053、2026-08 多算 782,102，都是這樣來的。
--
-- 程式端已經加了去重（lib/airbnb-sync 的 dedupe），但那只擋得住
-- 走那條路的寫入。唯一索引是資料庫層級的，匯入、批次修正、
-- 直接下 SQL 都繞不過去。

-- ============================================================
-- 一、爬蟲快照
-- ============================================================
create table if not exists public.airbnb_snapshots (
  /** Airbnb 確認碼。跟 orders.order_key 是同一個值。 */
  code        text primary key,
  listing_id  text,
  guest       text,
  start_date  date,
  end_date    date,
  nights      int,
  status_key  text,
  /** 「你賺得」—— Airbnb 列表上的淨額 */
  earnings    numeric,
  /** 搭檔收款。明細裡是負數，這裡存絕對值。 */
  cohost      numeric,
  /** earnings + cohost。訂單金額就是這個。 */
  revenue     numeric,
  first_seen  timestamptz not null default now(),
  last_seen   timestamptz not null default now(),
  /**
   * 上一次「內容真的變了」的時間。
   *
   * 跟 last_seen 分開：last_seen 每天都會動（爬蟲每天都看到它），
   * changed_at 只在 Airbnb 那邊真的改了才動。
   * 「這筆昨天才變」用 changed_at 判斷，用 last_seen 會全部都是今天。
   */
  changed_at  timestamptz,
  /**
   * 上一次變動改了什麼，寫成人看得懂的一句話：
   * 「搭檔收款 $0 → $70,320」。
   *
   * 【為什麼存文字，不是等對帳時再算】
   * 對帳跟爬取拆開了 —— 對帳可能晚幾小時、甚至隔天才跑。
   * 那時候舊值已經被蓋掉，「從多少變成多少」就再也算不出來。
   * 這句話只有覆蓋的那一瞬間講得出來。
   */
  change_note text,
  /**
   * 這筆在 Airbnb 上不見了（在掃描範圍內卻沒出現）。
   *
   * 【為什麼一定要配掃描範圍】
   * 爬蟲每天只抓最近幾頁，舊訂單本來就不會出現在結果裡。
   * 拿「這輪沒看到」當「不見了」，會把幾千筆正常歷史全標成失蹤 ——
   * 而那樣的清單沒有人會去看第二次。
   */
  missing_since timestamptz,
  /**
   * Airbnb 回傳的原始明細，整包存著。
   *
   * 【為什麼要存看起來用不到的東西】
   * 今天我們只想到要比金額、日期、搭檔收款。哪天發現「清潔費要單獨
   * 記帳」或「平台服務費要拆出來看」，raw 裡有的話回頭算得出來，
   * 沒有的話那段歷史就永遠沒有了 —— 而歷史是補不回來的。
   */
  raw         jsonb,
  seen_count  int not null default 1
);

comment on table public.airbnb_snapshots is
  '爬蟲上次在 Airbnb 看到的狀態。用來分辨「Airbnb 今天改了」與 '
  '「ERP 跟 Airbnb 一直不一樣」—— 前者是新事件，後者是待辦。';

create index if not exists idx_airbnb_snapshots_changed
  on public.airbnb_snapshots (changed_at desc nulls last);
create index if not exists idx_airbnb_snapshots_missing
  on public.airbnb_snapshots (missing_since) where missing_since is not null;
-- 對帳要依入住日切範圍（只對某段期間），沒有這個索引會整表掃
create index if not exists idx_airbnb_snapshots_start
  on public.airbnb_snapshots (start_date);


/*
 * 這一輪爬蟲掃了哪個範圍。
 *
 * 【為什麼是 sync_runs 上的欄位，不是快照上的】
 * 範圍是「這一次爬取」的性質，不是「這一筆訂單」的性質。
 * 而「不見了」的判斷要拿最近一次的範圍去看 —— 存在 run 上才查得到。
 *
 * null = 爬蟲沒告訴我們範圍。那時候一律不做消失偵測 ——
 * 不知道掃了哪裡就說某筆不見了，那不是偵測，是猜。
 */
alter table public.sync_runs add column if not exists scan_from date;
alter table public.sync_runs add column if not exists scan_to   date;

alter table public.airbnb_snapshots enable row level security;

drop policy if exists snap_read on public.airbnb_snapshots;
create policy snap_read on public.airbnb_snapshots
  for select using (auth.role() = 'authenticated');
-- 寫入只走服務金鑰（匯入端點）。沒有 write policy 就是任何登入者都改不了 ——
-- 快照是「Airbnb 說了什麼」的紀錄，人改了它就不再是紀錄。


-- ============================================================
-- 二、建議分級
-- ============================================================
alter table public.sync_issues
  add column if not exists severity text not null default 'mid';

/*
 * 為什麼建議文字存在資料庫，而不是像現在寫死在畫面上。
 *
 * 寫死的版本只能依「欄位種類」給一句話：所有金額不一致都拿到同一句
 * 「確認過再手動改」。但真正有用的是那一筆自己的原因 ——
 * 「搭檔收款從 0 變成 70,320」跟「延住 4 晚」要做的事完全不同。
 * 那句話只有比對當下算得出來，畫面上算不出來。
 */
alter table public.sync_issues
  add column if not exists reason text;

/*
 * Airbnb 那邊今天才變的。
 *
 * 這是整個快照機制的產物，也是清單上最該先看的一群 ——
 * 其餘的都是還沒處理完的舊帳。
 */
alter table public.sync_issues
  add column if not exists airbnb_changed boolean not null default false;

comment on column public.sync_issues.severity is
  'high=營收數字會錯 / mid=營收歸屬會錯 / low=已經處理好，只是通知';

create index if not exists idx_sync_issues_severity
  on public.sync_issues (kind, severity, airbnb_changed desc);


-- ============================================================
-- 二之二、record_sync_run 要一併寫入分級與原因
-- ============================================================
--
-- 【為什麼整支重貼而不是只改幾行】
-- Postgres 沒有「只改函式裡的某一段」。create or replace 就是整支換掉，
-- 所以這裡是 migration_113 那支加上三個新欄位 —— 其餘一字未動。
create or replace function public.record_sync_run(
  p_kind text, p_counts jsonb, p_issues jsonb
) returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare
  /*
   * 【一定要用 clock_timestamp()，不能用 now()】
   * now() 回的是交易開始的時間，同一個交易裡永遠是同一個值 ——
   * 那樣「刪掉 last_seen < v_now 的」會一列都刪不掉，
   * 待辦清單只增不減，而且完全不報錯。詳見 migration_113。
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
    p_kind,
    x->>'code',
    x->>'field',
    v_now, v_now,
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
    airbnb_changed = excluded.airbnb_changed;
    -- first_seen 刻意不動 —— 「這個問題放多久了」是要看的資訊
  get diagnostics v_kept = row_count;

  -- 這一輪沒再出現的就是解決了。只刪同一個 kind。
  delete from sync_issues where kind = p_kind and last_seen < v_now;
  get diagnostics v_gone = row_count;

  return jsonb_build_object(
    'ok', true, 'run_id', v_run, 'open', v_kept, 'resolved', v_gone);
end $fn$;

revoke all on function public.record_sync_run(text, jsonb, jsonb) from public;


-- ============================================================
-- 三、訂單去重
-- ============================================================
--
-- 【為什麼不直接 create unique index】
--
-- 如果現在就有重複，建索引會失敗 —— 而 Supabase SQL Editor 把整份
-- 腳本包在一個交易裡，一個錯誤會讓**上面兩段也一起回滾**。
-- 快照表沒建成、分級沒加成，而畫面上只看得到一行紅字。
--
-- 所以先數，有重複就只報告不建索引，讓他先去清。
do $$
declare
  n int;
begin
  select count(*) into n from (
    select order_key from public.orders
    where order_key is not null
    group by order_key having count(*) > 1
  ) t;

  if n = 0 then
    create unique index if not exists uq_orders_order_key
      on public.orders (order_key)
      where order_key is not null;
  end if;
end $$;


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('116_sync_snapshots');
  end if;
end $$;


-- ============================================================
-- 驗證（結果直接是表格 —— raise notice 在 SQL Editor 看不到）
-- ============================================================
do $$
declare
  n int; v_rev numeric; v_changed timestamptz; v_seen timestamptz;
begin
  drop table if exists _chk116;
  create temp table _chk116 (ord int, item text, result text, detail text);

  insert into _chk116 values (1, 'airbnb_snapshots 表',
    case when to_regclass('public.airbnb_snapshots') is not null then '✅' else '❌' end, '');

  insert into _chk116 values (1, '快照的原始明細與變動說明',
    case when (select count(*) from information_schema.columns
               where table_name = 'airbnb_snapshots'
                 and column_name in ('raw', 'change_note', 'missing_since')) = 3
         then '✅' else '❌' end,
    'raw 存整包（錯過就再也拿不到）、change_note 存「改了什麼」'
    || '（對帳晚一天跑也講得出原因）、missing_since 標記不見了');

  insert into _chk116 values (1, '同步紀錄的掃描範圍',
    case when (select count(*) from information_schema.columns
               where table_name = 'sync_runs'
                 and column_name in ('scan_from', 'scan_to')) = 2
         then '✅' else '❌' end,
    '不知道掃了哪裡就說某筆不見了,那不是偵測是猜 —— 沒有範圍就不做');

  insert into _chk116 values (1, 'sync_issues 分級欄位',
    case when exists (select 1 from information_schema.columns
                      where table_name = 'sync_issues' and column_name = 'severity')
         and exists (select 1 from information_schema.columns
                      where table_name = 'sync_issues' and column_name = 'reason')
         and exists (select 1 from information_schema.columns
                      where table_name = 'sync_issues' and column_name = 'airbnb_changed')
         then '✅' else '❌' end, 'severity / reason / airbnb_changed');

  -- 快照：同一個 code 只會有一列
  delete from public.airbnb_snapshots where code = '__TEST116__';
  insert into public.airbnb_snapshots (code, revenue, earnings, cohost, changed_at)
  values ('__TEST116__', 105479.73, 105479.73, 0, null);
  insert into public.airbnb_snapshots (code, revenue, earnings, cohost, changed_at, last_seen, seen_count)
  values ('__TEST116__', 175799.56, 105479.73, 70319.83, clock_timestamp(), clock_timestamp(), 2)
  on conflict (code) do update set
    revenue = excluded.revenue, cohost = excluded.cohost,
    changed_at = excluded.changed_at, last_seen = excluded.last_seen,
    seen_count = excluded.seen_count;

  select count(*) into n from public.airbnb_snapshots where code = '__TEST116__';
  insert into _chk116 values (2, '★ 同一筆訂單只會有一列快照',
    case when n = 1 then '✅' else '❌ ' || n || ' 列' end,
    '每天爬一次,一年就是 365 列 —— 用 upsert 而不是每次插一列');

  select revenue, changed_at, last_seen into v_rev, v_changed, v_seen
  from public.airbnb_snapshots where code = '__TEST116__';

  insert into _chk116 values (2, '★ 快照會被更新成最新的',
    case when v_rev = 175799.56 then '✅' else '❌ ' || coalesce(v_rev::text, 'null') end,
    '105,479.73（淨額）→ 175,799.56（含搭檔收款 70,319.83）'
    || ' —— 這個加法就是 David 一直在手動做的事');

  insert into _chk116 values (3, '★★ 內容變了才記 changed_at',
    case when v_changed is not null and v_seen is not null then '✅' else '❌' end,
    'last_seen 每天都動,changed_at 只在 Airbnb 真的改了才動 —— '
    || '用 last_seen 判斷「今天才變的」會全部都是今天,那個欄位就等於沒有');

  delete from public.airbnb_snapshots where code = '__TEST116__';

  -- 訂單重複
  select count(*) into n from (
    select order_key from public.orders
    where order_key is not null group by order_key having count(*) > 1) t;
  insert into _chk116 values (4, '★★ 訂單編號唯一索引',
    case when exists (select 1 from pg_indexes where indexname = 'uq_orders_order_key')
         then '✅ 已建立'
         else '⚠ 沒建 —— 有 ' || n || ' 組重複' end,
    case when n = 0 then '之後同一個確認碼再也插不進去第二列'
         else '請先清掉重複的訂單,再把這支 migration 跑一次' end);

  if n > 0 then
    insert into _chk116
    select 5, '重複的訂單編號', order_key, count(*) || ' 列・' ||
           string_agg(coalesce(guest_name, '(無名)') || ' $' || coalesce(amount::text, '0'), '、')
    from public.orders where order_key is not null
    group by order_key having count(*) > 1 limit 20;
  end if;

  -- 目前的快照量
  select count(*) into n from public.airbnb_snapshots;
  insert into _chk116 values (6, '目前的快照筆數', n || ' 筆',
    case when n = 0 then '第一次跑爬蟲時會全部建起來 —— 那一輪不會有「今天才變的」' else '' end);
end $$;

select item as "檢查項目", result as "結果", detail as "說明"
from _chk116 order by ord, item;
