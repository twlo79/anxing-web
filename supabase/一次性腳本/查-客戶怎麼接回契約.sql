/*
 * 查-客戶怎麼接回契約.sql　2026-09-16
 *
 * 【為什麼查這個】
 * 使用者：「可上傳契約，同步到客戶管理『有租約』。」
 *
 * ★★★ 要在客戶管理標「有租約」，得先知道**客戶是怎麼接回契約的** ——
 *   有一欄 contract_id，還是只靠姓名＋房號對？
 *   靠姓名對的話，同名同姓或改過名字就會接錯，
 *   而症狀是**別人的契約出現在這個人底下**，比沒有這個功能更糟。
 *
 * ★★ 這支**只讀不寫**，跑幾次都一樣，也不會被關帳擋。
 *   看過這張表我才決定「有租約」怎麼接，然後才寫 migration。
 *   憑印象寫既有函式的簽章是 2026-09-03 踩過的坑，不再犯。
 *
 * 【怎麼跑】整份貼進 Supabase SQL Editor，把表格貼回來。
 *   ★ 最後一段是 sync_customers() 的完整定義，會很長 ——
 *     那一格點開再複製就好，不用整份貼回來，貼前 2000 字也行。
 */

with cols as (
  select table_name, column_name, data_type, is_nullable
  from information_schema.columns
  /* ★ 一定要帶 table_schema —— properties／customers 這種名字在別的 schema 也有 */
  where table_schema = 'public'
    and table_name in ('customers', 'contracts')
),
bk as (
  select id, public::text as is_public, coalesce(file_size_limit::text, '—') as size_limit
  from storage.buckets
),
fn as (
  select p.oid, p.proname,
         pg_get_function_identity_arguments(p.oid) as args,
         pg_get_functiondef(p.oid) as def
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    /* ★ 一定要濾 prokind —— 掃到聚合函式會整支炸掉（2026-09-01 踩過） */
    and p.prokind in ('f', 'p')
    and p.proname in ('sync_customers')
)

select * from (

  /* ───────── 1. 客戶表有沒有指回契約的欄位 ───────── */
  select 1 as "#", '① 客戶→契約的接點' as "區塊",
         coalesce(
           (select string_agg(column_name, '、' order by column_name) from cols
             where table_name = 'customers'
               and (column_name ~ 'contract|order|src|source|ref')),
           '（一個都沒有）') as "名稱",
         case when exists (
                select 1 from cols where table_name = 'customers' and column_name = 'contract_id')
              then '✅ 有 contract_id —— 直接用它接，不會接錯人'
              else '⚠ 沒有 contract_id —— 得看 sync_customers 是拿什麼對的（見 ⑤）。'
                   || '靠姓名對的話我不會做這個功能，會先改成用 id 接。' end as "判定"

  union all
  /* ───────── 2. 客戶表所有欄位 ───────── */
  select 2, '② customers 全部欄位',
         (select string_agg(column_name || '(' || data_type || ')', '、' order by ordinal_position)
            from information_schema.columns
           where table_schema = 'public' and table_name = 'customers'),
         '—'

  union all
  /* ───────── 3. 契約表有沒有已經在放檔案的欄位 ───────── */
  select 3, '③ contracts 有沒有檔案欄位',
         coalesce(
           (select string_agg(column_name || '(' || data_type || ')', '、' order by column_name)
              from cols where table_name = 'contracts'
                and (column_name ~ 'file|doc|attach|scan|path|url|storage')),
           '（一個都沒有）'),
         case when exists (
                select 1 from cols where table_name = 'contracts'
                  and column_name ~ 'file|doc|attach|scan|path|url|storage')
              then '⚠ 已經有了 —— 先看清楚在放什麼，不要另外開一份（一份資料存兩個地方）'
              else '✅ 乾淨的，新開一張 contract_files 表' end

  union all
  /* ───────── 4. 現有的 bucket ───────── */
  select 4, '④ 現有 Storage bucket',
         coalesce((select string_agg(id || '(' || case when is_public = 'true' then '公開' else '私有' end || ')',
                                     '、' order by id) from bk), '（沒有 bucket）'),
         case when exists (select 1 from bk where id = 'contracts')
              then '⚠ contracts 這個 bucket 已經存在 —— 先看它現在裝什麼'
              else '✅ 沒有 contracts，新建一個私有的' end

  union all
  /* ───────── 5. sync_customers 是拿什麼對的 ───────── */
  select 5, '⑤ sync_customers 的簽章',
         coalesce((select proname || '(' || args || ')' from fn), '（找不到這支函式）'),
         case when not exists (select 1 from fn)
              then '⚠ 找不到 —— 客戶管理那頁呼叫的是 rpc(''sync_customers'')，名字對不上就有別的問題'
              when exists (select 1 from fn where def ~* 'contract_id')
              then '✅ 定義裡有提到 contract_id'
              else '⚠ 定義裡沒有 contract_id —— 看 ⑥ 那一格，它是拿什麼欄位對的' end

  union all
  /* ───────── 6. 完整定義（點開那一格看） ───────── */
  select 6, '⑥ sync_customers 完整定義',
         '↓ 點開右邊那一格',
         coalesce((select def from fn), '（找不到）')

) t order by t."#";
