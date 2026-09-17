/*
 * 查-代墊為何只有2筆.sql　2026-09-17（第二輪）
 *
 * 【第一輪查到什麼 —— 我的推論被推翻了】
 *
 * 我原本說「那幾筆沒掛請款單，所以不會有代墊」。**錯了**：
 *   9/07～9/09 的 75 筆裡，**72 筆有 request_id**。
 *
 * 真正刺眼的是第 ④ 列：
 *   有請款單的支出 **195 筆**，而代墊暫付只有 **2 筆（$11,880）**。
 *
 * ══════════════════════════════════════════════════════════
 * 【現在要問的是另一個問題】
 *
 * `gen_expenses_from_pr` 產生代墊的條件不只是「有請款單」，還要：
 *
 *   ① 那張單的帳本**不是安幸**（`canLend` ＝ `isOtherBook`）
 *      —— 安幸自己的錢付安幸的費用，本來就沒有代墊這回事
 *   ② 那張單**勾了「安幸代墊」**（`advance_for_book` 有值）
 *
 * 所以 195 → 2 的落差可能是：
 *   甲　那 195 筆大多是**安幸自己的單** → 沒有代墊是**對的**
 *   乙　愛皮／洪鯊的單**沒有勾「安幸代墊」** → 那才是漏的
 *
 * ★★★ 甲與乙的處理完全不同：
 *   甲 不用改任何東西。
 *   乙 是流程漏了，而且**每一張漏勾的單，安幸都少記一筆應收**。
 *
 * ══════════════════════════════════════════════════════════
 * 【還有第三種可能】
 *
 * 第 ⑤ 列查到一筆**零用金 $30,000 未收回**，而第 ⑥ 列有 61 筆支出
 * 備註寫著「零用金」。如果愛皮的花費是從那筆零用金裡出的，
 * 那**不勾代墊是對的** —— 錢早就給出去了，不是一筆一筆代墊。
 *
 * 第 ④⑤ 列就在分辨這件事。
 *
 * ★ 這支**只讀不寫**，跑幾次都一樣。
 * ══════════════════════════════════════════════════════════
 */

with pr as (
  select r.id, r.req_no, r.book, r.advance_for_book, r.status, r.total_amount
  from public.purchase_requests r
),
ex as (
  select e.id, e.spent_on, e.item_name, e.amount, e.note, e.book, e.request_id
  from public.expenses e
),
/* 有請款單的支出，照「那張單的帳本」分 */
by_book as (
  select coalesce(pr.book, '（單不見了）') as bk,
         count(*) as n,
         count(*) filter (where pr.advance_for_book is not null) as lent,
         sum(abs(ex.amount))::bigint as amt
  from ex join pr on pr.id = ex.request_id
  group by 1
),
/* 使用者圈起來的那幾筆：9/08 的電信費與旅平險 */
his as (
  select ex.spent_on, ex.item_name, abs(ex.amount)::int as amt, ex.book as ex_book,
         pr.req_no, pr.book as pr_book, pr.advance_for_book, pr.status
  from ex left join pr on pr.id = ex.request_id
  where ex.spent_on = date '2026-09-08'
    and (ex.item_name ilike '%電信費%' or ex.item_name ilike '%旅平險%')
),
petty as (
  select id, counterparty, amount, paid_on, refunded_amount, note
  from public.advance_payments where category = '零用金'
)

select * from (

  select 1 as ord, '① 有請款單的支出，照帳本分' as "檢查",
         coalesce((select string_agg(
                     bk || '：' || n || ' 筆 $' || amt
                     || '（勾了代墊的 ' || lent || ' 筆）', E'\n' order by bk)
                    from by_book), '（沒有）') as "結果",
         case when exists (select 1 from by_book where bk = '（單不見了）')
              then '⚠ 有支出掛著一張**找不到的請款單** —— 那是另一個問題'
              else '參考 —— 下面兩列在解讀它' end as "判定"

  union all
  /*
   * ★★★ 安幸自己的單本來就不該有代墊（book.ts 的 canLend）。
   *   所以要看的是**愛皮／洪鯊**那幾行。
   */
  select 2, '② 安幸自己的單（沒有代墊是對的）',
         coalesce((select bk || '：' || n || ' 筆 $' || amt from by_book where bk = 'anxing'),
                  '（沒有）'),
         case when coalesce((select lent from by_book where bk = 'anxing'), 0) > 0
              then '❌ 安幸自己的單竟然有 ' || (select lent from by_book where bk = 'anxing')
                   || ' 筆勾了代墊 —— 安幸不用跟自己借錢，那幾張要查'
              else '✅ 一筆都沒勾代墊 —— 對的' end

  union all
  /*
   * ★★★ 這一列是答案。
   *   愛皮／洪鯊的單有幾張勾了「安幸代墊」、幾張沒勾。
   */
  select 3, '③ 愛皮／洪鯊的單，有幾張勾了「安幸代墊」',
         coalesce((select string_agg(
                     bk || '：' || n || ' 筆中有 ' || lent || ' 筆勾了', '　' order by bk)
                    from by_book where bk <> 'anxing' and bk <> '（單不見了）'),
                  '（愛皮洪鯊一筆有單的支出都沒有）'),
         case when not exists (select 1 from by_book where bk not in ('anxing', '（單不見了）'))
              then '⚠ 愛皮洪鯊一筆都沒有 —— 那 195 筆全是安幸的,沒有代墊完全正常'
              when (select sum(lent) from by_book where bk not in ('anxing', '（單不見了）')) = 0
              then '❌ 一張都沒勾 —— 而愛皮洪鯊有 '
                   || (select sum(n) from by_book where bk not in ('anxing', '（單不見了）'))
                   || ' 筆支出走安幸的錢。要嘛是漏勾,要嘛是走零用金（看第 ⑤ 列）'
              when (select sum(lent) from by_book where bk not in ('anxing', '（單不見了）'))
                 < (select sum(n) from by_book where bk not in ('anxing', '（單不見了）'))
              then '⚠ 有勾也有沒勾 —— **同一種單兩種做法**,要確認哪一種才對'
              else '✅ 全部都勾了' end

  union all
  /*
   * ★★ 使用者圈的就是這幾筆。直接把它們的單號與勾選狀態印出來。
   */
  select 4, '④ 你圈的那幾筆（9/08 電信費・旅平險）',
         coalesce((select string_agg(
                     left(item_name, 26) || ' $' || amt
                     || ' [' || coalesce(ex_book, '?') || ']'
                     || ' 單=' || coalesce(req_no, '無')
                     || ' 代墊=' || coalesce(advance_for_book, '沒勾'),
                     E'\n' order by item_name) from his), '（那幾筆撈不到）'),
         case when not exists (select 1 from his)
              then '⚠ 撈不到 —— 日期或品名對不上,把畫面上的日期跟我講'
              when exists (select 1 from his where req_no is null)
              then '⚠ 其中有沒掛單的'
              when not exists (select 1 from his where advance_for_book is not null)
              then '❌ 全部都沒勾「安幸代墊」—— 這就是沒有暫付的原因'
              else '✅ 有勾' end

  union all
  /*
   * ★★★ 第三種可能：錢是從零用金出的，不是一筆一筆代墊。
   *   ★ 母體要判定 —— 沒有零用金的話這一列證明不了任何事。
   */
  select 5, '⑤ 零用金：給了誰、剩多少',
         coalesce((select string_agg(
                     counterparty || ' $' || amount::int
                     || '（已收回 ' || coalesce(refunded_amount, 0)::int || '）'
                     || coalesce('　' || left(note, 20), ''), '　' order by paid_on)
                    from petty), '（一筆零用金都沒有）'),
         case when not exists (select 1 from petty)
              then '⚠ 沒有零用金 —— 那「零用金撥補」那批不是在花零用金,第 ③④ 列的漏勾才是原因'
              else '✅ 有零用金 —— 如果那批支出是從這裡出的,不勾代墊是**對的**。'
                   || '要確認的話：把第 ⑥ 列的金額跟這筆的餘額對一次' end

  union all
  select 6, '⑥ 備註寫「零用金」的支出，總共花了多少',
         (select count(*)::text from ex where note ilike '%零用金%')
         || ' 筆　$' ||
         coalesce((select sum(abs(amount))::bigint::text from ex where note ilike '%零用金%'), '0'),
         case when (select count(*) from ex where note ilike '%零用金%') = 0
              then '⚠ 一筆都沒有'
              when coalesce((select sum(abs(amount)) from ex where note ilike '%零用金%'), 0)
                 > coalesce((select sum(amount) from petty), 0)
              then '⚠ 花掉的比給出去的零用金**還多** —— 那中間一定有撥補,'
                   || '而撥補如果沒有記成暫付,安幸那邊就少記了應收'
              else '✅ 花掉的沒有超過零用金' end

) v(ord, "檢查", "結果", "判定") order by v.ord;
