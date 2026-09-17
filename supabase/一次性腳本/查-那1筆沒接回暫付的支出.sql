/*
 * 查-那1筆沒接回暫付的支出.sql　2026-09-17（只讀不寫）
 *
 * ══════════════════════════════════════════════════════════
 * 【migration_266 跑完之後剩下的兩個 1】
 *
 *   ④ 沒接回暫付的支出　1 筆
 *   ⑥ 支出的帳本跟它那張單對不起來　1 筆
 *
 * ★★ 我推測那是**同一列**，但那是推測 —— 第 ① 列去證實它。
 *
 * ══════════════════════════════════════════════════════════
 * 【為什麼 266 沒補到它】
 *
 * 266 的迴圈條件是 `advance_for_book is null` —— 只走「沒勾的單」。
 * 而 075 與 077 **本來就勾著**，迴圈根本沒進去過它們。
 * 所以如果那一列掛在 075／077 底下，266 不會碰它，
 * 它是**觸發器當初就漏掉的**，跟這次無關。
 *
 * ★ 這件事要證實，不能用講的:第 ② 列印出它掛在哪一張單。
 *
 * ══════════════════════════════════════════════════════════
 * 【為什麼不直接寫一支 migration 補】
 *
 * 因為不知道它為什麼長這樣。兩種可能，處理方式相反:
 *
 *   甲　有人手動把 book 改掉了（或建立時就錯）
 *       → 它其實是愛皮的錢,要改回 aipi 並接上暫付
 *
 *   乙　它本來就該記在安幸帳上（例如那張單有一項是安幸自己的）
 *       → 那 book 是對的,但**暫付的金額就多算了那一筆**,
 *         要改的是暫付的金額，不是這一列
 *
 * ★★★ 第 ④ 列在分辨這件事:比對「暫付金額」與「那張單在 aipi 帳上的支出加總」。
 *   差額剛好等於那一筆 → 乙。一樣 → 甲。
 *
 * ★ 這支**只讀不寫**，跑幾次都一樣。
 * ══════════════════════════════════════════════════════════
 */

with other_pr as (
  select pr.id, pr.req_no, pr.book, pr.advance_for_book, pr.payout_account, pr.purchased_on
    from public.purchase_requests pr
   where coalesce(pr.book, 'anxing') <> 'anxing'
     and pr.status = 'approved' and pr.purchased_on is not null
     and exists (select 1 from public.expenses e where e.request_id = pr.id)
),
bad as (
  /* 兩種毛病各自撈，之後比對是不是同一列 */
  select e.id, e.spent_on, e.item_name, abs(e.amount)::int as amt,
         coalesce(e.book, 'anxing') as ex_book, e.advance_id,
         p.req_no, p.book as pr_book, p.advance_for_book,
         (e.advance_id is null and p.advance_for_book is not null) as no_link,
         (coalesce(e.book, 'anxing') is distinct from p.book)      as book_gap
    from public.expenses e
    join other_pr p on p.id = e.request_id
   where (e.advance_id is null and p.advance_for_book is not null)
      or (coalesce(e.book, 'anxing') is distinct from p.book)
),
lend as (
  select a.request_id, a.amount::int as amt
    from public.advance_payments a where a.category = '代墊'
),
/* 每張單：暫付金額 vs 它在「單的帳本」上的支出加總 */
cmp as (
  select p.req_no, p.id,
         coalesce((select amt from lend where lend.request_id = p.id), 0) as lend_amt,
         coalesce((select sum(abs(e.amount))::int from public.expenses e
                    where e.request_id = p.id and coalesce(e.book, 'anxing') = p.book), 0) as ex_same,
         coalesce((select sum(abs(e.amount))::int from public.expenses e
                    where e.request_id = p.id), 0) as ex_all
    from other_pr p
   where p.advance_for_book is not null
)

select * from (

  /*
   * ★ 母體要判定。一列都撈不到的話，那兩個 1 已經不在了
   *   （有人手動修過），下面全部不算數。
   */
  select 1 as ord, '① 那兩個「1 筆」是同一列嗎' as "檢查",
         (select count(*)::text from bad) || ' 列有毛病　│ 兩種毛病都有的 '
         || (select count(*) filter (where no_link and book_gap) from bad)::text
         || ' 列　│ 只有沒接回暫付的 '
         || (select count(*) filter (where no_link and not book_gap) from bad)::text
         || ' 列　│ 只有帳本對不起來的 '
         || (select count(*) filter (where book_gap and not no_link) from bad)::text
         || ' 列' as "結果",
         case when (select count(*) from bad) = 0
              then '⚠ **一列都撈不到 —— 下面全部不算數**。266 之後有人改過資料？'
              when (select count(*) filter (where no_link and book_gap) from bad)
                 = (select count(*) from bad)
              then '✅ 同一列 —— 兩個症狀一個原因,修一次就好'
              else '⚠ 不是同一列 —— 有 ' || (select count(*) from bad)
                   || ' 列各自有不同的毛病,要分開看' end as "判定"

  union all
  /*
   * ★★★ 那一列長什麼樣、掛在哪一張單。
   *   掛在 075／077 的話,證實它是觸發器當初就漏的,跟 266 無關。
   */
  select 2, '② 那一列的全貌',
         coalesce((select string_agg(
                     req_no || '｜' || spent_on::text || '｜' || left(item_name, 24)
                     || ' $' || amt
                     || '｜支出記在 [' || ex_book || ']　單是 [' || coalesce(pr_book, '?') || ']'
                     || case when advance_id is null then '　**沒接暫付**' else '　有接' end,
                     E'\n' order by spent_on, item_name) from bad), '（沒有）'),
         case when not exists (select 1 from bad) then '⚠ 沒有'
              when exists (select 1 from bad where req_no <> 'PR-202608-086')
              then '✅ 掛在 ' || (select string_agg(distinct req_no, '、') from bad
                                  where req_no <> 'PR-202608-086')
                   || ' —— 那張本來就勾著,266 的迴圈沒走到它。'
                   || '**這是觸發器當初就漏的,不是這次造成的**'
              else '⚠ 掛在 086 —— 那就是 266 沒補乾淨,要看是哪一步漏了' end

  union all
  /*
   * ★★ 同一張單上其他的支出長什麼樣 —— 拿來當「對的樣子」。
   *   同一張單上有接、也有沒接的話，差別在哪就看得出來。
   */
  select 3, '③ 同一張單上其他幾筆（對照）',
         coalesce((select string_agg(
                     left(e.item_name, 22) || ' $' || abs(e.amount)::int
                     || ' [' || coalesce(e.book, 'anxing') || ']'
                     || case when e.advance_id is null then ' 沒接' else ' 有接' end,
                     E'\n' order by e.item_name)
                    from public.expenses e
                   where e.request_id in (select distinct id from other_pr p
                                           where p.req_no in (select req_no from bad))),
                  '（撈不到）'),
         '參考 —— 跟第 ② 列那一筆比，差在哪一欄'

  union all
  /*
   * ★★★ 這一列是答案:那筆錢該不該算進代墊。
   *
   *   暫付金額 == 同帳本支出加總　→ 暫付沒算那一筆 → **乙**（book 是對的，
   *                                 那筆不是代墊，只要把 advance_id 留空就好）
   *   暫付金額 == 全部支出加總　　→ 暫付算了那一筆 → **甲**（book 錯了，要改回來）
   */
  select 4, '④ 暫付的金額，把那一筆算進去了嗎',
         coalesce((select string_agg(
                     req_no || '：暫付 $' || lend_amt
                     || '　同帳本支出 $' || ex_same
                     || '　全部支出 $' || ex_all, E'\n' order by req_no)
                    from cmp where lend_amt > 0), '（沒有代墊的單）'),
         case when not exists (select 1 from cmp where lend_amt > 0)
              then '⚠ 沒有可比的'
              when exists (select 1 from cmp where lend_amt = ex_all and ex_all <> ex_same)
              then '→ **甲**:暫付算了那一筆,代表它本來就該是愛皮的錢。'
                   || '要把那一列的 book 改回去並接上暫付'
              when exists (select 1 from cmp where lend_amt = ex_same and ex_all <> ex_same)
              then '→ **乙**:暫付沒算那一筆,代表它本來就記在安幸帳上。'
                   || 'book 是對的,advance_id 留空也是對的 —— 那 ④⑥ 是誤報,要改的是自檢'
              when exists (select 1 from cmp where lend_amt <> ex_same and lend_amt <> ex_all)
              then '❌ 兩邊都對不上 —— 暫付的金額跟任何一種加總都不一樣,'
                   || '那張單中間被改過,要一筆一筆看'
              else '✅ 同帳本與全部一樣多 —— 沒有帳本對不起來的問題' end

  union all
  /*
   * ★ 順便確認 265 到底跑了沒（自檢第 ⑦ 列說缺 265）。
   *   ★★ 不要憑對話紀錄判斷 migration 跑了沒（README 2026-09-05）。
   */
  select 5, '⑤ 265 跑了沒',
         coalesce((select name from public.schema_migrations
                    where name like '265%'), '（沒有 265）'),
         case when exists (select 1 from public.schema_migrations where name like '265%')
              then '✅ 跑過了'
              else '❌ **還沒跑**。活動那一批（上傳開關、代上傳、活動通知）'
                   || '要它才會動 —— 貼 migration_265_board_events_v2.sql' end

) v(ord, "檢查", "結果", "判定") order by v.ord;
