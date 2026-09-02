/*
 * audit_08311_balance —— 元大 08311 的餘額為什麼是 0（唯讀）
 * ============================================================
 * 2026-09-02 使用者：畫面上一筆存入 $30,000，餘額卻顯示 $0，卡片也是 $0。
 *
 * ============================================================
 * 【餘額是**存起來的**，不是每次算的】
 *
 * `bank_transactions.balance` 是一個欄位，由 `recalcBalances()`
 * （`src/lib/cash-txn.ts`）算好之後寫回去:
 *
 *     running = opening_balance
 *     每一列（照 post_date、seq 排）：running += 存入 − 支出，寫進 balance
 *
 * ★★★ 而**只有帳戶頁的現金表單會呼叫它**。
 *   新增流水時 `balance` 先塞 0 佔位（accounts/page.tsx:358 的註解寫著
 *   「正確的值在下面那一輪重算時補上」），再重算寫回。
 *
 *   所以任何**別的路徑**寫進來的流水，balance 會**永遠停在 0** ——
 *   而畫面不會報錯，只顯示一個 0。
 *
 * 【所以只有兩種可能，這支就是要分辨它們】
 *
 *   甲  那一列的 balance 真的是 0        → 它不是從帳戶頁存進去的，重算沒跑過
 *   乙  opening_balance 是 −30,000       → 重算跑過了，但期初被設成負的
 *
 * ★ 兩種的修法完全不同（甲要補重算並找出是誰寫的，乙只要改期初），
 *   所以**不能猜**。最後一欄會直接說是哪一種。
 *
 * 整份照貼，全選再按 Run。只有 select。
 */

select
  a.name                                  as "帳戶",
  a.account_no_tail                       as "末碼",
  a.kind                                  as "類型",
  a.manual_entry                          as "手動記帳",
  a.opening_balance                       as "期初餘額",
  t.post_date                             as "帳務日",
  t.seq                                   as "序",
  t.description                           as "摘要",
  t.debit                                 as "支出",
  t.credit                                as "存入",
  t.balance                               as "存起來的餘額",
  /*
   * ★ 這一欄是**現場算一次**，不看 balance 欄位。
   *   跟上一欄不一樣就代表存起來的那個是舊的／沒算過的。
   */
  sum(coalesce(t.credit, 0) - coalesce(t.debit, 0))
    over (order by t.post_date, coalesce(t.seq, 0), t.id)
    + coalesce(a.opening_balance, 0)      as "★ 現場算的餘額",
  case
    when t.balance = sum(coalesce(t.credit, 0) - coalesce(t.debit, 0))
                       over (order by t.post_date, coalesce(t.seq, 0), t.id)
                     + coalesce(a.opening_balance, 0)
      then '✅ 一致'
    when coalesce(a.opening_balance, 0) < 0
      then '⚠ 乙 期初是負的 —— 改期初就好'
    else '⚠⚠⚠ 甲 存起來的餘額沒被重算過 —— 這一列不是從帳戶頁存進去的'
  end                                     as "★ 是哪一種"
from public.bank_accounts a
join public.bank_transactions t on t.account_id = a.id
where a.account_no_tail = '08311'
order by t.post_date, coalesce(t.seq, 0);


-- ══════════════════════════════════════════════════════════
-- 順便掃全部帳戶,看還有沒有別的地方也是這樣
-- ══════════════════════════════════════════════════════════
/*
 * ★★ 只查 08311 的話，修好它就以為結束了 ——
 *   而同一個原因造成的別的帳戶還在那裡（CLAUDE.md:「掃全部，不要列表名」，
 *   2026-09-02 才因為 hk_task 踩過一次）。
 */
select
  a.name                                          as "帳戶",
  a.account_no_tail                               as "末碼",
  case when a.manual_entry then '手動' else '上傳對帳單' end as "記帳方式",
  count(*)                                        as "流水筆數",
  count(*) filter (where coalesce(t.balance, 0) = 0
                     and coalesce(t.credit, 0) + coalesce(t.debit, 0) > 0)
                                                  as "★ 餘額是 0 但有金額的筆數",
  coalesce(sum(t.credit), 0) - coalesce(sum(t.debit), 0)
    + coalesce(max(a.opening_balance), 0)         as "全部加總後該有的餘額",
  max(t.balance)                                  as "最大的存起來餘額"
from public.bank_accounts a
join public.bank_transactions t on t.account_id = a.id
group by a.id, a.name, a.account_no_tail, a.manual_entry
having count(*) filter (where coalesce(t.balance, 0) = 0
                          and coalesce(t.credit, 0) + coalesce(t.debit, 0) > 0) > 0
order by 5 desc;
