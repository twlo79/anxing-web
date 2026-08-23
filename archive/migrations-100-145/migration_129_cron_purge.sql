-- migration_129：每週日自動清掉舊通知
--
-- ============================================================
-- 【為什麼「自動」需要有人排】
--
-- 資料庫不會自己在時間到的時候做事。`purge_old_notifications()`
-- 寫好了，但它只是一支函式 —— 沒有人呼叫就永遠不會跑。
--
-- 三種排法：
--
--   1. 應用程式裡開 setInterval    ✗ 伺服器重啟就沒了,而且多台會各跑一次
--   2. 外部排程打 API              △ 要金鑰、要記得維護,而且排程掛了沒人知道
--   3. pg_cron 在資料庫裡排        ✓ 跟資料放在一起,重開機照跑
--
-- 選 3。清資料這件事本來就屬於資料庫,把它送出去繞一圈再回來
-- 只是多了三個可能壞掉的環節（網路、金鑰、外部排程器）。
--
--
-- ============================================================
-- 【時間：台北週日凌晨 4 點】
--
-- pg_cron 跑在 UTC，所以是 **週六 20:00 UTC**。
--
-- 挑凌晨是因為刪除會鎖列 —— 雖然這張表小到感覺不出來，
-- 但「挑沒有人在用的時候做維護」這個習慣值得保持:
-- 哪天資料量變大，不用回頭想「為什麼週日早上特別慢」。
--
--
-- ============================================================
-- 【pg_cron 裝不起來也不會擋住這份 migration】
--
-- 這個擴充在有些方案要先到 Dashboard → Database → Extensions 開。
-- 開不起來的話下面的自檢會明白講「還沒排到」，
-- 那時再退回用 /api/notifications/purge ＋ 外部排程。
--
-- 不讓它直接報錯是因為:整份腳本包在一個交易裡，
-- 一個裝不起來的擴充會把上面所有東西一起回滾。

do $$
begin
  begin
    create extension if not exists pg_cron;
  exception when others then
    raise notice 'pg_cron 裝不起來:% —— 下面的自檢會講', sqlerrm;
  end;
end $$;

do $$
begin
  if to_regnamespace('cron') is null then
    return;   -- 沒有 pg_cron,自檢會報
  end if;

  /*
   * 先移除舊的同名排程。
   *
   * 不移除的話重跑這份 migration 會排出第二個一模一樣的工作 ——
   * 兩個都會跑，而 delete 是幂等的所以**看不出任何異狀**，
   * 直到有一天有人打開排程清單，發現同一件事排了五次。
   */
  perform cron.unschedule(jobid)
     from cron.job where jobname = 'purge_old_notifications';

  perform cron.schedule(
    'purge_old_notifications',
    '0 20 * * 6',                      -- 週六 20:00 UTC = 台北週日 04:00
    $cron$select public.purge_old_notifications()$cron$
  );
end $$;


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('129_cron_purge');
  end if;
end $$;


-- ============================================================
-- 驗證
-- ============================================================
do $$
declare v_sched text; v_active boolean;
begin
  drop table if exists _chk129;
  create temp table _chk129 (ord int, item text, result text, detail text);

  insert into _chk129 values (1, 'pg_cron 擴充',
    case when to_regnamespace('cron') is not null then '✅' else '❌ 沒裝起來' end,
    case when to_regnamespace('cron') is not null then '' else
      '到 Dashboard → Database → Extensions 搜尋 pg_cron 打開,再跑一次這份。'
      '或者退回用 /api/notifications/purge ＋ 外部排程' end);

  if to_regnamespace('cron') is not null then
    select schedule, active into v_sched, v_active
      from cron.job where jobname = 'purge_old_notifications';

    insert into _chk129 values (2, '★ 排程',
      case when v_sched is null then '❌ 沒排到' else '✅ ' || v_sched end,
      case when v_sched is null then '' else '週六 20:00 UTC = 台北週日凌晨 4 點' end);

    insert into _chk129 values (3, '啟用中',
      case when v_active then '✅' when v_active is null then '—' else '❌ 被停用了' end, '');

    -- 同名排了幾個。應該永遠是 1
    insert into _chk129
    select 4, '★ 同名排程數量', count(*)::text,
           case when count(*) > 1 then '❌ 重複了 —— 同一件事會跑好幾次而且看不出來'
                else '' end
      from cron.job where jobname = 'purge_old_notifications';
  end if;

  insert into _chk129 values (8, '目前存著的通知',
    (select count(*)::text from public.notifications), '七天前的會在週日被清掉');
end $$;

select item as "檢查項目", result as "結果", detail as "說明"
from _chk129 order by ord, item;
