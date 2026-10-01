/* ══════════════════════════════════════════════════════════════════════
 * 查（只讀）：資料庫這邊，跟訂單有關的哪幾句 SQL 最慢                                      2026-10-01
 *
 * 【為什麼】David：「修改訂單後儲存變慢了，要 load」。存一筆訂單前端會連發 4～5 個請求
 *   （update → 查加費 → 查剛存的那列 → 重新載入清單含總筆數），慢在哪一個要量，不猜。
 *   這支看的是 Supabase 內建的統計（pg_stat_statements）：每一句平均跑多久、跑了幾次。
 *
 * 【怎麼讀】平均毫秒（mean_ms）超過 300 的就是嫌疑犯；觸發器跑的 SQL 也會列進來。
 *   「總筆數」那句（count(*)…）如果上榜，就是清單重載慢，不是存檔慢。
 * 一個字都不改。
 * ══════════════════════════════════════════════════════════ */
select round(mean_exec_time)::int as mean_ms,
       round(max_exec_time)::int  as max_ms,
       calls                      as 次數,
       round(total_exec_time / 1000)::int as 總秒數,
       left(regexp_replace(query, '\s+', ' ', 'g'), 160) as sql
  from extensions.pg_stat_statements
 where query ilike '%orders%'
   and query not ilike '%pg_stat_statements%'
   and calls >= 3
 order by mean_exec_time desc
 limit 25;
