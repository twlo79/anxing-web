-- migration_117：清掉「在 Airbnb 找不到」的誤報
--
-- ============================================================
-- 【發生什麼事】
--
-- 2026-08-14 第一次跑新版同步，203 筆正常的歷史訂單被標成
-- 「在 Airbnb 找不到」—— 包括 Erin $175,800、Michael $41,316 這些
-- 明顯還在的單。
--
--
-- 【為什麼】
--
-- 消失偵測的規則是「掃描範圍內、這一輪沒看到 = 不見了」。
-- 而爬蟲送來的 scope 是三趟抓取的 **min/max 入住日**。
--
-- 問題是那三趟不是一個連續區間，是三個不相連的切片：
--
--     A 未來與進行中   date_min=TODAY，翻到取完      ← 窮舉
--     B 取消單         全掃                          ← 窮舉（但只含已取消）
--     C 最近已結束     date_max=TODAY，只取前 100 筆  ← **不窮舉**
--
-- C 那趟 100 筆以前的歷史訂單永遠不會出現在結果裡，
-- 但它們的入住日落在 min~max 之間 —— 於是全部被判成不見了。
--
-- **min/max 描述的是「涵蓋範圍」，不是「窮舉範圍」。**
-- 消失偵測需要的是後者：只有在「這段期間我保證全抓了」的前提下，
-- 「沒看到」才等於「不存在」。
--
--
-- 【修法】
--
-- 爬蟲改成只宣告 A 趟的範圍（from = 今天）—— 那一趟是真的翻到取完。
-- 已結束的訂單不在窮舉範圍內，就不對它們做消失判斷。
--
-- 代價是這個偵測只看得到未來訂單的消失。要抓「ERP 有、Airbnb 沒有」
-- 的歷史孤兒單，得等全量回填之後 —— 那時候快照才是完整的。

-- ── 清掉快照上的失蹤記號 ───────────────────────────
update public.airbnb_snapshots
   set missing_since = null
 where missing_since is not null;

-- ── 清掉已經產生的建議 ─────────────────────────────
-- sync_issues 本來會自清，但要等下一輪同步跑到。
-- 留著的話這幾天看到的都是這 203 筆，真正要處理的被淹掉。
delete from public.sync_issues
 where field = '在 Airbnb 找不到';


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('117_clear_false_missing');
  end if;
end $$;


-- ============================================================
-- 驗證
-- ============================================================
do $$
declare n int; m int;
begin
  drop table if exists _chk117;
  create temp table _chk117 (ord int, item text, result text, detail text);

  select count(*) into n from public.airbnb_snapshots where missing_since is not null;
  insert into _chk117 values (1, '快照上還有失蹤記號的',
    case when n = 0 then '✅ 0 筆' else '❌ 還有 ' || n end,
    '清乾淨之後,下一輪同步不會再把它們變成建議');

  select count(*) into n from public.sync_issues where field = '在 Airbnb 找不到';
  insert into _chk117 values (2, '「在 Airbnb 找不到」的建議',
    case when n = 0 then '✅ 0 筆' else '❌ 還有 ' || n end, '');

  select count(*) into n from public.sync_issues;
  select count(*) into m from public.sync_issues where severity = 'high';
  insert into _chk117 values (3, '★ 清完之後還剩幾條建議',
    n || ' 條', '其中 ' || m || ' 條是「要處理」等級 —— 那才是真正該看的');

  select count(*) into n from public.airbnb_snapshots;
  insert into _chk117 values (4, '目前的快照筆數', n || ' 筆',
    '第一次跑之後就是爬蟲抓到的那些');
end $$;

select item as "檢查項目", result as "結果", detail as "說明"
from _chk117 order by ord, item;
