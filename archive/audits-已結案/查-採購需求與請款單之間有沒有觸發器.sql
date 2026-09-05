/*
 * 查-採購需求與請款單之間有沒有觸發器（唯讀，不改任何東西）
 * ============================================================
 * 2026-09-05
 *
 * 【為什麼要查】
 *
 * `src/lib/demand-to-request.ts` 的檔頭寫著：
 *
 *     「migration_140 把資料庫那一半做完了 —— 關聯欄位、單頭狀態的
 *       自動彙總、已請款的項目鎖住、請款單被駁回時自動退回。」
 *
 * **那句話我證不了。** `supabase/` 整個資料夾裡 `purchase_demand`
 * 一個字都沒出現 —— migrations 只剩 200 之後的 18 支，
 * `schema-baseline.sql` 也沒有這兩張表。
 *
 * 所以那段註解可能是真的，也可能是我憑印象寫的
 * （CLAUDE.md：「憑印象寫既有函式的簽章」、
 *   「只找到一條產生路徑就當成唯一的」）。
 *
 * 在決定「已採購」要在送審時翻還是付款時翻之前，
 * 得先知道**資料庫現在自己會做什麼** ——
 * 不然前端寫一套、觸發器寫另一套，兩邊對同一筆給出不同答案，
 * 而畫面上完全看不出來。
 *
 * 【最重要的是第 6、7 區】
 * 第 6 區列出**所有**函式定義裡提到 `purchase_demand` 的函式。
 * 第 7 區把那幾支的完整定義印出來 —— 那才是真相。
 * 如果第 7 區太長，貼前兩支給我就好。
 *
 * 【怎麼跑】整份貼進 Supabase SQL Editor，把結果表整個貼回來。
 *          這支**不會**改任何資料。
 */

with
tbls as (
  select c.oid, c.relname::text as name, c.relrowsecurity as rls
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r'
     and c.relname in ('purchase_demands', 'purchase_demand_items',
                       'purchase_requests', 'purchase_request_items')
),
trg as (
  select t.tgname::text as tgname, c.relname::text as tbl, p.proname::text as fn,
         case when (t.tgtype & 2) <> 0 then 'BEFORE' else 'AFTER' end as tim,
         concat_ws('/',
           case when (t.tgtype &  4) <> 0 then 'INSERT' end,
           case when (t.tgtype &  8) <> 0 then 'DELETE' end,
           case when (t.tgtype & 16) <> 0 then 'UPDATE' end)::text as evt
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    join pg_proc p on p.oid = t.tgfoid
   where not t.tgisinternal
     and n.nspname = 'public'
     and c.relname in ('purchase_demands', 'purchase_demand_items',
                       'purchase_requests', 'purchase_request_items')
),
/*
 * ★ `prokind in ('f','p')` 一定要加 —— 少了它會掃到聚合函式，
 *   `pg_get_functiondef(array_agg)` 直接丟 42809 把整支炸掉
 *   （CLAUDE.md，2026-09-01 踩過）。
 */
fns as (
  select p.oid, p.proname::text as fn, pg_get_functiondef(p.oid) as def
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prokind in ('f', 'p')
     and pg_get_functiondef(p.oid) ilike '%purchase_demand%'
),
items as (
  select * from public.purchase_demand_items
)

select v.ord, v."區塊", v."項目", v."內容", v."判定" from (

  -- ══════════ 1 · 表在不在 ══════════
  select 100 as ord, '1 表' as a, '這四張表找到幾張' as b,
         (select string_agg(name, '、' order by name) from tbls) as c,
         case when (select count(*) from tbls) = 4 then '✅ 四張都在'
              else '❌ 少了表 —— 下面全部不算數' end as d

  -- ══════════ 2 · 關聯欄位 ══════════
  union all
  select 200, '2 欄位', 'purchase_demand_items 有沒有 request_item_id',
         coalesce((select data_type || case when is_nullable = 'YES' then '，可為 null' else '，not null' end
                     from information_schema.columns
                    where table_schema = 'public'
                      and table_name = 'purchase_demand_items'
                      and column_name = 'request_item_id'), '（沒有這一欄）'),
         case when exists (select 1 from information_schema.columns
                            where table_schema = 'public'
                              and table_name = 'purchase_demand_items'
                              and column_name = 'request_item_id')
              then '✅ 關聯欄位在'
              else '❌ 沒有關聯欄位 —— 前端的回寫會失敗' end

  union all
  select 210, '2 欄位', 'purchase_demand_items 的 status 允許哪些值',
         coalesce((select string_agg(pg_get_constraintdef(co.oid), ' ｜ ')
                     from pg_constraint co
                     join pg_class c on c.oid = co.conrelid
                     join pg_namespace n on n.oid = c.relnamespace
                    where n.nspname = 'public'
                      and c.relname = 'purchase_demand_items'
                      and co.contype::text = 'c'
                      and pg_get_constraintdef(co.oid) ilike '%status%'), '（沒有 check）'),
         case when coalesce((select string_agg(pg_get_constraintdef(co.oid), ' ')
                     from pg_constraint co
                     join pg_class c on c.oid = co.conrelid
                     join pg_namespace n on n.oid = c.relnamespace
                    where n.nspname = 'public' and c.relname = 'purchase_demand_items'
                      and co.contype::text = 'c'), '') ilike '%done%'
              then '✅ done 是合法值'
              else '⚠ 沒看到 done —— 前端寫 done 可能會被 check 擋' end

  -- ══════════ 3 · 需求那兩張表上的觸發器 ══════════
  union all
  select 300, '3 觸發器', '掛在 purchase_demands / _items 上的',
         coalesce((select string_agg(tgname || '（' || tim || ' ' || evt || ' → ' || fn || '）', E'\n')
                     from trg where tbl like 'purchase_demand%'), '（一個都沒有）'),
         case when exists (select 1 from trg where tbl like 'purchase_demand%')
              then 'ℹ 有觸發器，第 7 區看它做什麼'
              else 'ℹ 沒有觸發器 —— 需求單的狀態全靠前端寫' end

  -- ══════════ 4 · ★★★ 請款那兩張表上的觸發器（會不會回寫需求單） ══════════
  union all
  select 400, '4 觸發器', '★★★ 掛在 purchase_requests / _items 上的',
         coalesce((select string_agg(tgname || '（' || tim || ' ' || evt || ' → ' || fn || '）', E'\n')
                     from trg where tbl like 'purchase_request%'), '（一個都沒有）'),
         'ℹ 這一格決定「送出／核可／付款」會不會自動翻需求單的狀態'

  -- ══════════ 5 · RLS ══════════
  union all
  select 500, '5 權限', 'purchase_demand_items 的 RLS 與 policy',
         (select case when bool_or(rls) then 'RLS 開著' else 'RLS 沒開' end from tbls where name = 'purchase_demand_items')
           || '，policy ' || (select count(*)::text from pg_policies
                               where schemaname = 'public' and tablename = 'purchase_demand_items')
           || ' 條：' || coalesce((select string_agg(policyname || '（' || cmd || '）', '、' order by policyname)
                                    from pg_policies
                                   where schemaname = 'public' and tablename = 'purchase_demand_items'), '無'),
         /*
          * ★★ RLS 開著卻沒有 UPDATE policy 的話，前端的回寫會
          *   **回成功而且影響 0 列** —— 請款單建好了、需求單還是「未採購」，
          *   兩邊都不會叫（CLAUDE.md）。
          */
         case when (select bool_or(rls) from tbls where name = 'purchase_demand_items')
                and not exists (select 1 from pg_policies
                                 where schemaname = 'public' and tablename = 'purchase_demand_items'
                                   and cmd in ('UPDATE', 'ALL'))
              then '❌ RLS 開著但沒有 UPDATE policy —— 回寫會靜默失敗'
              else '✅ 改得動（或 RLS 沒開）' end

  -- ══════════ 6 · ★★★ 哪些函式提到 purchase_demand ══════════
  union all
  select 600, '6 函式', '★★★ 定義裡提到 purchase_demand 的函式',
         coalesce((select string_agg(fn || '（' ||
                     concat_ws('+',
                       case when def ilike '%requested%' then 'requested' end,
                       case when def ilike '%''done''%'  then 'done' end,
                       case when def ilike '%reject%'    then 'reject' end,
                       case when def ilike '%cancel%'    then 'cancel' end) || '）', E'\n'
                     order by fn) from fns), '（一支都沒有）'),
         case when exists (select 1 from fns)
              then 'ℹ 第 7 區有它們的完整定義'
              else '⚠ 沒有任何函式碰需求單 —— 那段註解是錯的，狀態全靠前端' end

  -- ══════════ 7 · 那幾支的完整定義 ══════════
  union all
  select 700 + row_number() over (order by fn), '7 定義', fn,
         def, 'ℹ 真相在這裡'
    from fns

  -- ══════════ 8 · ★★★ 資料的母體（0 的話上面驗的只是形狀） ══════════
  union all
  select 800, '8 資料', '★★★ 需求單與項目各有幾筆',
         (select count(*)::text from public.purchase_demands) || ' 張需求單，'
           || (select count(*)::text from items) || ' 個項目',
         /*
          * ★★★ 母體要判定，不能只當參考值。
          *   0 筆的話上面每一條驗到的都只是欄位與觸發器的「形狀」，
          *   沒有任何一筆資料證明過它會怎麼跑
          *   （CLAUDE.md：自檢的母體是空的 → 每一條都回綠）。
          */
         case when (select count(*) from items) = 0
              then '⚠ 一個項目都沒有 —— 上面驗的只是形狀，沒有資料證明過'
              else '✅ 有資料' end

  union all
  select 810, '8 資料', '項目的狀態分佈',
         coalesce((select string_agg(status::text || '：' || n::text || ' 筆', '、' order by status)
                     from (select status, count(*) as n from items group by status) s), '（沒有資料）'),
         'ℹ 對照第 2 區的 check'

  union all
  select 820, '8 資料', '★ 有接到請款項目的有幾筆',
         case when exists (select 1 from information_schema.columns
                            where table_schema = 'public' and table_name = 'purchase_demand_items'
                              and column_name = 'request_item_id')
              then (select count(*) filter (where request_item_id is not null)::text from items) || ' 筆'
              else '（沒有 request_item_id 這一欄）' end,
         /*
          * ★ 這條路從來沒被走過的話，這一格會是 0。
          *   那代表「請款單被駁回時自動退回」那句話**從來沒有被執行過**，
          *   就算觸發器真的存在也沒有實績。
          */
         case when not exists (select 1 from information_schema.columns
                                where table_schema = 'public' and table_name = 'purchase_demand_items'
                                  and column_name = 'request_item_id') then '—'
              when (select count(*) filter (where request_item_id is not null) from items) = 0
              then '⚠ 0 筆 —— 這條路從來沒有被走過'
              else '✅ 走過' end

) v(ord, "區塊", "項目", "內容", "判定")
order by v.ord;
