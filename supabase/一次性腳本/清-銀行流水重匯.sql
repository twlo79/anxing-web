-- 清空銀行流水，準備重匯
--
-- ============================================================
-- ⚠️ 這一份**會刪掉所有銀行流水**。可以重複使用。
--
--    刪 bank_transactions 與 bank_statements。
--    **bank_accounts 不動** —— 三個帳戶、期初餘額都留著。
--    來源是網銀下載的 PDF，重拖一次就回來了。
-- ============================================================
--
-- 【什麼時候需要】
--
-- 解析規則改了的時候。改規則之後，舊資料是用舊規則產生的 ——
-- 而**兩套規則混在同一張表裡，看不出哪一筆是哪一套**。
--
-- 2026-08-18 這一輪就改了三次:
--
--   ① 主列的備註原本被丟掉（「7月A棟租金」「京饌企業有限公司」）
--   ② 餘額從「照抄 PDF」改成「我們自己算」
--   ③ 對方帳號從摘要裡分出來成獨立欄位（ref_no）——
--      規則還改過兩次:先是「上一行才是帳號」,後來發現
--      水費戶號印在主列,改成「行首連續的 7 碼以上數字」
--
-- **不能直接重傳蓋過去。** 去重鑰匙裡有 bank_balance,
-- 而規則改動可能讓同一筆算出不同的鑰匙 —— 那時舊的留著、新的也進來,
-- 同一筆變兩份,而畫面上只會說「新增 N 筆」,看起來很正常。
--
--
-- 【比畫面上的「撤銷這一批」快在哪】
--
-- `/accounts` → 匯入紀錄 → 每一批都有「撤銷這一批」,
-- 那是平常該用的方式（一次只想撤一份的時候）。
--
-- 但全部重來要點十幾次 —— 這份腳本一次清完。


-- ── ① 先看要刪什麼 ─────────────────────────────────
select
  a.name                                   as "帳戶",
  s.period_from || ' ~ ' || s.period_to    as "期間",
  s.file_name                              as "檔名",
  (select count(*) from public.bank_transactions t where t.statement_id = s.id) as "筆數",
  to_char(s.uploaded_at, 'MM/DD HH24:MI')  as "上傳時間"
from public.bank_statements s
join public.bank_accounts a on a.id = s.account_id
order by a.sort, s.period_from;


-- ── ② 刪 ───────────────────────────────────────────
/*
 * 每次都重建一份「刪掉了什麼」的紀錄 —— **這是重拖時的清單**。
 * 刪完才想起來要拖哪幾個檔案的話,就只能憑印象去翻資料夾了。
 *
 * 用 drop + create 不用 create if not exists:
 * 這份腳本會重複執行,舊的那份留著會讓人拖到過期的清單。
 */
drop table if exists public.bank_statements_last_wipe;
create table public.bank_statements_last_wipe as
select s.*, a.name as account_name,
       (select count(*) from public.bank_transactions t where t.statement_id = s.id) as txn_count,
       now() as wiped_at
  from public.bank_statements s
  join public.bank_accounts a on a.id = s.account_id;

comment on table public.bank_statements_last_wipe is
  '最近一次清空前的對帳單清單。**重拖時照著這張表對。**'
  '每次執行「清-銀行流水重匯.sql」都會重建。';

do $$
declare n_txn int; n_stmt int;
begin
  select count(*) into n_txn  from public.bank_transactions;
  select count(*) into n_stmt from public.bank_statements;
  delete from public.bank_transactions;
  delete from public.bank_statements;
  raise notice '已刪除 % 筆流水、% 份對帳單', n_txn, n_stmt;
end $$;


-- ── ③ 自檢 ─────────────────────────────────────────
do $$
declare n int; m int;
begin
  drop table if exists _chkwipe;
  create temp table _chkwipe (ord int, item text, result text, detail text);

  select count(*) into n from public.bank_transactions;
  insert into _chkwipe values (1, '流水', n || ' 筆',
    case when n = 0 then '已清空' else '★ 還有殘留' end);

  select count(*) into n from public.bank_statements;
  insert into _chkwipe values (2, '對帳單', n || ' 份',
    case when n = 0 then '已清空' else '★ 還有殘留' end);

  /*
   * ★★ 帳戶主檔不可以被刪到。
   * 期初餘額沒了的話,重匯之後第一筆的餘額接不上任何東西。
   */
  select count(*) into n from public.bank_accounts;
  select count(*) into m from public.bank_accounts where opening_balance is not null;
  insert into _chkwipe values (3, '★★ 帳戶主檔', n || ' 個（' || m || ' 個有期初）',
    case when n = 3 then '三個帳戶都在,期初餘額也還在'
         else '★ 應該是 3 個 —— 帳戶被刪到了' end);

  select count(*) into n from public.bank_statements_last_wipe;
  insert into _chkwipe values (4, '★ 要重拖幾份', n || ' 份',
    '清單在 bank_statements_last_wipe —— 下面那張表列出來了');
end $$;

select item as "檢查項目", result as "結果", detail as "說明"
from _chkwipe order by ord;


-- ── ④ 要重拖哪些檔案 ───────────────────────────────
select
  account_name                          as "帳戶",
  period_from || ' ~ ' || period_to     as "期間",
  coalesce(file_name, '（沒記檔名）')     as "檔名",
  txn_count                             as "原本筆數"
from public.bank_statements_last_wipe
order by account_name, period_from;


-- ============================================================
-- ⑤ 重拖完之後，跑這一段驗收
-- ============================================================
/*
 * **筆數應該一模一樣。**
 *
 * 這幾次改的都是「某個欄位怎麼填」，不是「哪幾列算交易」——
 * 所以筆數不該變。變了就代表解析漏了或多了，那要查。
 */
select
  coalesce(b.account_name, a.name)                        as "帳戶",
  coalesce(b.period_from, s.period_from) || ' ~ ' ||
  coalesce(b.period_to,   s.period_to)                    as "期間",
  b.txn_count                                             as "清掉之前",
  (select count(*) from public.bank_transactions t where t.statement_id = s.id) as "重匯後",
  case
    when s.id is null then '❌ 還沒重拖'
    when b.txn_count is null then '⚠ 新的（清掉之前沒有這一份）'
    when b.txn_count = (select count(*) from public.bank_transactions t where t.statement_id = s.id)
      then '✅'
    else '❌ 筆數不一樣'
  end                                                     as "結果"
from public.bank_statements_last_wipe b
full join public.bank_statements s
       on s.account_id = b.account_id
      and s.period_from = b.period_from
      and s.period_to   = b.period_to
left join public.bank_accounts a on a.id = s.account_id
order by 1, 2;


-- ★ 三個新欄位有沒有填進去
select
  a.name                                                   as "帳戶",
  count(*)                                                 as "總筆數",
  count(*) filter (where t.memo is not null and t.memo <> '')       as "有摘要",
  count(*) filter (where t.ref_no is not null and t.ref_no <> '')   as "有對方帳號",
  count(*) filter (where t.balance_note is not null)                as "餘額有備註"
from public.bank_transactions t
join public.bank_accounts a on a.id = t.account_id
group by a.name, a.sort
order by a.sort;
