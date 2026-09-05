/*
 * migration_203 —— 餘額改由資料庫維護
 * ============================================================
 * 2026-09-02 使用者：元大 08311 三筆存入共 $51,083，每一列餘額都是 $0。
 *
 * ============================================================
 * 【★★★ 為什麼不是去找兇手】
 *
 * 查過了，兩個已知的寫入者都是對的:
 *
 *   帳戶頁的現金表單   insert 時 balance 塞 0 佔位 → 重算 → 一列一列寫回
 *   對帳單匯入 API     直接寫算好的 balance
 *
 *   `netOf` / `recalcBalances` / `changedBalances`（lib/cash-txn.ts）也都對，
 *   RLS 也不是（`bank_transactions_write` 是 for all，會計以上都寫得動，
 *   沒有任何 kind 條件）。
 *
 * ★★ 所以我解釋不了那三筆怎麼變成 0 的 —— 而**那正是問題本身**。
 *
 *   `balance` 是一個**推導值卻存成欄位**，維護它的是前端的一段程式。
 *   只要有第二個寫入者、或那條路徑失敗一次（而它原本連影響列數都沒檢查），
 *   它就永遠是錯的**而且不會叫**。
 *
 *   元大 24145 有 1 筆也是同一個症狀 —— 790 筆裡的 1 筆。
 *   那一筆沒有人會發現。
 *
 * ★ 修法不是對帳，是**讓寫的人只有一個**
 *   （CLAUDE.md 的坑表:「一份資料存在兩個地方」，migration_195 同一個結論）。
 *   從今天起不管是誰、用什麼路徑寫進 bank_transactions，
 *   餘額都由資料庫自己算。
 *
 * ============================================================
 * 【★★ 遞迴要擋住】
 *
 * 重算本身是 `update bank_transactions`，而那會再觸發一次這個觸發器。
 * 沒有防護的話會一路遞迴到 `stack depth limit exceeded`——
 * **而爆掉的是使用者的存檔動作**，不是什麼背景工作。
 *
 * ★ 用 `pg_trigger_depth() > 1` 擋。第一層做事，被自己叫起來的第二層直接走人。
 *
 * ============================================================
 * 【為什麼是 statement 層不是 row 層】
 *
 * 對帳單匯入一次 insert 幾百列。row 層的話那是幾百次全帳戶重算 ——
 * O(n²)，909 筆的帳戶會跑到逾時。
 *
 * statement 層一次 insert 只重算一次。用 transition table
 * （`referencing new table as`）拿到這批動到哪些帳戶。
 */

-- ══════════════════════════════════════════════════════════
-- ① 重算一個帳戶的全部餘額
-- ══════════════════════════════════════════════════════════
/*
 * 排序鍵跟 `lib/cash-txn.ts` 的 `recalcBalances` 一致:
 * 帳務日 → seq → id。前端那段留著也不會打架（算出來一樣，
 * 它會發現沒有 diff 而什麼都不寫）。
 *
 * ★ 最後加 `t.id` 當第三鍵是這裡多的 —— 同一天同一個 seq 的兩列，
 *   沒有第三鍵的話每次排序可能不同，餘額就會在兩個值之間跳。
 *   前端那邊的 JS sort 是穩定排序所以看不出來，SQL 不保證。
 *
 * ★★ `is distinct from` 而不是 `<>` —— balance 可能是 null，
 *   而 `null <> 5` 是 null（不是 true），那一列就不會被更新。
 */
create or replace function public.recalc_account_balances(p_account uuid)
returns integer language plpgsql security definer set search_path to 'public'
as $fn$
declare n integer;
 begin
  with calc as (
    select t.id,
           round(coalesce(a.opening_balance, 0)
             + sum(coalesce(t.credit, 0) - coalesce(t.debit, 0))
                 over (order by t.post_date, coalesce(t.seq, 0), t.id
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
end $fn$;

comment on function public.recalc_account_balances(uuid) is
  '重算一個帳戶全部流水的餘額（migration_203）。'
  '餘額 = 期初 ＋ 到這一列為止的存入減支出，排序照 帳務日 → seq → id。'
  '★★★ 這是餘額的**唯一**寫入者。前端不要再自己算了 —— '
  '一份推導值有兩個維護者，漏掉的那邊不會報錯（08311 三筆餘額 0 就是這樣來的）。';


-- ══════════════════════════════════════════════════════════
-- ② 觸發器
-- ══════════════════════════════════════════════════════════
create or replace function public.trg_bank_txn_balance() returns trigger
  language plpgsql security definer set search_path to 'public'
as $fn$
declare v_acc uuid;
 begin
  /*
   * ★★★ 重算本身是 update bank_transactions，會再觸發這一支。
   *   沒有這一行就會遞迴到 stack depth limit exceeded ——
   *   而爆掉的是使用者按下「儲存」的那一刻。
   */
  if pg_trigger_depth() > 1 then return null; end if;

  for v_acc in
    select distinct account_id from _chg where account_id is not null
  loop
    perform public.recalc_account_balances(v_acc);
  end loop;
  return null;
end $fn$;

/*
 * 三個觸發器，因為 transition table 的名字要分別宣告
 * （insert 只有 new、delete 只有 old、update 兩個都有）。
 *
 * ★ 統一取名 `_chg` —— 函式裡只寫一次查詢。
 *   update 的那個把兩張表 union 起來:改了 account_id 的話
 *   **舊帳戶跟新帳戶都要重算**，只算一邊的話舊帳戶會留著多出來的餘額。
 */
drop trigger if exists bank_txn_balance_ins on public.bank_transactions;
drop trigger if exists bank_txn_balance_upd on public.bank_transactions;
drop trigger if exists bank_txn_balance_del on public.bank_transactions;

create trigger bank_txn_balance_ins
  after insert on public.bank_transactions
  referencing new table as _chg
  for each statement execute function public.trg_bank_txn_balance();

create trigger bank_txn_balance_del
  after delete on public.bank_transactions
  referencing old table as _chg
  for each statement execute function public.trg_bank_txn_balance();

/*
 * ★★ update 要兩張表都看。這裡用一個獨立的函式，
 *   因為 plpgsql 沒辦法在同一段程式碼裡條件式地引用不存在的 transition table。
 */
create or replace function public.trg_bank_txn_balance_upd() returns trigger
  language plpgsql security definer set search_path to 'public'
as $fn$
declare v_acc uuid;
 begin
  if pg_trigger_depth() > 1 then return null; end if;
  for v_acc in
    select distinct account_id from (
      select account_id from _new
      union all
      select account_id from _old
    ) x where account_id is not null
  loop
    perform public.recalc_account_balances(v_acc);
  end loop;
  return null;
end $fn$;

create trigger bank_txn_balance_upd
  after update on public.bank_transactions
  referencing new table as _new old table as _old
  for each statement execute function public.trg_bank_txn_balance_upd();


-- ══════════════════════════════════════════════════════════
-- ③ 把現在壞掉的補回來
-- ══════════════════════════════════════════════════════════
create temp table _chk203 (item text, val text) on commit drop;

/*
 * ★★★ 這裡的算法**必須跟 `recalc_account_balances` 一模一樣**。
 *
 *   第一版我用相關子查詢（`where (post_date, seq, id) <= (...)`）——
 *   而那個在 `post_date` 是 null 時回 null（整列被排除），
 *   window function 卻照樣排得出順序。兩邊不一致的話，
 *   **自檢會永遠紅著而資料其實是對的** —— 然後就沒有人再看自檢了
 *   （CLAUDE.md:「誤報會把真警報淹掉」）。
 *
 *   所以下面這個 view 是唯一的算法來源，修正與自檢都讀它。
 */
-- ★ 暫存 view 不支援 `on commit drop`，同一個連線重跑會撞名 —— 先砍再建
drop view if exists _bal203;
create temp view _bal203 as
select t.id, t.account_id, a.name as acct, t.balance as stored,
       round(coalesce(a.opening_balance, 0)
         + sum(coalesce(t.credit, 0) - coalesce(t.debit, 0))
             over (partition by t.account_id
                   order by t.post_date, coalesce(t.seq, 0), t.id
                   rows between unbounded preceding and current row), 2) as calc
  from public.bank_transactions t
  join public.bank_accounts a on a.id = t.account_id;

insert into _chk203
select '③ 修正前對不上的筆數',
       coalesce((select string_agg(acct || '：' || n::text || ' 筆', E'\n' order by acct)
                   from (select acct, count(*) n from _bal203
                          where stored is distinct from calc group by acct) y),
                '（沒有）');

do $do$
declare r record; total int := 0;
 begin
  for r in select id from public.bank_accounts loop
    total := total + public.recalc_account_balances(r.id);
  end loop;
  insert into _chk203 values ('③ 這次改掉的列數', total::text || ' 列');
end $do$;


-- ── 記錄執行 ───────────────────────────────────────
do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('203_balance_trigger');
  end if;
end $do$;


-- ══════════════════════════════════════════════════════════
-- 自檢
-- ★ 基準值不依賴這支改了幾列:第 ① 列問的是「還有幾筆對不上」，
--   正確答案永遠是 0（CLAUDE.md:基準要用跟改動無關的量）。
-- ══════════════════════════════════════════════════════════
select v."檢查項目", v."結果", v."說明" from (

  select 1, '★★★ ① 每一筆餘額都對得上',
         (select case when count(*) = 0 then '✅ 全部對'
                      else '⚠⚠⚠ 還有 ' || count(*)::text || ' 筆不一致：'
                           || string_agg(distinct acct, '、') end
            from _bal203 where stored is distinct from calc),
         '★ 現場重算一次跟存起來的比對，不看觸發器有沒有裝好。正確答案永遠是 0。'
           || '★★ 算法跟 recalc_account_balances 共用同一個 view —— '
           || '兩邊各寫一份的話，自檢會為了自己的 bug 而紅'

  union all
  select 2, '★★★ ② 三個觸發器都裝上了',
         (select case when count(*) = 3
                      then '✅ ' || string_agg(tgname, '、' order by tgname)
                      else '⚠⚠ 只有 ' || count(*)::text || ' 個：'
                           || coalesce(string_agg(tgname, '、'), '（一個都沒有）') end
            from pg_trigger
           where tgrelid = 'public.bank_transactions'::regclass
             and tgname like 'bank\_txn\_balance\_%'),
         '★ insert／update／delete 各一個。少了 delete 的話，'
           || '刪掉中間一筆之後**後面每一列的餘額都會偏掉**，而畫面不會叫'

  union all
  select 3, '★★★ ③ 遞迴防護在',
         (select case when count(*) filter (where d ilike '%pg_trigger_depth%') = 2
                      then '✅ 兩支函式都有 pg_trigger_depth 檢查'
                      else '⚠⚠⚠ 少了 —— 存一筆流水會遞迴到 stack depth limit' end
            from (select pg_get_functiondef(p.oid) d
                    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                   where n.nspname = 'public' and p.prokind in ('f','p')
                     and p.proname in ('trg_bank_txn_balance', 'trg_bank_txn_balance_upd')) z),
         '★★ 重算本身是 update，會再觸發自己。爆掉的是使用者按儲存的那一刻'

  union all
  select 4, '④ 修正前的狀況與這次改了幾列',
         (select string_agg(item || '　' || val, E'\n') from _chk203),
         '★ 08311 該修好 3 筆、24145 該修好 1 筆'

  union all
  select 5, '★★ ⑤ 每個帳戶的期末餘額',
         (select string_agg(a.name || '　' || coalesce(t.balance, 0)::text,
                            E'\n' order by a.name)
            from public.bank_accounts a
            left join lateral (
              select t2.balance from public.bank_transactions t2
               where t2.account_id = a.id
               order by t2.post_date desc, coalesce(t2.seq, 0) desc, t2.id desc
               limit 1
            ) t on true
           where a.active),
         '★ 對照畫面上的卡片:70564 應為 334,823、24145 應為 4,387,080、'
           || '48088 應為 135,455、**08311 應該從 0 變成 51,083**、現金 269,599'

  union all
  select 6, '⑥ 流水筆數沒變',
         (select count(*)::text || ' 筆' from public.bank_transactions),
         '★ 這支只改 balance 欄位，不新增也不刪除任何一列'

) v(ord, "檢查項目", "結果", "說明") order by v.ord;
