/*
 * migration_221 —— 房務支出的兩個冪等索引改成非 partial
 * ============================================================
 * 2026-09-07 使用者：「沒產生到支出」
 *
 * ★★★ 這個功能**從上線到現在一次都沒成功過**。
 *   `expenses` 裡 `hk_job_key` / `hk_labor_key` 有值的是 **0 筆**。
 *
 * ============================================================
 * 【為什麼】
 *
 * 兩個唯一索引都是 **partial** 的：
 *
 *     CREATE UNIQUE INDEX expenses_hk_job_uniq ON expenses (hk_job_key)
 *       WHERE (hk_job_key IS NOT NULL);          -- ← 這一行
 *
 * 而前端用的是 `supabase.upsert(rows, { onConflict: 'hk_job_key' })`，
 * PostgREST 只送得出**欄位名**，表達不出那個 WHERE 子句。
 *
 * Postgres 對不到索引就直接拒絕：
 *
 *     there is no unique or exclusion constraint matching
 *     the ON CONFLICT specification
 *
 * 所以每一次按「產生支出」都是失敗的。而失敗訊息走 `flash()` ——
 * 跳在頁面**最上方**，而產生面板在下半部，2.5 秒就消失。
 * 使用者按了鈕、畫面沒動、訊息沒看到，結論是「沒產生到支出」
 * （CLAUDE.md:「錯誤訊息跳在頁面最上方」，2026-09-02 記過同一條）。
 *
 * ============================================================
 * 【為什麼是改索引，不是改前端】
 *
 * 三條路都想過：
 *
 *   A 索引改成非 partial            ← 這一支
 *   B 前端改成「先讀已產生的鍵 → 濾掉 → 純 insert」
 *   C 拿掉 `onConflict` 只留 `ignoreDuplicates`
 *
 * **C 不行**:PostgREST 沒有 `on_conflict` 參數時會拿**主鍵**當衝突目標，
 * 而 `id` 每次都是新的 uuid —— 永遠不衝突，等於沒有防重複，
 * 按兩次就會產生兩整組。這比現在更糟（現在至少是失敗，不是重複）。
 *
 * **B 可行但繞路**:那等於把資料庫層的原子性搬到前端，
 * 兩個人同時按就會有競態。而且 upsert 的語意（重複就跳過）
 * 本來就正是這裡要的。
 *
 * **A 的代價**:索引會把 `hk_job_key is null` 的那幾百列也收進去。
 * `expenses` 目前 130 多筆，多出來的是幾 KB —— 可以忽略。
 * ★ Postgres 的唯一索引**允許多個 NULL**（NULL 彼此不相等），
 *   所以拿掉 WHERE 之後語意完全不變:非 null 的值照樣不准重複。
 *
 * ============================================================
 * 【★★ 這一支不動任何一列資料】
 * 只重建兩個索引。既有的 0 筆房務支出也沒有東西可動。
 *
 * 【怎麼跑】整份貼進 Supabase SQL Editor，看最後那張自檢表。
 */

begin;

/*
 * ★ drop 再 create，兩個動作在同一個交易裡 ——
 *   中間不會有「沒有唯一保護」的空窗被別的連線鑽進來。
 * ★★ 不用 `concurrently`:那個不能在交易裡跑，而 SQL Editor
 *   把整份腳本包在一個交易裡（CLAUDE.md）。這張表很小，鎖一下沒差。
 */
drop index if exists public.expenses_hk_job_uniq;
create unique index expenses_hk_job_uniq
  on public.expenses (hk_job_key);

drop index if exists public.expenses_hk_labor_uniq;
create unique index expenses_hk_labor_uniq
  on public.expenses (hk_labor_key);

comment on index public.expenses_hk_job_uniq is
  '房務清潔支出的冪等鍵（migration_221）。'
  '★★★ **不可以改成 partial**（`where hk_job_key is not null`）—— '
  'PostgREST 的 `upsert({ onConflict: ''hk_job_key'' })` 只送得出欄位名，'
  '對不到 partial index，Postgres 會直接拒絕整個 insert。'
  '而錯誤走 flash 跳在頁面上方，使用者只會看到「沒產生到支出」。'
  '★ 唯一索引本來就允許多個 NULL，所以拿掉 WHERE 語意不變。';

comment on index public.expenses_hk_labor_uniq is
  '房務人事費支出的冪等鍵（migration_221）。理由同 expenses_hk_job_uniq —— '
  '★★★ 不可以改成 partial。';

do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('221_hk_key_index_full');
  end if;
end $do$;

commit;


-- ══════════════════════════════════════════════════════════
-- 自檢
-- ══════════════════════════════════════════════════════════
select v.ord, v."檢查", v."結果", v."判定" from (

  -- ★★★ 這一列是這一支的全部意義:有 WHERE 就等於沒修
  select 1, '★★★ ① 兩個索引還是不是 partial',
         coalesce((select string_agg(indexname || '：' ||
                     case when indexdef ilike '%where%' then '❌ 還是 partial' else '✅ 全表' end,
                     E'\n' order by indexname)
                     from pg_indexes
                    where schemaname = 'public' and tablename = 'expenses'
                      and indexname in ('expenses_hk_job_uniq', 'expenses_hk_labor_uniq')),
                  '（找不到索引）'),
         case when (select count(*) from pg_indexes
                     where schemaname = 'public' and tablename = 'expenses'
                       and indexname in ('expenses_hk_job_uniq', 'expenses_hk_labor_uniq')
                       and indexdef not ilike '%where%') = 2
              then '✅ 兩個都不是 partial —— ON CONFLICT 對得到了'
              else '❌ 還有 partial 的，upsert 一樣會失敗' end

  union all
  -- ★ 唯一性不能弄丟。這才是索引存在的理由
  select 2, '★ ② 還是唯一索引嗎',
         coalesce((select string_agg(indexname || '：' ||
                     case when indexdef ilike 'CREATE UNIQUE%' then 'UNIQUE' else '❌ 不是唯一' end,
                     '、' order by indexname)
                     from pg_indexes
                    where schemaname = 'public' and tablename = 'expenses'
                      and indexname in ('expenses_hk_job_uniq', 'expenses_hk_labor_uniq')),
                  '（找不到）'),
         case when (select count(*) from pg_indexes
                     where schemaname = 'public' and tablename = 'expenses'
                       and indexname in ('expenses_hk_job_uniq', 'expenses_hk_labor_uniq')
                       and indexdef ilike 'CREATE UNIQUE%') = 2
              then '✅ 兩個都還是唯一' else '❌ 掉了唯一性 —— 同一份工會被記兩次' end

  union all
  /*
   * ★★★ 母體要判定。這一支跑完**還是 0** 是正常的 ——
   *   它只是把路打通，真正的產生要回畫面上按。
   *   下一步:排班統計 → 產生支出 → 再跑一次這個查詢，要變成 6。
   */
  select 3, '★★★ ③ 房務支出目前幾筆',
         (select count(*)::text || ' 筆（清潔 '
                 || count(*) filter (where hk_job_key is not null)::text || '、人事 '
                 || count(*) filter (where hk_labor_key is not null)::text || '）'
            from public.expenses
           where hk_job_key is not null or hk_labor_key is not null),
         case when (select count(*) from public.expenses
                     where hk_job_key is not null or hk_labor_key is not null) = 0
              then '⚠ 還是 0 —— **正常**。這一支只打通路，要回畫面按「產生支出」'
              else 'ℹ 已經有資料了' end

  union all
  select 4, '④ 這一支有沒有被記錄',
         coalesce((select max(name) from public.schema_migrations
                    where name = '221_hk_key_index_full'), '（沒記到）'),
         case when exists (select 1 from public.schema_migrations
                            where name = '221_hk_key_index_full')
              then '✅' else '❌ record_migration 沒寫進去' end

) v(ord, "檢查", "結果", "判定") order by v.ord;
