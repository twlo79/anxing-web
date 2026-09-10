begin;

/*
 * migration_243  摘要守衛不要誤傷系統自己的餘額重算
 * ------------------------------------------------------------
 * 2026-09-10 使用者：上傳對帳單 →
 *   「寫入第 1 筆之後中斷：銀行流水只能編輯「摘要」…」
 *
 * ★★★ 匯入只做 INSERT，為什麼會撞到一個 UPDATE 的守衛
 *
 *   ① 路由 `api/bank-statements/import` 只有 `.insert()`
 *   ② `bank_txn_balance_ins`（AFTER INSERT）→ `trg_bank_txn_balance()`
 *      → `recalc_account_balances(帳戶)` —— 它會 **UPDATE bank_transactions
 *        的 balance**，把整條餘額鏈重算
 *   ③ 那個 UPDATE 觸發 `trg_bank_txn_memo_only`
 *   ④ 守衛比對 `to_jsonb(new) - 'memo' <> to_jsonb(old) - 'memo'`
 *      → balance 變了 → raise
 *
 * ★★ 守衛**分不出改的人是誰**。它擋的本意是「人不可以竄改對帳單」，
 *   而它擋到的是系統自己在維護一個推導欄位。
 *
 * ★★★ 有趣的是 `trg_bank_txn_balance()` 自己第一行就寫著
 *
 *       if pg_trigger_depth() > 1 then return null; end if;
 *
 *   它知道「重算會再觸發自己」。**只是沒有人回頭替另一支守衛也想一次。**
 *   兩支觸發器看同一張表，一支懂得閃自己人、一支不懂。
 *
 * ============================================================
 * 【★★ 為什麼不是直接 `pg_trigger_depth() > 1 就全部放行`】
 *
 * 那樣寫最短，但等於「只要是觸發器裡發生的改動一律不管」——
 * 而日後任何一支新觸發器都能從這個洞把金額改掉，**沒有東西會叫**。
 *
 * ★ 所以放行的是**欄位**，不是**時機**:深層呼叫只准動
 *   `balance` 與 `balance_note`（那兩欄本來就是我們算出來的，
 *   不是銀行印的）。深層改到金額、日期、帳號一樣擋，
 *   而且訊息會說是「系統內部」改的 —— 那種錯要查的地方不一樣。
 *
 * ★★ `bank_balance` 不在放行清單裡 —— 那是**銀行印的**餘額，
 *   去重就是靠它。重算不該碰它，碰了就是有 bug。
 *
 * ============================================================
 * 【原本的規則一個字都沒改】
 *
 *   · service key（`current_role_of()` 是 null）放行 —— migration_166
 *   · 現金帳戶全部放行 —— migration_184
 *   · 銀行帳戶的直接編輯:只有 memo 能動 —— migration_166
 *
 * 只多了「深層呼叫」這一段。
 * ------------------------------------------------------------
 */

create or replace function public.bank_txn_memo_only()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_role text := public.current_role_of();
  v_kind text;
begin
  -- 匯入排程（service key，沒有 auth.uid()）放行 —— 見 migration_166 檔頭
  if v_role is null then return new; end if;

  /*
   * ★★★ 現金帳戶全部放行（migration_184）。
   *
   *   現金流水的唯一來源是手 key 的人，**沒有對帳單可以重新上傳**——
   *   擋住修改等於把打錯的字永久封存。
   *
   * ★ 用 new.account_id 查而不是 old：搬帳戶（改 account_id）的情況下
   *   要看的是「會變成哪一種」。實務上不會搬，但寫 old 的話
   *   「從現金搬到銀行」會用現金的規則放行，那是反的。
   */
  select kind into v_kind from public.bank_accounts where id = new.account_id;
  if v_kind = 'cash' then return new; end if;

  /*
   * ★★★ 系統自己的餘額重算（migration_243）。
   *
   *   `recalc_account_balances()` 是從 AFTER INSERT 的觸發器裡呼叫的，
   *   所以到這裡時 `pg_trigger_depth()` 已經 > 1。
   *   它 UPDATE 的是 `balance`（我們算的餘額）與 `balance_note`
   *   —— 兩欄都是**推導值**，不是銀行印的事實。
   *
   * ★★ 放行的是**欄位**不是**時機**:深層呼叫改到金額、日期、帳號、
   *   或銀行印的 `bank_balance` 一樣擋。全部放行的話，
   *   日後任何一支新觸發器都能從這個洞把金額改掉而沒有東西會叫。
   */
  if pg_trigger_depth() > 1 then
    if (to_jsonb(new) - 'memo' - 'balance' - 'balance_note')
       <> (to_jsonb(old) - 'memo' - 'balance' - 'balance_note') then
      raise exception
        '系統內部改動了銀行流水的欄位（不只餘額）。這是程式的問題，'
        '不是操作問題 —— 請把這句話跟剛才的動作一起回報。'
        using errcode = 'check_violation';
    end if;
    return new;
  end if;

  /*
   * ★ 逐欄比對。用 `to_jsonb(new) - 'memo' <> to_jsonb(old) - 'memo'`
   *   比一個一個列出來好:之後加欄位不用回來改這裡，
   *   而漏改的症狀是「那個新欄位可以偷偷被改掉」。
   */
  if (to_jsonb(new) - 'memo') <> (to_jsonb(old) - 'memo') then
    raise exception
      '銀行流水只能編輯「摘要」。金額、日期、餘額、帳號都是銀行給的事實，'
      '改了這一頁就不再是對帳單的鏡像。要修正請重新上傳對帳單。'
      using errcode = 'check_violation';
  end if;

  return new;
end $function$;

do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('243_memo_only_depth');
  end if;
end $do$;

commit;


-- ══════════════════════════════════════════════════════════
-- 自檢
--
-- ★★★ 看不到這張表 = 上面爆了、整支回滾。
-- ══════════════════════════════════════════════════════════
select v.ord, v."檢查", v."結果", v."判定" from (

  select 1, '① 深層放行那一段進去了',
         case when (select prosrc from pg_proc where proname = 'bank_txn_memo_only')
                   ilike '%pg_trigger_depth%'
              then '有' else '沒有' end,
         case when (select prosrc from pg_proc where proname = 'bank_txn_memo_only')
                   ilike '%pg_trigger_depth%'
              then '✅' else '❌' end

  union all
  select 2, '②★★ 原本的三條規則都還在',
         (select string_agg(x.k, '、') from (values
            ('service key 放行'), ('現金放行'), ('只准改 memo')) as x(k)
           where case x.k
                   when 'service key 放行' then
                     (select prosrc from pg_proc where proname='bank_txn_memo_only') ilike '%v_role is null%'
                   when '現金放行' then
                     (select prosrc from pg_proc where proname='bank_txn_memo_only') ilike '%v_kind = ''cash''%'
                   else
                     (select prosrc from pg_proc where proname='bank_txn_memo_only') ilike '%對帳單的鏡像%'
                 end),
         /*
          * ★★★ 這一條在防的是「修一個 bug 順手拆掉三道防線」。
          *   改寫整支函式的時候，漏抄一段不會報錯 ——
          *   只會讓某一類寫入從此暢通無阻。
          */
         case when (select prosrc from pg_proc where proname='bank_txn_memo_only') ilike '%v_role is null%'
               and (select prosrc from pg_proc where proname='bank_txn_memo_only') ilike '%v_kind = ''cash''%'
               and (select prosrc from pg_proc where proname='bank_txn_memo_only') ilike '%對帳單的鏡像%'
              then '✅ 三條都在' else '❌ 少了一條 —— 立刻比對原文' end

  union all
  select 3, '③★★ bank_balance 沒有被放行',
         case when (select prosrc from pg_proc where proname='bank_txn_memo_only')
                   ilike '%- ''bank_balance''%'
              then '被放行了' else '沒有（正確）' end,
         /*
          * ★ bank_balance 是**銀行印的**餘額，去重靠它。
          *   重算不該碰它 —— 放行等於允許一個 bug 安靜地污染去重的依據。
          */
         case when (select prosrc from pg_proc where proname='bank_txn_memo_only')
                   ilike '%- ''bank_balance''%'
              then '❌ 不該放行' else '✅' end

  union all
  select 4, '④ 觸發器還掛著、而且只在 UPDATE',
         coalesce((select case t.tgtype::int & 28
                            when 16 then 'UPDATE'
                            when 20 then 'INSERT + UPDATE'
                            else t.tgtype::text end
                     from pg_trigger t
                    where t.tgrelid = 'public.bank_transactions'::regclass
                      and t.tgname = 'trg_bank_txn_memo_only'), '（觸發器不見了）'),
         case when (select t.tgtype::int & 28 from pg_trigger t
                     where t.tgrelid = 'public.bank_transactions'::regclass
                       and t.tgname = 'trg_bank_txn_memo_only') = 16
              then '✅' else '❌' end

  union all
  select 5, '⑤ 目前的銀行流水筆數',
         (select count(*)::text from public.bank_transactions),
         /*
          * ★ 不判對錯。這一支只改守衛，一列資料都不動 ——
          *   這個數字是給人跑完之後**跟跑之前比對**用的。
          */
         'ℹ 這支不動任何資料，數字應該跟跑之前一樣'

) v(ord, "檢查", "結果", "判定") order by v.ord;
