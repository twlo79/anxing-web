/*
 * migration_192 —— 08311 改成手動記帳（不上傳對帳單）
 * ============================================================
 * 2026-09-01 使用者：「08311 像現金一樣 手動建入 沒有對帳單上傳」
 *                     「請注意 排序不要像上次一樣踩坑」
 *
 * ============================================================
 * 【★★★ 為什麼不是直接把 kind 改成 'cash'】
 *
 * 那樣一行就好，而且畫面上的行為全部立刻正確 —— 但**它是個謊**:
 *
 *   08311 是**真的銀行帳戶**（元大 20992000108311）。
 *   說它是現金，之後每一份報表、每一次查詢都要記得「喔那個 cash 其實是銀行」。
 *
 * ★ 而且有一個馬上看得到的副作用:現金帳戶的「交易帳號」欄顯示的是
 *   `counterparty`（人名），因為現金沒有對方帳號。
 *   08311 有 —— 它匯款進來的對方是有帳號的。改成 cash 就看不到了。
 *
 * ============================================================
 * 【所以拆成兩個獨立的旗標】
 *
 *   kind          這是什麼帳戶     → 決定**顯示**（交易帳號欄放帳號還是人名）
 *   manual_entry  資料怎麼進來的   → 決定**行為**（能不能手動新增／改／刪、
 *                                    要不要顯示上傳鈕、餘額怎麼算）
 *
 *   現金    kind='cash'  manual_entry=true   人名 ／ 手動
 *   08311  kind='bank'  manual_entry=true   對方帳號 ／ 手動   ← 這一支加的
 *   其餘三個 kind='bank'  manual_entry=false  對方帳號 ／ 上傳對帳單
 *
 * ★★ 一個欄位兼兩個意思，是「以後每次都要多想一次」的來源。
 *   現在拆開的成本是一個欄位，之後合著用的成本是每一次。
 *
 * ============================================================
 * 【★★★ 排序：這次不會重蹈 migration_187 的覆轍】
 *
 * 現金帳戶那次踩的坑是 `seq` 全部是 null —— 同一天的幾筆排序平手，
 * 而平手時 Postgres 回什麼順序沒有保證，重算一次餘額就可能換順序。
 *
 * ★ 這一支**不需要回填**，因為 08311 現在一筆流水都沒有。
 *   而新增的那些會走 `saveCash()`，它已經在呼叫 `nextSeq(txns)`
 *   （migration_187 之後補的）—— 每一筆一進去就有 seq。
 *
 * ★★ 自檢第 4 列會確認這件事:如果 08311 已經有流水而且 seq 是空的，
 *   它會直接說出來，而不是等到有人發現餘額每次都在跳。
 */

alter table public.bank_accounts
  add column if not exists manual_entry boolean not null default false;

comment on column public.bank_accounts.manual_entry is
  '資料是人手 key 的（migration_192）。true = 沒有對帳單可上傳，'
  '流水由人新增／編輯／刪除，餘額由前端從上一筆累加。'
  '★ 跟 kind 是**兩件事**：kind 決定畫面怎麼顯示，manual_entry 決定能做什麼。';

/*
 * 現金帳戶本來就是手動的 —— 把既有的語意補寫進新欄位。
 *
 * ★★ 這一步不能省。不補的話畫面上的判斷式要寫成
 *   `kind = 'cash' or manual_entry`，而那個 or 會被複製到十個地方，
 *   然後某一處漏掉 —— 症狀是「現金分頁的新增鈕不見了」。
 *   **讓資料自己說清楚，程式就只要問一個問題。**
 */
update public.bank_accounts set manual_entry = true where kind = 'cash';

-- 08311：銀行帳戶，但手動記帳
update public.bank_accounts set manual_entry = true where account_no_tail = '08311';


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('192_manual_entry');
  end if;
end $$;


-- ══════════════════════════════════════════════════════════
-- 自檢。★ `raise notice` 在 SQL Editor 看不到，所以回一張表。
-- ★ 排序欄位留在子查詢裡（`v.ord`）—— `order by 1` 會照文字排（migration_181 踩過）。
-- ══════════════════════════════════════════════════════════
select v."檢查項目", v."結果", v."說明" from (

  select 1, '★★★ 五個帳戶現在長這樣',
         (select string_agg(
                   name || '（' || kind || '／'
                   || case when manual_entry then '手動' else '上傳對帳單' end || '）',
                   E'\n' order by sort, name)
            from public.bank_accounts where active),
         '要看到 70564／24145／48088 是「bank／上傳對帳單」，'
           || '08311 是「bank／手動」，現金是「cash／手動」'

  union all
  select 2, '★★ 08311 的顯示仍然是銀行的',
         (select case when kind = 'bank' then '✅ kind=bank —— 交易帳號欄照樣顯示對方帳號'
                      else '⚠ kind=' || kind || ' —— 交易帳號欄會變成填人名' end
            from public.bank_accounts where account_no_tail = '08311'),
         '★ 它是真的銀行帳戶，只是資料用手 key。改成 cash 會看不到對方帳號'

  union all
  select 3, '★ 三個上傳對帳單的帳戶沒被動到',
         (select count(*)::text || ' 個仍然是上傳模式：'
                 || string_agg(name, '、' order by sort)
            from public.bank_accounts where active and not manual_entry),
         '應該是 3 個（70564／24145／48088）'

  union all
  /*
   * ★★★ 排序的坑（migration_187 踩過）。
   *   手動記帳的帳戶如果有流水而 seq 是空的，同一天的順序不固定 ——
   *   重算一次餘額就可能換順序，而總額不變所以不會報錯。
   */
  select 4, '★★★ 手動帳戶的流水都有 seq 嗎',
         (select case when count(*) filter (where t.seq is null) = 0
                      then '✅ ' || count(*) || ' 筆全部有 seq（0 筆也算通過）'
                      else '⚠ 有 ' || count(*) filter (where t.seq is null)
                           || ' 筆 seq 是空的 —— 同一天的順序不固定，要回填' end
            from public.bank_transactions t
            join public.bank_accounts a on a.id = t.account_id
           where a.manual_entry),
         '★ 08311 現在是 0 筆，新增的會由前端的 nextSeq() 給號。'
           || '之後如果這裡冒出警告，照 migration_187 的做法回填'

  union all
  select 5, '★★ 既有資料沒動',
         (select count(*)::text || ' 個帳戶 ／ '
                 || (select count(*) from public.bank_transactions)::text || ' 筆流水 ／ '
                 || (select count(*) from public.bank_statements)::text || ' 份對帳單'
            from public.bank_accounts),
         '這支只加一個欄位並設值，一筆流水都不該動'

  union all
  select 6, '08311 目前有幾筆流水',
         (select count(*)::text || ' 筆'
            from public.bank_transactions t
            join public.bank_accounts a on a.id = t.account_id
           where a.account_no_tail = '08311'),
         '0 筆的話不用回填 seq；有的話看第 4 列'

) v(ord, "檢查項目", "結果", "說明") order by v.ord;
