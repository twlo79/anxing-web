/*
 * migration_225 —— 現金拆成「正隆-現金」與「安幸-現金」
 * ============================================================
 * 2026-09-07 使用者：「現有現金改成 正隆-現金，然後多一個 安幸-現金，
 *                      功能和正隆-現金一樣」
 *
 * ============================================================
 * 【★★★ 上一版錯在哪：表名不是 accounts，是 bank_accounts】
 *
 *     ERROR: 42P01: relation "public.bank_accounts" does not exist
 *
 * ★ 這個錯**很便宜** —— 它當場就炸，而且指著行號。
 *   真正貴的是底下那兩個:它們不會炸,只會讓新的那張卡少一半功能,
 *   而沒有人知道為什麼「安幸那張跟正隆那張不一樣」。
 *
 * ============================================================
 * 【★★★ 兩個不照抄就會被資料庫退（或行為變樣）的欄位】
 *
 *   ① `bank` 是 **NOT NULL**（migration_142）。
 *      現金帳戶沒有銀行,migration_184 當初填的是字串 '現金'。
 *      不填 → not-null violation,整支中止。
 *
 *   ② `manual_entry` 預設是 **false**（migration_192）。
 *      前端的 `isManual` 是 `manual_entry === true || kind === 'cash'`,
 *      所以只給 kind='cash' 其實也會過 —— **但那是靠 or 撿回來的**。
 *      現有那一列是 true（192 明確 update 過）,新的一列不給 true 的話,
 *      兩列在資料庫裡長得不一樣,而任何一支只看 manual_entry 的查詢
 *      （192 的自檢就是這樣寫的）會把安幸-現金算成「上傳對帳單」的帳戶。
 *
 * ★ `account_no_tail` 可以留 null:migration_184 已經把 not null 拿掉、
 *   check 改成「cash 不檢查」,而唯一索引不擋多個 null。
 * ★ `parser` 留 null —— 沒有檔案要解析,匯入端點看到 null 就不會把它當候選。
 *
 * ============================================================
 * 【為什麼多一個 tab 不用改程式】
 *
 * 帳戶明細的分頁就是帳戶本身:
 *
 *     items={accounts.map((a) => ({ key: a.id, label: a.name }))}
 *
 * 卡片、流水、期初餘額、手動記帳、餘額重算全部照 `kind` / `manual_entry` 走,
 * 新的一列自動具備。**一行程式都不用改。**
 *
 * ============================================================
 * 【★★ 為什麼不直接 update ... where name = '現金'】
 *
 * 不知道線上那一列現在叫什麼、也不知道是不是只有一列。猜錯會改到別的帳戶,
 * 而那個錯**不會叫** —— 明細照樣顯示,只是名字掛在錯的錢上面。
 *
 * 所以這一支**先數,不是剛好一列就中止**。
 *
 * ============================================================
 * 【★ 表名是 `bank_accounts` 不是 `accounts`】（2026-09-08 踩到）
 *
 * 第一版寫成 `public.accounts` —— 那是**前端變數的名字**
 * （`accounts/page.tsx` 裡的 `const accounts`），不是資料表。
 * 實際的表叫 `bank_accounts`，現金帳戶也放在裡面，靠 `kind` 分。
 *
 * 症狀是 `relation "public.accounts" does not exist`，整支中止。
 * 這次很吵所以立刻發現 —— 但「照畫面上的字推資料庫的名字」
 * 的安靜版本，就是 CLAUDE.md 上那幾條坑。
 *
 * 【怎麼跑】整份貼進 Supabase SQL Editor，看最後那張自檢表。
 */

begin;

do $do$
declare
  n_cash int;
  v_id   uuid;
  v_name text;
  v_sort int;
begin
  -- ── 1. 先數現有的現金帳戶 ──────────────────────────
  select count(*) into n_cash from public.bank_accounts where kind = 'cash';

  if n_cash = 0 then
    raise exception '一列現金帳戶都沒有 —— 中止。先確認 kind=''cash'' 的那一列在哪';
  elsif n_cash > 1 then
    raise exception '現金帳戶有 % 列，不是 1 列 —— 中止。'
      '先確認哪一列才是要改名的那個（可能已經跑過這一支）', n_cash;
  end if;

  select id, name, sort into v_id, v_name, v_sort
    from public.bank_accounts where kind = 'cash';

  -- ── 2. 改名（已經改過就不動，這一支要能重跑）──────
  if v_name is distinct from '正隆-現金' then
    update public.bank_accounts set name = '正隆-現金' where id = v_id;
  end if;

  -- ── 3. 新增安幸-現金 ───────────────────────────────
  /*
   * ★ 欄位照 migration_184 建現金那一列的原樣:
   *     bank='現金'（NOT NULL）、account_no/tail/parser 都 null、kind='cash'
   *   再加上 192 的 manual_entry=true。
   *
   * ★★ sort 接在現有那列後面。**給同一個值的話兩張卡的先後
   *   每次重整都可能不一樣** —— 分頁順序就是 sort。
   */
  if not exists (select 1 from public.bank_accounts where name = '安幸-現金') then
    insert into public.bank_accounts
      (name, bank, account_no, account_no_tail, parser, kind, manual_entry, sort)
    values
      ('安幸-現金', '現金', null, null, null, 'cash', true, coalesce(v_sort, 9) + 1);
  end if;

  -- ── 4. 保險:現有那一列的 manual_entry 補成 true ────
  /*
   * ★ 192 已經 update 過,理論上是 true。但如果線上那一列是後來手動加的,
   *   它會是 default false —— 而畫面靠 `kind==='cash'` 的 or 撿回來,
   *   所以**看起來完全正常**,只有查資料庫才看得出兩列不一致。
   */
  update public.bank_accounts
     set manual_entry = true
   where kind = 'cash' and manual_entry is distinct from true;
end $do$;

do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('225_cash_two_books');
  end if;
end $do$;

commit;


-- ══════════════════════════════════════════════════════════
-- 自檢
-- ══════════════════════════════════════════════════════════
select v.ord, v."檢查", v."結果", v."判定" from (

  select 1, '① 現在有幾列現金帳戶',
         coalesce((select string_agg(name || '（sort ' || coalesce(sort, 0)::text || '）', '、' order by sort, name)
                     from public.bank_accounts where kind = 'cash'), '（一列都沒有）'),
         case when (select count(*) from public.bank_accounts where kind = 'cash') = 2
              then '✅ 兩列' else '❌ 不是兩列 —— 下面不用看' end

  union all
  -- ★★★ 兩列的行為欄位要一模一樣,不然兩張卡的功能會不同而看不出原因
  select 2, '②★★★ 兩列的行為欄位一不一樣',
         coalesce((select string_agg(name || '：kind=' || kind
                     || '、manual=' || manual_entry::text
                     || '、bank=' || coalesce(bank, 'null')
                     || '、tail=' || coalesce(account_no_tail, 'null')
                     || '、期初=' || coalesce(opening_balance, 0)::text, E'\n' order by sort)
                     from public.bank_accounts where kind = 'cash'), '—'),
         case when (select count(*) from public.bank_accounts
                     where kind = 'cash' and manual_entry is true) = 2
              then '✅ 兩列都是手動記帳 —— 新增／改／刪流水都會出現'
              else '❌ 有一列的 manual_entry 不是 true，那張卡會少一半功能' end

  union all
  select 3, '③ 兩列的 sort 有沒有撞在一起',
         (select count(distinct coalesce(sort, 0))::text || ' 種 sort 值'
            from public.bank_accounts where kind = 'cash'),
         case when (select count(distinct coalesce(sort, 0)) from public.bank_accounts
                     where kind = 'cash') = 2
              then '✅ 分頁順序穩定'
              else '⚠ sort 相同 —— 兩張卡的先後每次重整可能不一樣' end

  union all
  /*
   * ★★★ 母體要判定。安幸-現金是新的,流水本來就是 0 筆 —— 那是正常的。
   *   而正隆那邊**一筆都不該少**:這一支只改名字,沒有動任何一筆流水。
   */
  select 4, '④★★★ 兩列各有幾筆流水',
         coalesce((select string_agg(a.name || '：' || cnt.n::text || ' 筆', '、' order by a.sort)
                     from public.bank_accounts a
                     cross join lateral (select count(*) as n from public.bank_transactions t
                                          where t.account_id = a.id) cnt
                    where a.kind = 'cash'), '—'),
         case when (select count(*) from public.bank_transactions t
                     join public.bank_accounts a on a.id = t.account_id
                    where a.name = '安幸-現金') = 0
              then '✅ 安幸-現金 0 筆是正常的（新帳戶）。正隆的筆數應該跟改名前一樣'
              else 'ℹ 安幸-現金已經有流水了' end

  union all
  -- ★ 四個銀行帳戶不可以被這一支碰到
  select 5, '⑤ 銀行帳戶沒有被動到',
         coalesce((select string_agg(name, '、' order by sort)
                     from public.bank_accounts where kind = 'bank' and active), '（沒有）'),
         case when (select count(*) from public.bank_accounts
                     where kind = 'bank' and manual_entry is true) <= 1
              then '✅ 只有 08311 是手動（migration_192）'
              else '⚠ 手動的銀行帳戶不只一個 —— 對一下是不是被改到' end

  union all
  select 6, '⑥ 這一支有沒有被記錄',
         coalesce((select max(name) from public.schema_migrations
                    where name = '225_cash_two_books'), '（沒記到）'),
         case when exists (select 1 from public.schema_migrations
                            where name = '225_cash_two_books')
              then '✅' else '❌ record_migration 沒寫進去' end

) v(ord, "檢查", "結果", "判定") order by v.ord;
