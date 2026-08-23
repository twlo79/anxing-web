-- migration_125：連續兩輪沒看到才算「在 Airbnb 找不到」
--
-- ============================================================
-- 【又踩了一次，但這次不是 scope 的錯】
--
-- migration_117 清掉 203 筆誤報，原因是 scope 宣告錯了（min/max
-- 是「碰過哪些日期」不是「掃遍了哪些日期」）。那條修好了。
--
-- 2026-08-15 又冒出 46 筆，裡面有：
--
--     開封整棟  08-28~08-30  Ryan Collin    $32,268
--     JPR整棟   08-15~08-17  Conrad Chan    $12,804
--
-- 這兩筆就在同一天的房務排班表上 —— 客人正要入住。
--
-- 所以 scope 的範圍是對的，是**那一趟沒跑完**：登入過期、翻頁斷在
-- 一半、網路抖一下 —— 結果都一樣，沒抓到的那一段全部被當成消失。
--
-- scope 是爬蟲自己宣告的，而**宣告不等於做到**。
-- 上次學到「宣告的範圍要正確」，這次學到「範圍正確也可能沒跑完」。
--
--
-- ============================================================
-- 【兩道防線】（判斷邏輯與測試在 lib/airbnb-sync.ts）
--
--   一、一輪掉超過範圍內 10%（且 ≥ 5 筆）→ 整批不標記，改報「沒抓完」。
--       訂單真的從 Airbnb 消失是稀有事件。一天 46 筆的合理解釋
--       永遠是「這次沒抓完」，不是「46 組客人同時退掉」。
--
--   二、連續兩輪沒看到才標記。偶發的抓取不全撐不過第二輪。
--
-- 兩道都往「寧可晚一天報」倒：
--   漏報一筆 → 晚一天發現。
--   誤報 46 筆 → 這份清單再也沒有人看，連真的那一筆也被埋掉。
--
-- 這條規則值多少，看它擋掉的東西就知道 —— 上一次誤報之後，
-- 這份清單已經有人開始整批按「忽略」了。那才是真正的損失。

alter table public.airbnb_snapshots
  add column if not exists miss_streak int not null default 0;

comment on column public.airbnb_snapshots.miss_streak is
  '連續幾輪沒在爬蟲結果裡看到。看到就歸零 —— 中間看到過就不是「連續」。'
  '達到 2 才會標記 missing_since。一輪沒看到多半是那趟沒抓完,不是訂單不見了。';


-- ── 清掉 2026-08-15 那一批誤報 ─────────────────────
--
-- 只清「今天標的」。更早標記的留著 —— 那些是舊規則下的判斷，
-- 而且已經有人看過、按過忽略了，重新翻出來只會讓人再看一次同樣的東西。
do $$
declare v_n int;
begin
  update public.airbnb_snapshots
     set missing_since = null, miss_streak = 0
   where missing_since >= date_trunc('day', now())
     and missing_since <  date_trunc('day', now()) + interval '1 day';
  get diagnostics v_n = row_count;
  raise notice '清掉 % 筆', v_n;   -- 看不到,真正的報告在下面
end $$;

/*
 * 對應的建議也要撤掉。
 *
 * 不撤的話畫面上那 46 條還在，而底下的快照已經不算失蹤了 ——
 * 按「忽略」會忽略一個不存在的問題，按「套用」不知道會發生什麼。
 *
 * 下一輪對帳會整批重建這份清單（record_sync_run 的行為），
 * 所以這裡刪掉是安全的：真的有問題的隔天會自己回來。
 */
delete from public.sync_issues
 where field = '在 Airbnb 找不到'
   and first_seen >= date_trunc('day', now());


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('125_miss_streak');
  end if;
end $$;


-- ============================================================
-- 驗證
-- ============================================================
do $$
declare n int;
begin
  drop table if exists _chk125;
  create temp table _chk125 (ord int, item text, result text, detail text);

  insert into _chk125 values (1, 'miss_streak 欄位',
    case when exists (select 1 from information_schema.columns
                      where table_schema = 'public' and table_name = 'airbnb_snapshots'
                        and column_name = 'miss_streak') then '✅' else '❌' end, '');

  select count(*) into n from public.airbnb_snapshots
   where missing_since >= date_trunc('day', now());
  insert into _chk125 values (2, '★ 今天還被標成失蹤的',
    case when n = 0 then '✅ 0 筆' else '⚠ ' || n || ' 筆' end,
    case when n = 0 then '那 46 筆誤報清掉了' else '應該要是 0' end);

  select count(*) into n from public.sync_issues where field = '在 Airbnb 找不到';
  insert into _chk125 values (3, '★ 建議清單剩下的「找不到」', n || ' 條',
    '今天那批撤掉了。真的有問題的,下一輪對帳會自己回來');

  -- 那兩筆確定是活的,拿來當試紙
  insert into _chk125
  select 4, '★ ' || coalesce(guest, code),
         case when missing_since is null then '✅ 不是失蹤' else '❌ 還被標著' end,
         start_date::text || ' ~ ' || end_date::text
    from public.airbnb_snapshots
   where code in ('HMW4ZRW5ZC', 'HMXRCPPWC2');

  select count(*) into n from public.airbnb_snapshots where missing_since is not null;
  insert into _chk125 values (8, '歷史上被標過失蹤的', n || ' 筆',
    '更早標記的留著 —— 那些已經有人看過、處理過了');
end $$;

select item as "檢查項目", result as "結果", detail as "說明"
from _chk125 order by ord, item;
