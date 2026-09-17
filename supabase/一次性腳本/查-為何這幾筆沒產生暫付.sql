/*
 * 查-為何這幾筆沒產生暫付.sql　2026-09-17
 *
 * 【使用者問】2026-09-17：「為何這幾筆沒有進 安幸的暫付？」
 *   （其他收支帳上 2026-09-08 那批電信費／旅平險，備註寫「8/10-零用金撥補」）
 *
 * ══════════════════════════════════════════════════════════
 * 【我從程式碼看到的 —— 但**還沒證實**】
 *
 * `lib/advance.ts` 的註解寫著：
 *
 *   「代墊」不在手動清單裡:它**只由請款單的觸發器產生**
 *   （`gen_expenses_from_pr`，勾了「安幸代墊」時）。
 *
 * 而前端**沒有任何一處** insert `advance_payments`（整份 src 掃過）。
 * 所以推論是：那幾筆支出**沒有掛請款單**，`gen_expenses_from_pr` 從來沒跑到它們，
 * 於是不會有代墊。
 *
 * ★★★ 但那是**註解**，不是事實。
 *   「只找到一條產生路徑就當成唯一的」是 README 記著的坑
 *   （2026-09-03 月租單那次:有兩支產生器，我只讀了資料庫那支）。
 *   所以這支的第 ③ 列**去問資料庫還有誰會寫 advance_payments**。
 *
 * ★★ 順帶一提：「撥補」這兩個字**整份程式碼裡都沒有** ——
 *   那是有人打在 `expenses.note` 裡的字，不是系統產生的標籤。
 *
 * ★ 這支**只讀不寫**，跑幾次都一樣。
 * ══════════════════════════════════════════════════════════
 *
 * 【怎麼看】第 ① 列是直接答案，②③④ 是證明它不是別的原因。
 */

with q as (
  /* 畫面上那一批：9/07 ～ 9/09 的支出 */
  select e.id, e.spent_on, e.item_name, e.amount, e.note,
         e.request_id, e.book
  from public.expenses e
  where e.spent_on between date '2026-09-07' and date '2026-09-09'
),
adv_writers as (
  /*
   * ★ prokind 一定要濾 —— 掃到聚合函式會整支炸掉（2026-09-01 踩過）
   * ★★ 用詞邊界,不要 ilike '%advance%'
   */
  select p.proname::text as name
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prokind in ('f', 'p')
    and pg_get_functiondef(p.oid) ~ '\madvance_payments\M'
),
adv as (
  select category, count(*) as n, sum(amount) as amt,
         count(*) filter (where refunded_on is null) as open_
  from public.advance_payments
  group by category
),
/* 對照組：有掛請款單的支出，真的產生代墊了嗎 */
control as (
  select
    (select count(*) from public.expenses where request_id is not null) as with_pr,
    (select count(*) from public.advance_payments where category = '代墊') as lend
)

select * from (

  select 1 as ord, '① 那一批支出有掛請款單嗎' as "檢查",
         (select count(*)::text from q) || ' 筆　│ 有 request_id 的 '
         || (select count(*) filter (where request_id is not null) from q)::text
         || ' 筆　│ 沒有的 '
         || (select count(*) filter (where request_id is null) from q)::text || ' 筆' as "結果",
         case when (select count(*) from q) = 0
              then '⚠ 那幾天一筆支出都撈不到 —— 日期範圍要調,下面全部不算數'
              when (select count(*) filter (where request_id is not null) from q) = 0
              then '✅ 全部都沒有請款單 —— 這就是答案:代墊只從請款單來'
              else '⚠ 有掛請款單的 —— 那它們理論上該有代墊,看第 ④ 列' end as "判定"

  union all
  select 2, '② 那幾筆長什麼樣（前 8 筆）',
         coalesce((select string_agg(
                     to_char(spent_on, 'MM/DD') || ' ' || left(item_name, 22)
                     || ' $' || abs(amount)::int
                     || ' [' || coalesce(book, '安幸') || ']'
                     || case when request_id is null then ' 無單' else ' 有單' end,
                     E'\n' order by spent_on desc, item_name)
                    from (select * from q order by spent_on desc limit 8) x), '（沒有）'),
         '參考 —— 對照畫面上那幾列'

  union all
  /*
   * ★★★ 這一列是重點:**還有誰會寫 advance_payments**。
   *   程式碼的註解說「只有 gen_expenses_from_pr」，
   *   而註解會過期。這裡問的是資料庫本人。
   */
  select 3, '③ 資料庫裡還有誰會寫 advance_payments',
         coalesce((select string_agg(name, '、' order by name) from adv_writers),
                  '（一支都沒有）'),
         case when not exists (select 1 from adv_writers)
              then '⚠ 一支函式都沒提到它 —— 那代墊是從哪來的？要再查觸發器'
              when (select count(*) from adv_writers) = 1
              then '✅ 只有一條產生路徑，跟程式碼註解說的一樣'
              else '⚠ 有 ' || (select count(*) from adv_writers)
                   || ' 支會寫它 —— 註解說「只有請款單」是**不完整的**，要一支一支看' end

  union all
  /*
   * ★★ 對照組。證明那條路徑是**活的** ——
   *   不然「沒有代墊」也可能是觸發器壞了，而不是「沒有請款單」。
   */
  select 4, '④ 對照組：那條路徑本身還活著嗎',
         '有請款單的支出 ' || (select with_pr from control) || ' 筆　│ 代墊暫付 '
         || (select lend from control) || ' 筆',
         case when (select with_pr from control) = 0
              then '⚠ 一筆有請款單的支出都沒有 —— 證明不了那條路徑活不活'
              when (select lend from control) = 0
              then '❌ 有請款單卻一筆代墊都沒有 —— 那是觸發器的問題，不是「沒掛單」'
              else '✅ 那條路徑是活的（產得出代墊）——'
                   || '所以第 ① 列的「沒掛單」才是真正的原因' end

  union all
  select 5, '⑤ 現在的暫付長什麼樣（照類別）',
         coalesce((select string_agg(
                     category || ' ' || n || ' 筆 $' || amt::int
                     || '（未收回 ' || open_ || '）', '　' order by category) from adv),
                  '（一筆暫付都沒有）'),
         case when not exists (select 1 from adv)
              then '⚠ 一筆都沒有'
              when exists (select 1 from adv where category = '零用金')
              then '✅ 有零用金 —— 那批「零用金撥補」的支出很可能是在花這筆,'
                   || '本來就不該再產生代墊（要確認的話看第 ⑥ 列）'
              else '✅ 參考' end

  union all
  /*
   * ★ 「撥補」是人打在 note 裡的字，不是系統標籤（整份 src 掃過沒有這兩個字）。
   *   所以這一列只是把打了那個字的支出數出來，讓使用者確認他看到的是哪一批。
   */
  select 6, '⑥ 備註裡寫「零用金」的支出有幾筆',
         (select count(*)::text from public.expenses where note ilike '%零用金%')
         || ' 筆　│ 其中 ' ||
         (select count(*)::text from public.expenses
           where note ilike '%零用金%' and request_id is null) || ' 筆沒有請款單',
         case when (select count(*) from public.expenses where note ilike '%零用金%') = 0
              then '⚠ 一筆都沒有 —— 那畫面上那個小標是別的來源,跟我講'
              else '參考 —— 這些是手打備註,不是系統分類' end

) v(ord, "檢查", "結果", "判定") order by v.ord;
