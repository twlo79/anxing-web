/*
 * audit_deposit_shape —— 押金到底存在哪裡（唯讀，不改任何資料）
 * ============================================================
 * 2026-09-01 為了設計「寵物押金」而查。
 *
 * ★★★ 為什麼要查:
 *   `src/lib/money-lines.ts` 的 `fromLines()` 把畫面上**所有台幣列加總成一個數字**
 *   存進 `orders.deposit`。所以「一般押金 100,000 ＋ 寵物押金 30,000」
 *   存回去會變成 `deposit = 130,000` —— 兩列變一個數字，項目無聲消失。
 *
 * ★ 而訂單→押金的同步寫在 migration_56，那支不在 repo 裡（本機只有 171 之後）。
 *   不知道它怎麼運作就選路，等於猜 —— 猜錯的代價是押金管理頁少一筆或多一筆，
 *   而那是錢。
 *
 * 這支只有 select，執行後把結果整份貼回來就好。
 */

select v."項目", v."結果" from (

  -- ① deposits 表有哪些欄位 —— 決定「項目」能不能直接加在這裡
  select 1, '① deposits 的欄位',
         (select string_agg(column_name || ' ' || data_type, E'\n' order by ordinal_position)
            from information_schema.columns
           where table_schema = 'public' and table_name = 'deposits')

  union all
  -- ② 訂單的押金是誰寫進 deposits 的:trigger？RPC？還是前端？
  select 2, '② 動到 deposits 的 trigger 與函式',
         coalesce((select string_agg(p.proname || '()', E'\n' order by p.proname)
                     from pg_proc p
                     join pg_namespace n on n.oid = p.pronamespace
                    where n.nspname = 'public'
                      -- ★ 聚合函式傳進 pg_get_functiondef() 會報 42809，要先排除
                      and p.prokind in ('f', 'p')
                      and pg_get_functiondef(p.oid) ilike '%deposits%'
                      and pg_get_functiondef(p.oid) ilike '%order%'), '（沒有）')

  union all
  -- ③ 掛在 orders 上的 trigger 有哪些
  select 3, '③ orders 的 trigger',
         coalesce((select string_agg(tgname || ' → ' || p.proname, E'\n' order by tgname)
                     from pg_trigger t
                     join pg_proc p on p.oid = t.tgfoid
                    where t.tgrelid = 'public.orders'::regclass and not t.tgisinternal), '（沒有）')

  union all
  -- ④ 一張訂單目前可以有幾筆押金 —— 決定「多一筆寵物押金」會不會撞到唯一索引
  select 4, '④ deposits 上的唯一索引',
         coalesce((select string_agg(indexname || E'\n  ' || indexdef, E'\n' order by indexname)
                     from pg_indexes
                    where schemaname = 'public' and tablename = 'deposits'
                      and indexdef ilike '%unique%'), '（沒有唯一索引）')

  union all
  -- ⑤ 現況:有沒有訂單已經有兩筆以上同幣別的押金
  select 5, '⑤ 同一張訂單同一幣別有兩筆以上的',
         coalesce((select count(*)::text || ' 組'
                     from (select order_id, currency
                             from public.deposits
                            where order_id is not null
                            group by order_id, currency having count(*) > 1) x), '0 組')

  union all
  -- ⑥ orders.deposit 與 deposits 表對不對得起來（抽 5 筆看）
  select 6, '⑥ 抽驗:orders.deposit vs deposits 合計',
         coalesce((select string_agg(
                     '訂單 ' || left(o.id::text, 8) || '  orders.deposit=' || coalesce(o.deposit, 0)
                     || '  deposits 台幣合計=' || coalesce(d.s, 0), E'\n')
                     from public.orders o
                     left join (select order_id, sum(amount) s from public.deposits
                                 where currency = 'TWD' group by order_id) d on d.order_id = o.id
                    where coalesce(o.deposit, 0) > 0
                    limit 5), '（沒有押金大於 0 的訂單）')

  union all
  -- ⑦ 平台訂單現在有沒有押金 —— hasDeposit() 放行前的基準
  select 7, '⑦ Airbnb／Agoda 目前有押金的訂單數',
         (select count(*)::text || ' 筆'
            from public.orders
           where source in ('airbnb', 'agoda', 'airbnb_cancelled')
             and coalesce(deposit, 0) > 0)

  union all
  -- ⑧ 房源主檔的名稱 —— 之後 property_fee_default 要對得上
  select 8, '⑧ 房源主檔（前 30 個）',
         (select string_agg(name, '、' order by name)
            from (select name from public.properties order by name limit 30) p)

) v("ord", "項目", "結果") order by v.ord;
