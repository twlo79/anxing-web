/*
 * audit_bank_txn_rls —— 誰改得動 bank_transactions.balance（唯讀）
 * ============================================================
 * 2026-09-02 使用者：元大 08311 三筆存入共 $51,083，每一列餘額都是 $0。
 *
 * ============================================================
 * 【最可能的原因】
 *
 * 新增流水是**兩步**（`accounts/page.tsx`）:
 *
 *   1. insert，`balance` 先塞 **0** 佔位（欄位 not null，不能不給）
 *   2. 重算全部餘額 → 一列一列 update 寫回
 *
 * ★★★ 而第 2 步的 update **原本只檢查 error，沒檢查影響列數**。
 *   RLS 擋下的 UPDATE 回成功而且影響 0 列（CLAUDE.md 的坑）——
 *   於是餘額全部停在佔位的 0，畫面還說「已儲存」。
 *
 *   INSERT 過得了、UPDATE 過不了，是完全可能的:那是兩條不同的 policy。
 *
 * ★ 前端那一段今天已經補上檢查，但那只會讓**下一次**出錯時叫出來。
 *   這支是要確認**現在**是不是這個原因，以及該補哪一條 policy。
 *
 * 整份照貼。只有 select。
 */

-- ① bank_transactions 的 policy 長什麼樣
select
  p.polname                                   as "policy",
  case p.polcmd
    when 'r' then 'SELECT' when 'a' then 'INSERT'
    when 'w' then 'UPDATE' when 'd' then 'DELETE'
    when '*' then '全部'   else p.polcmd::text end as "管到哪個動作",
  pg_get_expr(p.polqual, p.polrelid)          as "using 條件",
  pg_get_expr(p.polwithcheck, p.polrelid)     as "with check 條件"
from pg_policy p
join pg_class c on c.oid = p.polrelid
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname = 'bank_transactions'
order by p.polcmd, p.polname;


-- ② 那三筆的實際資料 ＋ 現場算一次餘額
/*
 * ★ 「現場算的餘額」不看 balance 欄位，是用存入減支出累加出來的。
 *   跟「存起來的餘額」不一樣就代表寫回那一步沒成功。
 */
select
  t.post_date                                 as "帳務日",
  t.seq                                       as "序",
  left(t.description, 30)                     as "摘要",
  t.credit                                    as "存入",
  t.debit                                     as "支出",
  t.balance                                   as "存起來的餘額",
  sum(coalesce(t.credit, 0) - coalesce(t.debit, 0))
    over (order by t.post_date, coalesce(t.seq, 0), t.id)
    + coalesce(a.opening_balance, 0)          as "★ 現場算的餘額",
  a.opening_balance                           as "帳戶期初",
  t.created_at                                as "建立時間"
from public.bank_accounts a
join public.bank_transactions t on t.account_id = a.id
where a.account_no_tail = '08311'
order by t.post_date, coalesce(t.seq, 0);


-- ③ 全部帳戶掃一次：還有誰的餘額也是壞的
/*
 * ★★ 只修 08311 就以為結束了，是今天早上 hk_task 那個錯的翻版
 *   （CLAUDE.md 2026-09-02 那條:掃全部，不要列表名）。
 */
select
  a.name                                      as "帳戶",
  a.account_no_tail                           as "末碼",
  case when a.manual_entry then '手動' else '上傳對帳單' end as "記帳方式",
  count(*)                                    as "流水筆數",
  count(*) filter (where coalesce(t.balance, 0) = 0
                     and coalesce(t.credit, 0) + coalesce(t.debit, 0) > 0)
                                              as "★ 有金額但餘額是 0 的筆數",
  coalesce(sum(t.credit), 0) - coalesce(sum(t.debit), 0)
    + coalesce(max(a.opening_balance), 0)     as "該有的期末餘額"
from public.bank_accounts a
join public.bank_transactions t on t.account_id = a.id
group by a.id, a.name, a.account_no_tail, a.manual_entry
order by 5 desc, a.name;
