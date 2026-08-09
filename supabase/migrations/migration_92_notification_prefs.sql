-- migration_92：通知設定集中管理
--
-- ⚠️ 執行前：把最下面那個 <PUSH_KEY> 換成 .env.local 裡的 PUSH_KEY 值（保留單引號）。
--    跟 migration_36/37 一樣 —— 金鑰寫在函式裡，改 repo 的 .sql 檔對正式環境沒有作用。
--
-- ============================================================
-- 【要解決什麼】
--
-- 通知目前只有一種（請款單核可），而且開關藏在請款單頁最上面。
-- 使用者要的是四種通知集中在一個地方管理：
--
--     訂單通知      爬蟲抓到新訂單、或有人手動 key 私下訂單
--     審核通知      請款單待核可（現有邏輯，不動）
--     評價通知      爬蟲抓到新評價
--     清潔記錄通知  API 匯入新清潔紀錄
--
--
-- ============================================================
-- 【兩層，不要混在一起】
--
--     裝置層  push_subscriptions   這台手機/電腦「能不能」收推播
--     偏好層  notification_prefs   這個人「要不要」收某一種通知
--
-- 偏好是**每個人一份**，不是每台裝置一份。
-- 做成每台一份的話，同一個人在手機開了、電腦沒開，
-- 他永遠搞不清楚自己到底設定了什麼 —— 而且沒有任何畫面能同時顯示兩台的狀態。
--
--
-- ============================================================
-- 【為什麼批次匯入不走觸發器】
--
-- 三個新來源全部是批次的：
--
--     airbnb-orders  每批 200 筆 insert
--     reviews        每批 500 筆 upsert
--     housekeeping   一次 insert 一整包 hk_event
--
-- 每筆一個觸發器就是每筆一則推播 —— 早上同步抓到 30 筆訂單，手機叮 30 下。
-- 所以那三種改由**匯入 API 跑完之後發一則**，帶筆數（「新增 12 筆 Airbnb 訂單」）。
-- 那三支路由本來就算好了新增筆數，接上去很自然。
--
-- 這支 migration 只負責**手動 key 的私下訂單** —— 那本來就一次一筆，
-- 用觸發器最直接。條件見下面 trg_orders_notify 的註解。


-- ============================================================
-- 1. 偏好表
-- ============================================================

create table if not exists public.notification_prefs (
  user_id   uuid primary key references auth.users(id) on delete cascade,
  -- 訂單：爬蟲新訂單 + 手動 key 的私下訂單
  orders    boolean not null default false,
  -- 審核：請款單待核可。**預設 true 是為了維持現狀** ——
  -- 現在只要訂閱了推播就會收到核可通知,改成 false 等於這次上線把它悄悄關掉。
  approvals boolean not null default true,
  reviews   boolean not null default false,
  cleaning  boolean not null default false,
  updated_at timestamptz not null default now()
);

comment on table public.notification_prefs is
  '每人一列的通知偏好,套用到他所有裝置。裝置能不能收推播是另一回事,看 push_subscriptions。';
comment on column public.notification_prefs.approvals is
  '預設 true —— 這是上線前的既有行為,改成 false 會把現有使用者的核可通知悄悄關掉。';

-- 既有使用者補一列,拿到預設值（審核開、其餘關）。
-- 不補的話他們在設定頁看到的是空狀態,而且下面的查詢要處理「沒有列」的情況。
insert into public.notification_prefs (user_id)
select p.id from public.profiles p
on conflict (user_id) do nothing;

-- 新帳號自動補一列。少了這個,新人進來要先手動存一次設定才會有列。
create or replace function public.init_notification_prefs() returns trigger
language plpgsql security definer set search_path = public as $fn$
begin
  insert into public.notification_prefs (user_id) values (new.id)
  on conflict (user_id) do nothing;
  return new;
end $fn$;

drop trigger if exists trg_profiles_notify_prefs on public.profiles;
create trigger trg_profiles_notify_prefs
  after insert on public.profiles
  for each row execute function public.init_notification_prefs();


-- ============================================================
-- 2. RLS：只看得到、也只改得動自己那一列
--
-- 通知偏好是個人設定,連 super_admin 都沒有理由去改別人的 ——
-- 「幫你把通知關掉」這件事如果做得到,出問題時查不出是誰做的。
-- ============================================================

alter table public.notification_prefs enable row level security;

drop policy if exists np_own_read on public.notification_prefs;
create policy np_own_read on public.notification_prefs
  for select using (user_id = auth.uid());

drop policy if exists np_own_write on public.notification_prefs;
create policy np_own_write on public.notification_prefs
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- 推播 API 用 service key 讀,不受 RLS 限制 —— 它要知道「誰要收這種通知」。


-- ============================================================
-- 3. 手動 key 的私下訂單 → 發一則
--
-- 【WHEN 條件是這一段最重要的部分】
--
-- orders 這張表**大部分的列不是人打進去的**：
--
--     契約觸發器  新增一張兩年月繳的契約 → 一次生出 24 張月租單
--     爬蟲匯入    每批 200 筆
--     契約加費    每期一張 CRC_…
--     移房、折讓  系統自己產生的子單
--
-- 沒有 WHEN 條件的話，建一張契約就會叮 24 下 —— 而那不是「有新訂單」，
-- 是「系統把既有契約展開成月份」。使用者要的是**有人真的接到一筆新生意**。
--
-- 所以條件收得很緊：source='private'（直客短租）**且** imported_via='manual'
-- （人在畫面上打的，不是任何自動路徑）。爬蟲的訂單走匯入 API 那條聚合通知。
--
-- 【還要再排除兩種「看起來像手動」的子單】
--
-- 光靠上面兩個條件不夠。短租頁有兩條路也是 source + imported_via='manual'：
--
--   移房   一筆私下訂單拆成 N 段住宿，每段一列，source 沿用原訂單（private）
--          → 拆 3 段就叮 3 下，而且移房可以重新編輯（刪掉重建），每改一次再叮一輪
--   加費   source='oneoff'，已經被上面的條件擋掉了
--
-- 移房的子單一定帶 move_group，加費與其他子單帶 parent_order_id。
-- 兩個都要是 null 才算「一筆全新的訂單」——
-- 移房不是新生意，是同一筆錢被切開。
-- ============================================================

create or replace function public.order_notify_push() returns trigger
language plpgsql security definer set search_path = public as $fn$
begin
  perform net.http_post(
    url     := 'https://justwork.estia.com.tw/api/push/broadcast',
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'x-push-key',   '<PUSH_KEY>'
               ),
    body    := jsonb_build_object(
                 'kind',  'orders',
                 'title', '新增私下訂單',
                 'body',  coalesce(new.property_raw, '未指定房源')
                          || '・' || coalesce(new.guest_name, '未填房客')
                          || '・$' || to_char(round(coalesce(new.amount, 0)), 'FM999,999,999'),
                 'url',   '/shortterm',
                 'tag',   'order-' || new.id::text
               )
  );
  return null;
exception when others then
  -- 推播失敗不能讓建單失敗。訂單是本體,通知是附帶的 ——
  -- pg_net 已經是非同步了,這一道是防它連排入佇列都出錯（例如擴充沒裝）。
  raise warning '訂單推播沒送出:%', sqlerrm;
  return null;
end $fn$;

drop trigger if exists trg_orders_notify on public.orders;
create trigger trg_orders_notify
  after insert on public.orders
  for each row
  when (new.source = 'private'
        and coalesce(new.imported_via, 'manual') = 'manual'
        and new.move_group is null          -- 移房拆出來的段落不是新訂單
        and new.parent_order_id is null)    -- 加費等子單也不是
  execute function public.order_notify_push();


-- ============================================================
-- 驗證
--
-- 包在 exception 裡：驗證失敗只發警告，不要把上面的變更整包回滾掉
-- （migration_76 就是那樣一夜白做）。
-- ============================================================

do $$
declare n int; t text;
begin
  select count(*) into n from information_schema.tables
   where table_schema = 'public' and table_name = 'notification_prefs';
  if n = 1 then raise notice '✅ notification_prefs 已建立';
  else raise warning '❌ 表不存在'; return; end if;

  -- 每個帳號都要有一列,否則設定頁會是空的
  select count(*) into n from public.profiles p
   where not exists (select 1 from public.notification_prefs np where np.user_id = p.id);
  if n = 0 then raise notice '✅ 所有帳號都有偏好列';
  else raise warning '❌ 有 % 個帳號沒有偏好列', n; end if;

  -- 審核預設要是 true,否則這次上線會把現有的核可通知悄悄關掉
  select count(*) into n from public.notification_prefs where approvals;
  raise notice 'ℹ 審核通知開啟中:% 人（應等於全部帳號數）', n;
  select count(*) into n from public.notification_prefs where orders or reviews or cleaning;
  if n = 0 then raise notice '✅ 三種新通知預設全關,沒有人的手機會突然多出通知';
  else raise warning '⚠ 有 % 人的新通知是開的（重跑這支才會這樣,不一定是錯）', n; end if;

  -- RLS 一定要開,不然每個人都看得到別人的設定
  select count(*) into n from pg_tables
   where schemaname = 'public' and tablename = 'notification_prefs' and rowsecurity;
  if n = 1 then raise notice '✅ RLS 已啟用';
  else raise warning '❌ RLS 沒開,任何人都讀得到別人的通知設定'; end if;

  -- ★ 這一段是整支最重要的檢查：WHEN 條件在不在
  select pg_get_triggerdef(oid) into t from pg_trigger
   where tgname = 'trg_orders_notify' and tgrelid = 'public.orders'::regclass;
  if t is null then
    raise warning '❌ trg_orders_notify 不存在';
  elsif position('private' in t) > 0 and position('manual' in t) > 0
        and position('move_group' in t) > 0 and position('parent_order_id' in t) > 0 then
    raise notice '✅ 訂單觸發器的四個條件都在（private/manual/非移房/非子單）';
  elsif position('move_group' in t) = 0 then
    raise warning '❌ WHEN 條件少了 move_group —— 私下訂單移房拆成 N 段會叮 N 下!';
  else
    raise warning '❌ 訂單觸發器的 WHEN 條件不完整 —— 建一張兩年契約會叮 24 下!';
  end if;

  -- 金鑰有沒有忘記換
  select prosrc into t from pg_proc where proname = 'order_notify_push';
  if position('<PUSH_KEY>' in t) > 0 then
    raise warning '❌ PUSH_KEY 還是佔位符,推播會被 API 擋掉（403）。把它換成真的金鑰再跑一次。';
  else raise notice '✅ PUSH_KEY 已填入'; end if;

exception when others then
  raise warning '驗證區出錯（上面的變更不受影響）:%', sqlerrm;
end $$;


-- ── WHEN 條件的實測 ────────────────────────────────
--
-- 只讀 pg_trigger 驗證得到「條件寫在那裡」,驗證不到「條件真的擋得住」。
-- 這裡不插假訂單（orders 上還有認列與押金觸發器,會連帶產生資料）,
-- 改成直接對既有資料算一次：如果現在重新插入這些列,有幾列會觸發通知。

do $$
declare n_all bigint; n_loose bigint; n_fire bigint;
begin
  select count(*) into n_all from public.orders;
  -- 只有 private + manual（我第一版寫的條件）
  select count(*) into n_loose from public.orders
   where source = 'private' and coalesce(imported_via, 'manual') = 'manual';
  -- 加上排除移房與子單之後
  select count(*) into n_fire from public.orders
   where source = 'private' and coalesce(imported_via, 'manual') = 'manual'
     and move_group is null and parent_order_id is null;

  raise notice 'ℹ 全部 % 筆訂單', n_all;
  raise notice 'ℹ 只看 private+manual:% 筆', n_loose;
  raise notice 'ℹ 再排除移房與子單:% 筆 ← 真正會發通知的', n_fire;

  if n_fire < n_all then
    raise notice '✅ 契約月租單與爬蟲訂單確實被排除在外';
  else
    raise warning '❌ 條件沒有排除任何東西,每一筆訂單都會發通知';
  end if;

  if n_loose > n_fire then
    raise notice 'ℹ 其中 % 筆是移房或加費子單 —— 少了那兩個條件的話,這些都會各叮一下',
      n_loose - n_fire;
  end if;
exception when others then
  raise warning '條件實測出錯:%', sqlerrm;
end $$;


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    raise notice '%', (select public.record_migration('92_notification_prefs'));
  else
    raise notice '尚未建立 schema_migrations（migration_70），這支沒有被記錄';
  end if;
end $$;
