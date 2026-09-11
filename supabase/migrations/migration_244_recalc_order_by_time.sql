begin;

/*
 * migration_244  餘額重算改用「交易時間」排序
 * ------------------------------------------------------------
 * 2026-09-10 追查「為什麼以前可以匯入、現在不行」時挖出來的。
 *
 * ★★★ 現在的排序是錯的
 *
 *     over (order by t.post_date, coalesce(t.seq, 0), t.id)
 *                                 ^^^^^^^^^^^^^^^^^^^
 *
 * `seq` 是「**在那份對帳單裡的第幾列**」—— 每份 PDF 都從 1 開始數。
 * 同一天的流水如果來自**兩份**對帳單，兩個「第 1 列」撞在一起，
 * 而第二順位是 `t.id`（隨機 uuid）—— 等於擲骰子決定誰先誰後。
 *
 * ============================================================
 * 【實際發生的事】（元大 24145，2026-09-08）
 *
 * 那天早上帳上 704,091。銀行印的順序:
 *
 *     11:00:50  玉山  +513,000  →  1,217,091
 *     11:00:55  永豐  + 10,000  →  1,227,091
 *     15:01:17  玉山  +  9,000  →  1,236,091
 *
 * 系統算成:
 *
 *     +  9,000  →    713,091     ← 銀行說這一筆是 1,236,091
 *     +513,000  →  1,226,091     ← 銀行說 1,217,091
 *     + 10,000  →  1,236,091     ← 銀行說 1,227,091
 *
 * 下午三點那筆被排到早上十一點前面。
 *
 * ★★ **錢沒有多也沒有少，當日最終餘額也對**（1,236,091）——
 *   錯的是中間每一行。而「總數是對的」正是這個 bug 活這麼久的原因:
 *   月結對、當日結餘對、任何加總都正常。
 *   **只有逐行跟存摺比對才看得出來。**
 *
 * ============================================================
 * 【★★★ 它同時是「對帳單匯不進去」的元兇】
 *
 *   ① 匯入新流水 → AFTER INSERT 觸發 recalc
 *   ② recalc 用錯的順序算出不同的 balance
 *   ③ `t.balance is distinct from c.bal` 成立 → **真的產生 UPDATE**
 *   ④ 那個 UPDATE 撞上 `trg_bank_txn_memo_only`（migration_243 修的那支）
 *
 * ★ 以前每天傳一份、同一天不會有第二份對帳單，seq 不會撞 →
 *   recalc 算出來跟原本一樣 → **沒有 UPDATE** → 守衛不會醒來。
 *   2026-09-08 那天同一批日期來自兩份對帳單，才第一次撞上。
 *
 * ============================================================
 * 【★★ 為什麼改用 txn_time】
 *
 * 交易時間是**全域有意義**的:11:00:50 一定在 15:01:17 前面，
 * 不管它印在哪一份 PDF 的第幾列。（2026-09-10 查證過，線上每一筆都有值。）
 *
 * ★ `seq` 留在第三順位 —— 同一秒有兩筆時，同一份對帳單裡的先後還是它說了算。
 * ★ `t.id` 留在最後 —— 完全平手時要有一個**穩定**的結果，
 *   不然每次重算都可能排出不同答案，而那比排錯更難查。
 *
 * ★★ `txn_time` 萬一是 null 就排在**同一天的最後**（`nulls last`）——
 *   排在最前面的話，一筆沒有時間的舊資料會把當天所有餘額往後推。
 *
 * ============================================================
 * 【這一支會改動資料】
 *
 * 重算**所有帳戶**的 `balance`。改到的都是「本來就跟銀行對不起來」的那幾筆。
 * 自檢會印出改了幾筆、以及改完之後還有幾筆跟銀行不一樣。
 *
 * ★ `bank_balance`（銀行印的）一個字都不動 —— 那是事實，不是我們算的。
 * ------------------------------------------------------------
 */

/*
 * ★ 先拍一張快照，自檢才講得出「改了幾筆」。
 *
 * ★★★ **不可以用 `on commit drop`**（2026-09-10 踩過）:
 *   自檢在 `commit` 之後，而 `on commit drop` 會在 commit 當下就把它丟掉
 *   → 自檢跑到一半炸 `relation "_m244_before" does not exist`。
 *   （migration 本身已經成功了，爆掉的只有報告 —— 但那一刻看起來像整支失敗。）
 */
drop table if exists _m244_before;
create temp table _m244_before as
  select id, balance from public.bank_transactions;

create or replace function public.recalc_account_balances(p_account uuid)
 returns integer
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare n integer;
begin
  with calc as (
    select t.id,
           round(coalesce(a.opening_balance, 0)
             + sum(coalesce(t.credit, 0) - coalesce(t.debit, 0))
                 over (order by t.post_date,
                                /*
                                 * ★★★ migration_244:改用**交易日 ＋ 交易時間**。
                                 *   原本第二順位是 `coalesce(t.seq,0)` —— 而 seq 是
                                 *   「那份對帳單裡的第幾列」，跨對帳單會撞號。
                                 *
                                 * ★★ `txn_date` 要排在 `txn_time` **前面**。
                                 *   帳務日相同、交易日不同的情況是有的
                                 *   （09/08 23:50 的交易可能 09/09 才入帳）——
                                 *   只看時間的話，09/09 00:10 那筆會被排到
                                 *   09/08 23:50 前面，而那是反的。
                                 *
                                 * ★ nulls last:沒有值的排當天最後。
                                 *   排最前面會把當天所有餘額往後推。
                                 */
                                t.txn_date nulls last,
                                t.txn_time nulls last,
                                coalesce(t.seq, 0),
                                t.id
                       rows between unbounded preceding and current row), 2) as bal
      from public.bank_transactions t
      join public.bank_accounts a on a.id = t.account_id
     where t.account_id = p_account
  )
  update public.bank_transactions t
     set balance = c.bal
    from calc c
   where t.id = c.id
     and t.balance is distinct from c.bal;
  get diagnostics n = row_count;
  return n;
end $function$;

comment on function public.recalc_account_balances(uuid) is
  '重算一個帳戶的餘額鏈（migration_244）。'
  '★★★ 排序是 post_date → txn_date → txn_time → seq → id。'
  '**seq 不可以當主要順位** —— 它是「那份對帳單裡的第幾列」，'
  '每份 PDF 都從 1 開始，同一天來自兩份對帳單時會撞號，'
  '而第二順位是隨機 uuid，等於擲骰子（2026-09-08 元大 24145 就是這樣排錯的）。';

-- ★ 全部重算一次。★★ 這裡是**直接呼叫**，不是靠觸發器 ——
--   觸發器只在有 INSERT 時才醒來，而這次沒有新資料
do $do$
declare a record; total int := 0; k int;
begin
  for a in select id, name from public.bank_accounts loop
    k := public.recalc_account_balances(a.id);
    if k > 0 then raise notice '% —— 修正 % 筆', a.name, k; end if;
    total := total + k;
  end loop;
  raise notice '合計修正 % 筆', total;
end $do$;

do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('244_recalc_order_by_time');
  end if;
end $do$;

commit;


-- ══════════════════════════════════════════════════════════
-- 自檢
--
-- ★★★ 看不到這張表 = 上面爆了、整支回滾。
-- ══════════════════════════════════════════════════════════
select v.ord, v."檢查", v."結果", v."判定" from (

  select 1, '①★★★ 排序改成交易日＋時間了',
         case when (select prosrc from pg_proc where proname='recalc_account_balances')
                   ilike '%txn_time%' then '有 txn_time' else '沒有' end
         || '　'
         || case when (select prosrc from pg_proc where proname='recalc_account_balances')
                      ilike '%txn_date%' then '有 txn_date' else '沒有 txn_date' end,
         case when (select prosrc from pg_proc where proname='recalc_account_balances')
                   ilike '%txn_time%'
              and  (select prosrc from pg_proc where proname='recalc_account_balances')
                   ilike '%txn_date%'
              then '✅' else '❌' end

  union all
  select 2, '②★★★ 這次修正了幾筆餘額',
         (select count(*)::text from public.bank_transactions t
           join _m244_before b on b.id = t.id
          where t.balance is distinct from b.balance) || ' 筆',
         /*
          * ★ 不判對錯。0 筆代表「本來就沒排錯」（也可能是同一天從來
          *   沒有兩份對帳單）；幾百筆代表這個 bug 污染得比想像深。
          *   兩種都是資訊，不是錯誤。
          */
         'ℹ 這些是本來就跟銀行對不起來的那幾筆'

  union all
  select 3, '③★★★ 還有幾筆跟銀行印的不一樣',
         (select count(*)::text from public.bank_transactions
           where bank_balance is not null and balance <> bank_balance) || ' 筆',
         /*
          * ★★★ 這一條是整支的重點。改完之後應該**接近 0**。
          *   還有一堆的話表示排序不是唯一的問題 —— 停下來，不要繼續匯入。
          */
         case when (select count(*) from public.bank_transactions
                     where bank_balance is not null and balance <> bank_balance) = 0
              then '✅ 全部對得上'
              else '⚠ 還有對不上的 —— 看第 ④ 條是哪幾筆' end

  union all
  select 4, '④ 還對不上的長什麼樣（最多 5 筆）',
         coalesce((select string_agg(x.s, '　')
                     from (select a.name || ' ' || t.post_date::text
                                  || ' 我們 ' || t.balance::text
                                  || ' / 銀行 ' || t.bank_balance::text as s
                             from public.bank_transactions t
                             join public.bank_accounts a on a.id = t.account_id
                            where t.bank_balance is not null
                              and t.balance <> t.bank_balance
                            order by t.post_date desc limit 5) x), '（沒有）'),
         'ℹ 有的話貼給我'

  union all
  select 5, '⑤★★ 警報欄是不是還啞著',
         (select count(*)::text from public.bank_transactions
           where bank_balance is not null and balance <> bank_balance
             and balance_note is null) || ' 筆對不上卻沒有記號',
         /*
          * ★★★ `balance_note` 的用途就是「我們算的跟銀行印的不一樣時留個記號」。
          *   2026-09-10 查到差額 -523,000 的那幾筆，balance_note 全是 null ——
          *   因為解析器算的是**對的**（所以沒寫 note），
          *   而 recalc 事後把 balance 覆蓋成錯的，**沒有回頭更新 note**。
          *
          * ★ 這一支**沒有修這件事** —— 修法要動到 note 的格式，
          *   而那是解析器那邊的知識。這一條先把它量出來。
          */
         'ℹ 這是另一個問題（recalc 改了 balance 卻不維護 note），還沒修'

  union all
  select 6, '⑥ 母體（銀行流水總筆數）',
         (select count(*)::text from public.bank_transactions),
         case when (select count(*) from public.bank_transactions) = 0
              then '⚠ 母體是 0 —— 上面全部不算數' else '✅' end

) v(ord, "檢查", "結果", "判定") order by v.ord;
