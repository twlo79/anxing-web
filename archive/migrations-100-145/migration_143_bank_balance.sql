-- migration_143：餘額我們自己算，有差異才備註
--
-- ============================================================
-- 【為什麼】（2026-08-18 使用者指定）
--
-- 「這種數字問題 我們自己算 備註銀行計算的」
--
-- 起因是 2026/07 那份 24145 的第 22 筆:
--
--     21  匯出匯款    37,756   銀行印 5,307,081
--     22  匯出匯款 1,329,688   銀行印 3,976,587   ← 推算是 3,977,393，差 806
--     23  匯出匯款 2,657,459   銀行印 1,319,934   ← 又跟推算一致
--
-- 而那一份的支出加總 15,311,998、存入加總 13,925,207 **跟 footer 一字不差**,
-- 期初 4,680,252 ＋ 存入 − 支出 也剛好等於期末 3,293,461。
--
-- 一筆都沒漏、金額全部讀對 —— 是**銀行把那一格印錯了**。
--
-- 照抄的話，那一格會永遠壞在資料庫裡。而餘額這一欄會被拿去對帳、
-- 被拿去查「那天帳上有多少」—— 一格壞掉就是一次查不出原因的對不上。
--
--
-- ============================================================
-- 【為什麼去重還是用銀行印的】
--
-- 我們算的餘額跟著「這份對帳單從哪裡起算」跑:
-- 期間重疊的兩份 PDF，同一筆交易算出來的值可能不同 ——
-- 那樣同一筆會被匯進去兩次，而畫面上只會說「新增 N 筆」，看起來很正常。
--
-- 銀行印的不管出現在哪一份 PDF 都是同一個數字。
-- **所以:顯示用我們算的，去重用銀行印的。**


alter table public.bank_transactions
  add column if not exists bank_balance numeric(14,2),
  add column if not exists balance_note text;

comment on column public.bank_transactions.balance is
  '餘額 —— **我們自己算的**(期初 ＋ 到這一筆為止的存入 − 支出)。畫面顯示這個。'
  '照抄 PDF 的話銀行印錯的那一格會永遠壞在資料庫裡(migration_143)。';
comment on column public.bank_transactions.bank_balance is
  'PDF 上印的餘額。**技術欄位,去重鑰匙用它** —— '
  '我們算的會跟著對帳單起算點跑,期間重疊的兩份可能算出不同的值,'
  '那樣同一筆會被匯兩次。銀行印的不管在哪一份 PDF 都一樣。'
  '給人看的是 balance_note。';
comment on column public.bank_transactions.balance_note is
  '餘額備註。**只有銀行印的跟我們算的不一樣時才有值**(使用者指定 2026-08-18)。'
  '每一筆都寫的話這一欄就沒有訊號了 —— 132 筆裡只有 1 筆該有備註,'
  '那 1 筆才是要人看的。全部都寫等於全部都不用看。';


/*
 * 【既有資料】
 *
 * migration_142 之後、這一支之前匯進去的流水，balance 存的是 PDF 上的值。
 * 先原樣搬進 bank_balance —— 那是它當時的真實來源。
 *
 * **不回頭重算 balance。** 重算需要知道那一份對帳單的期初，
 * 而那要看 statement_id 去湊；湊錯的話會把對的資料改成錯的。
 * 少算一批是「跟新的不一致」，看得出來；算錯是沒有人會發現。
 * 真的要重算就整批刪掉重傳 —— 去重是靠內容，重傳是安全的。
 */
update public.bank_transactions set bank_balance = balance where bank_balance is null;


/*
 * 【唯一索引改掛在 bank_balance 上】
 *
 * 舊的掛在 balance —— 而 balance 從現在起是我們算的，會跟著起算點跑。
 * 不改的話，期間重疊的第二份 PDF 會整份被當成新的。
 *
 * txn_time 的 null 一樣要 coalesce:**null 在唯一索引裡互不相等**,
 * 不收斂的話沒印時間的兩筆會重複匯入。
 */
drop index if exists public.uq_bank_txn;
create unique index if not exists uq_bank_txn
  on public.bank_transactions
     (account_id, post_date, bank_balance, (coalesce(txn_time, '00:00:00'::time)));


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('143_bank_balance');
  end if;
end $$;


-- ============================================================
-- 驗證
-- ============================================================
do $$
declare n int; m int;
begin
  drop table if exists _chk143;
  create temp table _chk143 (ord int, item text, result text, detail text);

  insert into _chk143 values (1, 'bank_balance 欄位',
    case when exists (select 1 from information_schema.columns
                       where table_schema = 'public' and table_name = 'bank_transactions'
                         and column_name = 'bank_balance') then '✅' else '❌' end,
    '畫面顯示 balance(我們算的),去重用 bank_balance(銀行印的)');

  -- ★ 唯一索引真的掛在 bank_balance 上
  insert into _chk143 values (2, '★ 唯一索引改掛 bank_balance',
    case when exists (
      select 1 from pg_indexes
       where schemaname = 'public' and indexname = 'uq_bank_txn'
         and indexdef like '%bank_balance%') then '✅' else '❌ 還掛在 balance' end,
    '掛錯的話,期間重疊的第二份 PDF 會整份被當成新的');

  select count(*) into n from public.bank_transactions;
  select count(*) into m from public.bank_transactions where bank_balance is null;
  insert into _chk143 values (3, '既有流水', n || ' 筆',
    case when m = 0 then '都已補上 bank_balance' else '★ 還有 ' || m || ' 筆是 null' end);

  /*
   * ★★ 實測:同一筆重複插入要被擋。
   *
   * 索引寫錯不會有任何徵兆 —— 要等第二次上傳同一份 PDF 才發現流水變兩倍,
   * 而那時已經混在一起分不出哪一筆是重複的。
   */
  begin
    insert into public.bank_transactions
      (account_id, post_date, balance, bank_balance, credit, txn_time)
    select id, '1900-01-01', 111, 999, 999, null from public.bank_accounts limit 1;
    begin
      -- balance 故意給不同的值:去重看的是 bank_balance,不該因此變成兩筆
      insert into public.bank_transactions
        (account_id, post_date, balance, bank_balance, credit, txn_time)
      select id, '1900-01-01', 222, 999, 999, null from public.bank_accounts limit 1;
      insert into _chk143 values (4, '★★ 銀行餘額相同就算重複', '❌ 插得進去第二次',
        '去重可能還在看 balance —— 我們算的值一變動就會重複匯入');
    exception when unique_violation then
      insert into _chk143 values (4, '★★ 銀行餘額相同就算重複', '✅',
        'balance 不同也擋得住 —— 去重確實看 bank_balance');
    end;
    delete from public.bank_transactions where post_date = '1900-01-01';
  exception when others then
    insert into _chk143 values (4, '★★ 銀行餘額相同就算重複', '❌ ' || sqlerrm, '');
  end;

  insert into _chk143 values (5, 'balance_note 欄位',
    case when exists (select 1 from information_schema.columns
                       where table_schema = 'public' and table_name = 'bank_transactions'
                         and column_name = 'balance_note') then '✅' else '❌' end,
    '只有銀行印的跟我們算的不一樣時才填 —— 每筆都填就沒有訊號了');

  -- 目前有幾筆有備註
  select count(*) into n from public.bank_transactions where balance_note is not null;
  select count(*) into m from public.bank_transactions;
  insert into _chk143 values (6, '★ 有餘額備註的筆數', n || ' / ' || m || ' 筆',
    case when n = 0 then '目前沒有不一致的'
         else '這幾筆銀行印的跟我們算的不同 —— 那一列會顯示備註' end);
end $$;

select item as "檢查項目", result as "結果", detail as "說明"
from _chk143 order by ord, item;
