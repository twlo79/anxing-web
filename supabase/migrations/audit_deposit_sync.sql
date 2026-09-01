/*
 * audit_deposit_sync —— 訂單的押金列是誰維護的（唯讀，不改任何資料）
 * ============================================================
 * 2026-09-01。migration_193 的自檢 ⑤⑥⑦ 照出三個擋路的東西:
 *
 *   trg_sync_order_deposits → sync_order_deposits()   押金列是 trigger 自動維護的
 *   trg_orders_dep_orphan   → mark_deposits_orphaned() 有一支在處理「對不上的列」
 *   dep_order_once_idx                                 名字是「一張訂單一筆」
 *
 * ★★★ 「甲案」（寵物押金 = deposits 裡獨立的一列）能不能成立，
 *   完全取決於這三個的實際內容:
 *
 *     · 如果 dep_order_once_idx 是 unique(order_id)
 *       → 第二列**插不進去**，甲案直接死。
 *
 *     · 如果 sync_order_deposits() 是「照 orders.deposit 重建這張訂單的押金列」
 *       → 人工加的寵物押金會在下一次訂單存檔時被**刪掉或覆寫**，
 *         而畫面上不會有任何錯誤 —— 只是那筆錢下次就不見了。
 *
 *     · mark_deposits_orphaned() 可能會把它標成孤兒，
 *       於是它還在，但押金管理頁上長得像一筆壞資料。
 *
 * ★ 這三件事錯了都**不會報錯**，只會讓一筆錢安靜消失。所以查，不猜。
 *
 * 這支只有 select。執行後把結果整份貼回來。
 * ★ 第 ②③④ 列會是很長的函式原始碼 —— 那正是要看的東西，請整段貼。
 */

select v."項目", v."內容" from (

  -- ① 唯一索引的定義 —— 決定同一張訂單放不放得下第二列
  select 1, '① deposits 的唯一索引定義',
         coalesce((select string_agg(indexdef, E'\n' order by indexname)
                     from pg_indexes
                    where schemaname = 'public' and tablename = 'deposits'
                      and indexdef ilike '%unique%'), '（沒有）')

  union all
  -- ② 訂單→押金的同步。★ 最關鍵的一支
  select 2, '②★★★ sync_order_deposits() 原始碼',
         coalesce(pg_get_functiondef(to_regprocedure('public.sync_order_deposits()')),
                  '（查不到）')

  union all
  -- ③ 孤兒標記
  select 3, '③ mark_deposits_orphaned() 原始碼',
         coalesce(pg_get_functiondef(to_regprocedure('public.mark_deposits_orphaned()')),
                  '（查不到）')

  union all
  -- ④ 加費從押金扣的守門員（migration_157）——「寵物費」會經過它
  select 4, '④ order_fee_deposit_guard() 原始碼',
         coalesce(pg_get_functiondef(to_regprocedure('public.order_fee_deposit_guard()')),
                  '（查不到）')

  union all
  -- ⑤ trigger 掛在哪個時機（before/after、insert/update/delete）
  select 5, '⑤ 兩支 trigger 的定義',
         coalesce((select string_agg(pg_get_triggerdef(t.oid), E'\n' order by t.tgname)
                     from pg_trigger t
                    where t.tgrelid = 'public.orders'::regclass
                      and not t.tgisinternal
                      and t.tgname in ('trg_sync_order_deposits', 'trg_orders_dep_orphan')),
                  '（查不到）')

  union all
  -- ⑥ deposits 現在有哪些欄位（含 193 剛加的 item）
  select 6, '⑥ deposits 的欄位',
         (select string_agg(column_name || ' ' || data_type
                            || case when is_nullable = 'NO' then ' NOT NULL' else '' end,
                            E'\n' order by ordinal_position)
            from information_schema.columns
           where table_schema = 'public' and table_name = 'deposits')

) v(ord, "項目", "內容") order by v.ord;
