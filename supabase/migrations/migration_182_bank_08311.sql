/*
 * migration_182 —— 第四個銀行帳戶：元大 08311
 * ============================================================
 * 2026-08-31 使用者：「多加一個 tab / 帳號 08311」
 *            完整帳號 20992000108311，元大銀行，之後才上傳對帳單。
 *
 * 【為什麼加一列資料要寫成 migration】
 *
 * 帳戶明細那三個分頁不是寫死的，是 `bank_accounts` 撈出來的
 * （`.eq('active', true).order('sort')`）。所以「多一個分頁」＝「多一列」。
 *
 * ★ 直接在 SQL Editor 手打 insert 也會動，但那一列**不會留下任何紀錄**：
 *   三個月後看到第四個分頁，查不到它是誰、什麼時候、為什麼加的。
 *   寫成 migration 才有 `schema_migrations` 那一行。
 *
 * ============================================================
 * 【★★ 完整帳號一定要填】
 *
 * `account_no` 填了就用它比對（去掉非數字後全等）；留空才退回末五碼。
 *
 * 而末五碼比對是**最低保證**，不是安全的做法 —— migration_142 的註解寫著：
 * 「票據號碼（012-0000341168247682）裡隨時會出現一樣的五碼，
 *   撞上就整份記到錯的帳戶」。
 *
 * 這次使用者直接給了 20992000108311，所以一開始就是全比對。
 *
 * ============================================================
 * 【期初餘額留空是刻意的】
 *
 * 使用者：「之後上傳對帳單」。`opening_balance` 不填的話，
 * 最早那一筆流水的餘額連不起來 —— **自檢會報，但不擋**（migration_142 的設計）。
 *
 * ★ 不亂填 0。0 是「帳上真的沒錢」，跟「還不知道」是兩件事，
 *   而填了 0 之後沒有人會回頭改 —— 那個帳戶的餘額就從此差一截。
 *
 * ============================================================
 * 【沒有一併加進 payment_accounts】
 *
 * 使用者：「不用，這個帳戶不出款」。支出頁的「安幸付款帳號」是另一張表，
 * 兩張表刻意分開：**收得到錢** 跟 **付得出錢** 不是同一件事。
 */

insert into public.bank_accounts
  (name, bank, account_no, account_no_tail, parser, sort)
values
  ('元大 08311', '元大銀行', '20992000108311', '08311', 'yuanta', 4)
/*
 * ★ 重跑要安全。末五碼有唯一索引（`uq_bank_accounts_tail`），
 *   第二次跑會撞上 —— `do nothing` 讓它安靜跳過而不是整份腳本炸掉。
 */
on conflict (account_no_tail) do nothing;


-- ── 記錄執行 ───────────────────────────────────────
-- ★ 沒有這一段的話 `select * from schema_migrations` 查不到這一支跑過沒有，
--   而「程式推了但 SQL 沒跑」的症狀要等有人點到那個分頁才會發現。
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('182_bank_08311');
  end if;
end $$;


-- ══════════════════════════════════════════════════════════
-- 自檢。★ `raise notice` 在 SQL Editor 看不到，所以回一張表。
-- ★ 排序欄位留在子查詢裡（`v.ord`）—— `order by 1` 會照文字排（migration_181 踩過）。
-- ══════════════════════════════════════════════════════════
select v."檢查項目", v."結果", v."說明" from (

  select 1, '★★★ 新帳戶建好了',
         coalesce((select name || '｜' || bank || '｜' || coalesce(account_no, '(沒有完整帳號)')
                        || '｜parser=' || coalesce(parser, '(無)')
                        || '｜sort=' || sort || '｜' || case when active then '啟用' else '停用' end
                     from public.bank_accounts where account_no_tail = '08311'),
                  '⚠ 沒有這一列'),
         '要看到 20992000108311 與 yuanta —— 完整帳號沒填的話對帳只能靠末五碼比'

  union all
  /*
   * ★★ 分頁是「active 且照 sort 排」撈出來的。
   *   這裡把實際順序印出來 —— sort 撞號的話畫面上分頁的順序會不穩定，
   *   而那不會報錯，只是每次重整可能換位置。
   */
  select 2, '★★ 分頁會長這樣（active 照 sort）',
         (select string_agg(name, ' ｜ ' order by sort, name)
            from public.bank_accounts where active),
         '應該是 70564 ｜ 24145 ｜ 48088 ｜ 08311 四個'

  union all
  select 3, '★ sort 沒有撞號',
         (select case when count(*) = count(distinct sort)
                      then '沒有撞（' || count(*) || ' 個帳戶）'
                      else '⚠ 有重複的 sort，分頁順序會不穩定' end
            from public.bank_accounts where active),
         'sort 一樣時排序退回 name，每次重整不保證同一個順序'

  union all
  /*
   * ★ 這支只加一列，**既有三個帳戶與所有流水都不該動**。
   */
  select 4, '★★ 既有資料沒動',
         (select count(*)::text || ' 個帳戶 ／ '
                 || (select count(*) from public.bank_transactions)::text || ' 筆流水 ／ '
                 || (select count(*) from public.bank_statements)::text || ' 份對帳單'
            from public.bank_accounts),
         '流水與對帳單的數字跟跑之前要一模一樣'

  union all
  select 5, '新帳戶的期初餘額',
         coalesce((select coalesce(opening_balance::text, '(留空，等第一份對帳單)')
                     from public.bank_accounts where account_no_tail = '08311'), '—'),
         '★ 刻意留空。填 0 的話「帳上沒錢」跟「還不知道」會長得一樣，而沒有人會回頭改'

) v(ord, "檢查項目", "結果", "說明") order by v.ord;
