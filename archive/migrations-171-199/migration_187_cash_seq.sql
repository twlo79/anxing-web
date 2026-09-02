/*
 * migration_187 —— 現金流水補上 seq，讓同一天的順序固定
 * ============================================================
 * 2026-08-31 使用者：「編排日期出問題」
 *
 * 【症狀】
 *
 * 帳戶明細的餘額欄由上往下不是遞減的:
 *
 *     08/18  3A3-押金   780,385   ← 同一天內由上往下「越來越大」
 *     08/18  7B1        810,385
 *     08/18  5B2        956,385
 *
 * 日期是新到舊，同一天內卻是舊到新 —— 讀起來像資料錯了。
 * **數字全部是對的**（11 環逐一驗過，合計也對得上），錯的是順序。
 *
 * ============================================================
 * 【★★★ 根源：現金流水的 seq 是空的】
 *
 * `bank_transactions.seq` 原本的用途是「在那份對帳單裡的第幾列」——
 * 銀行流水從 PDF 讀出來時自然就有。
 * 現金是手 key 的，`draftToRow` 沒有給它值，所以**全部是 null**。
 *
 * 於是同一天的幾筆在排序時**全部平手**:
 *
 *   畫面   `.order('post_date', desc).order('seq', desc)`
 *   重算   `(a.seq ?? 0) - (b.seq ?? 0)`  → 全是 0
 *
 * 兩邊都退回「陣列本來的順序」，而那個順序是資料庫回什麼就是什麼。
 *
 * ★★ 真正的風險不是難讀，是**不穩定**。
 *   平手時 Postgres 回的順序沒有保證 —— 下次新增一筆觸發整串重算，
 *   同一天那幾筆可能換順序，**每一列的餘額就會跟著改**。
 *   總額不變，所以不會有任何錯誤訊息;只是今天看到的數字明天不一樣。
 *
 * ============================================================
 * 【這支做兩件事】
 *
 *   ① 每一筆現金流水補上 seq（同一帳戶內單調遞增）
 *   ② 照新的順序重算 balance
 *
 * ★ 排序的依據是 `post_date, created_at, id`:
 *   `created_at` 是**他實際 key 進去的先後** —— 那是最有意義的順序。
 *   `id` 墊底是為了萬一連 created_at 都相同（同一批寫入）時仍然唯一，
 *   不然 row_number() 每次跑可能給不同的號碼。
 *
 * ★★ `id` 是 uuid，排序沒有業務意義 —— 但它**穩定**，
 *   而這裡要的正是穩定而不是意義。
 *
 * ============================================================
 * 【★★ 只動現金帳戶】
 *
 * 銀行流水的 seq 是對帳單上的真實列號，**一個都不能碰** ——
 * 動了它，去重的鑰匙與同日排序就全錯了。
 * 底下每一句都有 `where a.kind = 'cash'`。
 */

create temp table _chk187 (ord int, item text, result text, note text) on commit drop;

/*
 * 先把跑之前的狀態記下來，最後拿來對照。
 *
 * ★★ 這裡記的是**淨額**（存入 − 支出），不是「最後一筆的餘額」。
 *
 *   兩者在正確的情況下相等，但淨額是**加總**、跟順序無關 ——
 *   而這支 migration 動的正是順序。用「最後一筆」當基準的話，
 *   基準本身會被這支改掉，那就驗不出任何東西了。
 *
 * ★ 第一版寫成 `max((post_date, seq))` 想一次取出最後一列，
 *   Postgres 沒有 `max(record)` —— 而繞過去的正確做法不是加型別轉換，
 *   是**根本不要依賴順序**。
 */
insert into _chk187
select 0, '跑之前',
       count(*)::text || ' 筆・存入 ' || to_char(coalesce(sum(t.credit), 0), 'FM999,999,999')
         || '・支出 ' || to_char(coalesce(sum(t.debit), 0), 'FM999,999,999'),
       '淨額 ' || to_char(coalesce(sum(t.credit - t.debit), 0), 'FM999,999,999')
  from public.bank_transactions t
  join public.bank_accounts a on a.id = t.account_id
 where a.kind = 'cash';

-- ============================================================
-- ① 補 seq
-- ============================================================
with ordered as (
  select t.id,
         row_number() over (
           partition by t.account_id
           order by t.post_date, t.created_at, t.id
         ) as n
    from public.bank_transactions t
    join public.bank_accounts a on a.id = t.account_id
   where a.kind = 'cash'
)
update public.bank_transactions t
   set seq = o.n
  from ordered o
 where o.id = t.id
   and t.seq is distinct from o.n;

-- ============================================================
-- ② 照新順序重算 balance
-- ============================================================
/*
 * ★ 期初餘額從 `bank_accounts.opening_balance` 來，留空當 0
 *   —— 跟前端的 `recalcBalances(rows, opening)` 同一套規則。
 *
 * ★★ `rows between unbounded preceding and current row` 要寫出來。
 *   `order by` 的視窗預設是 `range ... current row`，而 **range 會把
 *   排序鍵相同的列當成同一組**一起算進來 —— 那正是這支要修的問題本身。
 *   seq 現在唯一，所以兩者結果一樣;但寫死 rows 才不會因為
 *   哪天又出現平手而悄悄回到原本的錯誤。
 */
with recalc as (
  select t.id,
         round(
           coalesce(a.opening_balance, 0)
           + sum(t.credit - t.debit) over (
               partition by t.account_id
               order by t.post_date, t.seq
               rows between unbounded preceding and current row
             ), 2) as bal
    from public.bank_transactions t
    join public.bank_accounts a on a.id = t.account_id
   where a.kind = 'cash'
)
update public.bank_transactions t
   set balance = r.bal
  from recalc r
 where r.id = t.id
   and t.balance is distinct from r.bal;


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('187_cash_seq');
  end if;
end $$;


-- ══════════════════════════════════════════════════════════
-- 自檢。★ `raise notice` 在 SQL Editor 看不到，所以回一張表。
-- ★ 排序欄位留在子查詢裡（`v.ord`）—— `order by 1` 會照文字排（migration_181 踩過）。
-- ══════════════════════════════════════════════════════════
select v."檢查項目", v."結果", v."說明" from (

  select 1, '★★★ 每一筆都有 seq 了',
         (select case when count(*) filter (where t.seq is null) = 0
                      then '✅ ' || count(*) || ' 筆全部有'
                      else '⚠ 還有 ' || count(*) filter (where t.seq is null) || ' 筆是空的' end
            from public.bank_transactions t
            join public.bank_accounts a on a.id = t.account_id
           where a.kind = 'cash'),
         '空的話同一天的順序仍然不固定，下次新增就會重排'

  union all
  select 2, '★★ seq 沒有重複',
         (select case when count(*) = count(distinct t.seq)
                      then '✅ ' || count(*) || ' 個號碼都不一樣'
                      else '⚠ 有重複 —— 平手又回來了' end
            from public.bank_transactions t
            join public.bank_accounts a on a.id = t.account_id
           where a.kind = 'cash'),
         '重複的話那幾筆又會平手，等於沒修'

  union all
  /*
   * ★★★ 這一項是重點:餘額由**新到舊**看下去要嚴格遞減／遞增得合理。
   *   換個說法:每一筆的餘額減掉自己的淨額，要等於前一筆的餘額。
   *   有一環接不上就是重算寫錯了。
   */
  select 3, '★★★ 餘額每一環都接得上',
         (select case when count(*) = 0 then '✅ 全部接得上'
                      else '⚠ 有 ' || count(*) || ' 環接不上' end
            from (
              select t.balance
                     - (t.credit - t.debit)
                     - coalesce(lag(t.balance) over (
                         partition by t.account_id order by t.post_date, t.seq),
                         coalesce(a.opening_balance, 0)) as diff
                from public.bank_transactions t
                join public.bank_accounts a on a.id = t.account_id
               where a.kind = 'cash'
            ) x where abs(x.diff) > 0.005),
         '每一筆的餘額減掉自己的淨額，要等於前一筆的餘額'

  union all
  select 4, '★★ 合計沒有變',
         (select count(*)::text || ' 筆・存入 ' || to_char(coalesce(sum(t.credit), 0), 'FM999,999,999')
                 || '・支出 ' || to_char(coalesce(sum(t.debit), 0), 'FM999,999,999')
            from public.bank_transactions t
            join public.bank_accounts a on a.id = t.account_id
           where a.kind = 'cash'),
         (select '跑之前是：' || result from _chk187 where ord = 0)

  union all
  /*
   * ★★★ 最後一筆的餘額**要等於淨額**（期初 ＋ 全部收支）。
   *
   *   這一條同時驗兩件事:重算有沒有寫對、以及順序換了之後
   *   最終的數字沒有跑掉。兩邊是用**完全不同的方式**算出來的 ——
   *   一個是照順序累加的結果，一個是不管順序的加總，
   *   對得起來才有意義。
   */
  select 5, '★★★ 最後餘額 = 期初 ＋ 淨額',
         (select case when abs(coalesce(last_bal, 0) - coalesce(net, 0)) < 0.005
                      then '✅ 都是 ' || to_char(coalesce(net, 0), 'FM999,999,999')
                      else '⚠ 最後餘額 ' || to_char(coalesce(last_bal, 0), 'FM999,999,999')
                           || '，但淨額是 ' || to_char(coalesce(net, 0), 'FM999,999,999') end
            from (
              select
                (select t.balance from public.bank_transactions t
                   join public.bank_accounts a2 on a2.id = t.account_id
                  where a2.kind = 'cash'
                  order by t.post_date desc, t.seq desc limit 1) as last_bal,
                (select coalesce(a3.opening_balance, 0) + coalesce(sum(t2.credit - t2.debit), 0)
                   from public.bank_transactions t2
                   join public.bank_accounts a3 on a3.id = t2.account_id
                  where a3.kind = 'cash'
                  group by a3.opening_balance) as net
            ) z),
         '★ 這個數字**不該變** —— 順序換了但收支沒變，總額就不會變'

  union all
  select 6, '★ 銀行流水一個都沒動',
         (select count(*)::text || ' 筆銀行流水，其中 '
                 || count(*) filter (where t.seq is null)::text || ' 筆 seq 是空的'
            from public.bank_transactions t
            join public.bank_accounts a on a.id = t.account_id
           where a.kind <> 'cash'),
         '銀行的 seq 是對帳單上的真實列號，動了去重就全錯 —— 這支每一句都有 kind=cash'

) v(ord, "檢查項目", "結果", "說明") order by v.ord;
