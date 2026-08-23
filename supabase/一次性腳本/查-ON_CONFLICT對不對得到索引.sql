-- 查：每一句 ON CONFLICT (欄位) 是不是都有推斷得到的唯一索引
--
-- ============================================================
-- 【為什麼要有這支】（2026-08-19）
--
-- 「確認付款日」對所有角色都失敗，訊息是：
--
--     there is no unique or exclusion constraint
--     matching the ON CONFLICT specification
--
-- 成因是 sync_pr_fee_expense 寫 `on conflict (fee_request_id)`，
-- 而那一欄上只有一顆**部分索引**（`WHERE fee_request_id IS NOT NULL`）——
-- ON CONFLICT 推斷不到帶 WHERE 的索引。
--
-- ★ 最難查的地方在於:索引明明躺在那裡，錯誤訊息卻說「找不到」。
--   而這種錯**只在那條程式碼路徑真的被走到時才發生** ——
--   手續費那段只有「匯款 ＋ 不內扣 ＋ 金額 > 0」才跑，
--   所以它從第一天就壞著，藏到有人剛好開了一張那樣的單。
--
-- tsc 抓不到、單元測試抓不到（那是資料庫的事）。
-- 唯一能主動發現的方式就是像這樣掃一遍。
--
-- **改完任何 migration，跑一次這支。**


-- ── ① 所有函式裡的 ON CONFLICT ─────────────────────
/*
 * 把每一支函式原始碼裡的 `on conflict (...)` 抓出來。
 * 這裡只列出來給人看 —— 自動比對表名要解析 insert 目標，
 * 那個解析本身就會有錯，而錯了會給人「已經檢查過」的錯覺。
 * 寧可讓人多看兩眼。
 */
select
  p.proname                                   as "函式",
  (regexp_matches(pg_get_functiondef(p.oid),
     'on conflict\s*\(([^)]*)\)', 'gi'))[1]   as "衝突欄位",
  case when pg_get_functiondef(p.oid) ~* 'on conflict[^;]*where'
       then '★ 語句自己帶 WHERE（可能是刻意配部分索引）' else '' end as "備註"
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and pg_get_functiondef(p.oid) ~* 'on conflict\s*\('
order by 1, 2;


-- ── ② 所有部分唯一索引（推斷不到的那種）─────────────
/*
 * ★★ 這張表是重點。
 *
 * 部分唯一索引本身沒有錯 —— 錯的是「有 ON CONFLICT 指著它」。
 * 上面第 ① 張裡的欄位，如果出現在這張表，就要確認那句 insert
 * 有沒有帶一模一樣的 WHERE。沒有的話，那條路徑一走到就會炸。
 */
select
  tablename   as "資料表",
  indexname   as "索引",
  indexdef    as "定義"
from pg_indexes
where schemaname = 'public'
  and indexdef ilike '%unique%'
  and indexdef ilike '%where%'
order by tablename, indexname;


-- ── ③ 同一組欄位有兩顆以上唯一索引 ─────────────────
/*
 * 重複索引不會出錯，但每次寫入都要多維護一份，
 * 而且下一個人得先搞懂為什麼同一欄有兩顆。
 *
 * migration_150 就誤建了一顆（當時誤判成「沒有索引」），
 * 152 清掉了。
 */
select "資料表", "同欄位幾顆", string_agg("定義", E'\n') as "定義"
from (
  select
    t.relname                     as "資料表",
    i.indkey::text                as _cols,
    pg_get_indexdef(i.indexrelid) as "定義",
    count(*) over (partition by t.relname, i.indkey::text) as "同欄位幾顆"
  from pg_index i
  join pg_class t on t.oid = i.indrelid
  join pg_namespace n on n.oid = t.relnamespace
  where n.nspname = 'public' and i.indisunique
) v
where "同欄位幾顆" > 1
group by "資料表", _cols, "同欄位幾顆"
order by "資料表";
