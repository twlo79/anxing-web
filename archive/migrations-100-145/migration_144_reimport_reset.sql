-- migration_144：清掉舊解析器匯進來的流水，準備重匯
--
-- ============================================================
-- ⚠️ 這一支**會刪掉所有銀行流水**（1570 筆）。
--    使用者已確認（2026-08-18）。整份貼進 SQL Editor 執行。
--
--    刪掉的是 bank_transactions 與 bank_statements。
--    **bank_accounts 不動** —— 三個帳戶、期初餘額都留著。
--    來源是網銀下載的 PDF，重拖一次就回來了。
-- ============================================================
--
-- 【為什麼要重匯】
--
-- 那 1570 筆是 migration_143 之前的**舊解析器**產生的，三個已知的錯:
--
--   ① **主列的備註被丟掉**
--      「7月A棟租金」「京饌企業有限公司 板信民權」「電視」「家具」
--      全部沒進資料庫 —— 而那是將來跟訂單對帳最值錢的欄位。
--
--      拿同一份 PDF 跑新舊兩版比較（實測）:
--
--          檔案         筆數   新版空白   舊版空白
--          70564          47     40.4%     63.8%
--          48088         198     36.9%     79.8%
--          24145-2607    132     11.4%     50.0%
--
--      而資料庫裡的實際空白比例是 63.2% / 55.4% / 51.8% ——
--      **跟舊版模擬出來的幾乎一樣**。大約一半的摘要從來沒進去過。
--
--   ② **戶號被當成餘額**
--      「媒體轉帳」那幾筆的水費戶號坐在餘額欄與備註欄中間，
--      被當成餘額 → 那一筆的餘額變成 1,040,077,312（十億）。
--
--   ③ **餘額照抄 PDF**
--      現在的規則是我們自己算（migration_143）。舊的照抄，
--      兩套規則混在同一欄 —— 而**看不出哪一筆是哪一套**。
--
-- ②③ 沒辦法從現有資料回推修正，只能重新解析。
--
--
-- ============================================================
-- 【為什麼不能直接重傳蓋過去】
--
-- 去重鑰匙裡有 bank_balance。②那幾筆存進去的是十億，
-- 新解析出來的是 1,872,877 —— **鑰匙不同，會被當成新的**。
--
-- 結果是壞的留著、好的也進來，同一筆變兩份，
-- 而畫面上只會說「新增 N 筆」，看起來很正常。
--
-- 所以順序是：先刪乾淨，再重傳。


-- ── 刪之前先留一份紀錄 ─────────────────────────────
/*
 * 刪掉之前先把「有哪些對帳單」印出來。
 *
 * **這是為了知道要重拖哪幾個檔案。**
 * 刪完才想起來的話，就只能憑印象去翻資料夾了。
 */
create table if not exists public.bank_statements_backup_144 as
select s.*, a.name as account_name,
       (select count(*) from public.bank_transactions t where t.statement_id = s.id) as txn_count
  from public.bank_statements s
  join public.bank_accounts a on a.id = s.account_id;

comment on table public.bank_statements_backup_144 is
  '刪除前的對帳單清單（migration_144）。**不要刪這張表** —— '
  '它是「當初匯過哪些檔案」的唯一紀錄,重拖的時候要照著對。';


-- ── 刪 ─────────────────────────────────────────────
do $$
declare n_txn int; n_stmt int;
begin
  select count(*) into n_txn  from public.bank_transactions;
  select count(*) into n_stmt from public.bank_statements;

  delete from public.bank_transactions;
  delete from public.bank_statements;

  raise notice '已刪除 % 筆流水、% 份對帳單', n_txn, n_stmt;
end $$;


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('144_reimport_reset');
  end if;
end $$;


-- ============================================================
-- 驗證
-- ============================================================
do $$
declare n int; m int;
begin
  drop table if exists _chk144;
  create temp table _chk144 (ord int, item text, result text, detail text);

  select count(*) into n from public.bank_transactions;
  insert into _chk144 values (1, '流水', n || ' 筆',
    case when n = 0 then '已清空' else '★ 還有殘留' end);

  select count(*) into n from public.bank_statements;
  insert into _chk144 values (2, '對帳單', n || ' 份',
    case when n = 0 then '已清空' else '★ 還有殘留' end);

  /*
   * ★★ 帳戶主檔不可以被刪到。
   *
   * 刪錯的話期初餘額也沒了 —— 而期初是從第一份對帳單推導的,
   * 沒有它，重匯之後第一筆的餘額就接不上任何東西。
   */
  select count(*) into n from public.bank_accounts;
  select count(*) into m from public.bank_accounts where opening_balance is not null;
  insert into _chk144 values (3, '★★ 帳戶主檔', n || ' 個（' || m || ' 個有期初）',
    case when n = 3 then '三個帳戶都在,期初餘額也還在'
         else '★ 應該是 3 個 —— 帳戶被刪到了' end);

  select count(*) into n from public.bank_statements_backup_144;
  insert into _chk144 values (4, '★ 刪掉的對帳單清單', n || ' 份',
    '存在 bank_statements_backup_144 —— 下面那張表列出要重拖哪些檔案');
end $$;

select item as "檢查項目", result as "結果", detail as "說明"
from _chk144 order by ord;


-- ============================================================
-- 要重拖哪些檔案
-- ============================================================
select
  account_name                          as "帳戶",
  period_from || ' ~ ' || period_to     as "期間",
  coalesce(file_name, '（沒記檔名）')     as "檔名",
  txn_count                             as "原本筆數"
from public.bank_statements_backup_144
order by account_name, period_from;


-- ============================================================
-- ③ 重拖完之後，跑這一段驗收
-- ============================================================
/*
 * 【為什麼筆數應該一模一樣】
 *
 * 舊解析器錯在摘要與餘額,**筆數是對的**
 * （實測:7 / 198 / 47 三份都跟新版一致）。
 *
 * 所以重匯之後每一份的筆數應該跟刪掉之前完全相同。
 * 對不上就代表新版解析漏了或多了 —— 那要查,不要放過。
 */
select
  coalesce(b.account_name, a.name)                        as "帳戶",
  coalesce(b.period_from, s.period_from) || ' ~ ' ||
  coalesce(b.period_to,   s.period_to)                    as "期間",
  b.txn_count                                             as "刪之前",
  (select count(*) from public.bank_transactions t where t.statement_id = s.id)
                                                          as "重匯後",
  case
    when s.id is null then '❌ 還沒重拖'
    when b.txn_count is null then '⚠ 新的（刪之前沒有這一份）'
    when b.txn_count = (select count(*) from public.bank_transactions t where t.statement_id = s.id)
      then '✅'
    else '❌ 筆數不一樣'
  end                                                     as "結果"
from public.bank_statements_backup_144 b
full join public.bank_statements s
       on s.account_id = b.account_id
      and s.period_from = b.period_from
      and s.period_to   = b.period_to
left join public.bank_accounts a on a.id = s.account_id
order by 1, 2;


-- ★ 摘要有沒有補回來。舊版空白 52–63%，新版應該明顯下降
select
  a.name                                                  as "帳戶",
  count(*)                                                as "總筆數",
  round(100.0 * count(*) filter (where t.memo is null or t.memo = '') / nullif(count(*), 0), 1)
                                                          as "空白比例%",
  count(*) filter (where t.balance_note is not null)      as "餘額有備註"
from public.bank_transactions t
join public.bank_accounts a on a.id = t.account_id
group by a.name, a.sort
order by a.sort;
