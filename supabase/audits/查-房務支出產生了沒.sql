/*
 * 查-房務支出產生了沒（唯讀）
 * ============================================================
 * 2026-09-07 使用者：「沒產生到支出」
 *
 * 排班統計說「產生 6 筆支出・人事費記在 09-30」，按了之後
 * 支出頁看不到那 6 筆。
 *
 * 【三種可能，這一支要分辨是哪一種】
 *
 *   ① 根本沒寫進去          → 第 2 列會是 0 筆
 *   ② 寫進去了但支出頁濾掉  → 第 2 列有資料，看第 3、4 列是哪個條件不合
 *   ③ 寫進去了、也沒被濾    → 那就是畫面的問題，另外查
 *
 * 【★★★ 最可疑的是 `book`】
 *
 * `stats-tab.tsx` 的 `mk()` 組出來的那個物件**沒有 `book` 這一欄** ——
 * 它靠資料庫的 default。而支出頁的查詢第一行就是
 * `.eq('book', 'anxing')`。
 *
 * 兩者對不上的話症狀正是這個:**寫入成功、查詢成功、0 列、沒有錯誤**。
 * 產生那邊還會很開心地說「已產生 6 筆支出」。
 *
 * ★ 這跟 migration_192 那條坑同一種形狀（條件寫死一個值，
 *   而另一條路徑用的是別的值），也跟 CLAUDE.md 的
 *   「一個靜默的讀 ＋ 一個靜默的寫」同一種。
 *
 * 【怎麼跑】整份貼進 SQL Editor，把結果貼回來。唯讀。
 */

select v.ord, v."檢查", v."結果", v."判定" from (

  -- ══════════ ★★★ book 的 default 是什麼 ══════════
  select 1 as ord, '★★★ ① expenses.book 的預設值' as a,
         coalesce((select column_default || '（' || data_type || '）'
                     from information_schema.columns
                    where table_schema = 'public' and table_name = 'expenses'
                      and column_name = 'book'), '（沒有這一欄）') as b,
         case when coalesce((select column_default from information_schema.columns
                              where table_schema = 'public' and table_name = 'expenses'
                                and column_name = 'book'), '') like '%anxing%'
              then '✅ 預設就是 anxing —— 那不是原因，看下面'
              else '❌ 預設不是 anxing。支出頁查的是 book=''anxing''，'
                   || '所以產生出來的那幾筆**永遠查不到**' end as d

  -- ══════════ ② 那幾筆到底在不在 ══════════
  union all
  select 2, '★★ ② 9 月的房務支出有幾筆',
         (select count(*)::text || ' 筆，合計 $' || coalesce(sum(amount), 0)::text
            from public.expenses
           where (hk_job_key is not null or hk_labor_key is not null)
             and spent_on between date '2026-09-01' and date '2026-09-30'),
         case when (select count(*) from public.expenses
                     where (hk_job_key is not null or hk_labor_key is not null)
                       and spent_on between date '2026-09-01' and date '2026-09-30') = 0
              then '❌ 一筆都沒有 —— 根本沒寫進去（不是被濾掉）'
              else '✅ 有寫進去 —— 那就是被支出頁濾掉了，看第 3、4 列' end

  -- ══════════ ③ 逐筆看它們長什麼樣 ══════════
  union all
  select 3, '③ 那幾筆的樣子',
         coalesce((select string_agg(
                     spent_on::text || '｜' || item_name || '｜$' || amount::text
                     || '｜book=' || coalesce(book, 'null')
                     || '｜tags=' || coalesce(array_to_string(tags, ','), '（空）')
                     || '｜科目=' || coalesce(account_code, 'null')
                     || '｜物業=' || case when estate_id is null then 'null' else 'ok' end,
                     E'\n' order by spent_on)
                     from public.expenses
                    where (hk_job_key is not null or hk_labor_key is not null)
                      and spent_on between date '2026-09-01' and date '2026-09-30'),
                  '（沒有資料）'),
         'ℹ book 要是 anxing、tags 要有 非實支'

  -- ══════════ ④ 支出頁那條查詢實際撈得到嗎 ══════════
  union all
  select 4, '★★ ④ 照支出頁的條件（book=anxing）撈得到幾筆',
         (select count(*)::text || ' 筆'
            from public.expenses
           where book = 'anxing'
             and (hk_job_key is not null or hk_labor_key is not null)
             and spent_on between date '2026-09-01' and date '2026-09-30'),
         case when (select count(*) from public.expenses
                     where book = 'anxing'
                       and (hk_job_key is not null or hk_labor_key is not null)
                       and spent_on between date '2026-09-01' and date '2026-09-30')
                 = (select count(*) from public.expenses
                     where (hk_job_key is not null or hk_labor_key is not null)
                       and spent_on between date '2026-09-01' and date '2026-09-30')
              then '✅ 兩個數字一樣 —— book 不是原因'
              else '❌ 比第 2 列少 —— **book 就是原因**' end

  -- ══════════ ⑤ 冪等鍵的唯一索引還在嗎 ══════════
  union all
  /*
   * ★ upsert 用 `onConflict: 'hk_job_key'` / `'hk_labor_key'`。
   *   那兩欄沒有唯一索引的話 PostgREST 會直接報錯（不是靜默），
   *   但順手確認一下 —— 錯誤訊息會被 flash 吃掉 2.5 秒。
   */
  select 5, '⑤ 兩個冪等鍵的唯一索引',
         coalesce((select string_agg(indexname, '、' order by indexname)
                     from pg_indexes
                    where schemaname = 'public' and tablename = 'expenses'
                      and (indexdef ilike '%hk_job_key%' or indexdef ilike '%hk_labor_key%')),
                  '（一個都沒有）'),
         case when (select count(*) from pg_indexes
                     where schemaname = 'public' and tablename = 'expenses'
                       and indexdef ilike '%unique%'
                       and (indexdef ilike '%hk_job_key%' or indexdef ilike '%hk_labor_key%')) >= 2
              then '✅ 兩個都在' else '⚠ 少了 —— upsert 會報錯' end

  -- ══════════ ⑥ 歷史上總共產生過幾筆 ══════════
  union all
  select 6, '★★★ ⑥ 房務支出歷史總筆數',
         (select count(*)::text || ' 筆（清潔 '
                 || count(*) filter (where hk_job_key is not null)::text || '、人事 '
                 || count(*) filter (where hk_labor_key is not null)::text || '）'
            from public.expenses
           where hk_job_key is not null or hk_labor_key is not null),
         case when (select count(*) from public.expenses
                     where hk_job_key is not null or hk_labor_key is not null) = 0
              then '⚠ 這條路從來沒有成功過一次 —— 不只是這個月的問題'
              else 'ℹ 以前成功過，所以是這次或這個月的問題' end

) v(ord, "檢查", "結果", "判定") order by v.ord;
