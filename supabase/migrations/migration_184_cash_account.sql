/*
 * migration_184 —— 現金帳戶：手動記帳的第五個帳戶
 * ============================================================
 * 2026-08-31 使用者：「多一個現金帳戶。交易型態填現金，交易帳號填人名。
 *                     現金不會有匯入，都是手動 key」
 *            「key 錯了要可以改、可以刪」
 *
 * 【它跟前四個帳戶哪裡不一樣】
 *
 *   |            | 銀行帳戶            | 現金帳戶          |
 *   |------------|--------------------|------------------|
 *   | 資料怎麼來 | 上傳 PDF 對帳單     | 一筆一筆手 key    |
 *   | 帳號       | 20992000108311     | **沒有**          |
 *   | 餘額       | 銀行印在對帳單上    | 程式從上一筆累加  |
 *   | 能不能改   | 只能改摘要          | **全部都能改**    |
 *   | 期初餘額   | 對帳單接得起來      | 留空，從 0 開始   |
 *
 * 這四個差異裡有**三個會撞到既有的限制**，所以這支不是「插一列」那麼簡單。
 *
 * ============================================================
 * 【★★★ 撞到的第一件事：末五碼是 not null 而且要五位數字】
 *
 * migration_142:
 *   account_no_tail text not null,
 *   constraint bank_accounts_tail_len check (account_no_tail ~ '^[0-9]{5}$')
 *
 * 現金帳戶沒有帳號。兩條路：
 *
 *   ✗ 塞一個假碼（'00000'）—— 三個月後有人看到 00000 不知道那是什麼，
 *     而且真的有銀行帳號末五碼是 00000 時會撞上唯一索引。
 *     這正是 migration_142 註解裡擔心的事:「一半的流水記到錯的帳上,靜靜地」。
 *
 *   ✓ 加一個 `kind` 欄位，**只有 kind='bank' 才檢查格式**。
 *
 * ★ 走第二條。假碼是「用資料結構裝一個謊」——
 *   之後每一支查詢都要記得「喔那個 00000 是特例」，而總有一支會忘記。
 *
 * ============================================================
 * 【★★★ 撞到的第二件事：資料庫擋住修改】
 *
 * migration_166 的 `trg_bank_txn_memo_only`：
 *   「銀行流水只能編輯摘要。金額、日期、餘額、帳號都是銀行給的事實」
 *
 * 那句話對銀行帳戶是對的 —— 改了就不再是對帳單的鏡像，要修正請重新上傳。
 * **但現金流水沒有對帳單可以重新上傳。** 它的來源就是那個 key 的人。
 * 打錯字的話，那道鎖等於把錯誤永久封存。
 *
 * ★ 所以觸發器改成:先看這一列屬於哪一種帳戶，
 *   `cash` 直接放行，`bank` 照舊只准改 memo。
 *
 * ★★ 這**不是把鎖拿掉**。四個銀行帳戶的那道鎖一個字都沒鬆 ——
 *   自檢第 4 項會證明它還擋得住。
 *
 * ============================================================
 * 【★★ 撞到的第三件事：餘額是 not null】
 *
 * `balance numeric(14,2) not null`。銀行帳戶的餘額是 PDF 上印的，
 * 現金帳戶沒有人印給你 —— 所以由前端從上一筆累加後一起寫進來
 * （`src/lib/cash-txn.ts` 的 `recalcBalances`）。
 *
 * ★ 不改成 nullable。允許 null 的話「還沒算」跟「餘額真的是 0」
 *   會長得一樣，而畫面上分不出來。餘額永遠算得出來，就永遠要有值。
 *
 * ============================================================
 * 【期初餘額留空】（2026-08-31 使用者選的）
 *
 * 第一筆的餘額就是那一筆的金額。之後想補期初，
 * 改 `bank_accounts.opening_balance` 那一列，前端會重算。
 */

-- ══════════════════════════════════════════════════════════
-- 一、kind 欄位
-- ══════════════════════════════════════════════════════════
/*
 * ★ `not null default 'bank'`：既有四個帳戶全部是銀行帳戶。
 *   允許 null 的話，「還沒分類」跟「是銀行帳戶」會長得一樣 ——
 *   而下面那個 check 判斷式碰到 null 會回 null（不是 false），
 *   等於**檢查悄悄失效**。這是 SQL 三值邏輯最常見的坑。
 */
alter table public.bank_accounts
  add column if not exists kind text not null default 'bank';

do $$
begin
  alter table public.bank_accounts
    add constraint bank_accounts_kind_chk check (kind in ('bank', 'cash'));
exception when duplicate_object then
  null;  -- 重跑安全
end $$;

comment on column public.bank_accounts.kind is
  'bank=銀行帳戶（上傳對帳單，只能改摘要）／cash=現金帳戶（手動 key，全部可改）。'
  '決定三件事:要不要檢查末五碼格式、能不能改流水、畫面上要不要顯示上傳鈕。';

-- ══════════════════════════════════════════════════════════
-- 二、末五碼：現金帳戶放行
-- ══════════════════════════════════════════════════════════
/*
 * ★★ 順序很重要:**先放寬檢查，再放寬 not null**。
 *   反過來的話，中間那一瞬間欄位可以是 null 但 check 還要求五位數字，
 *   而 `null ~ '^[0-9]{5}$'` 回 null → check 當作通過 → 看起來沒事，
 *   但如果有人在這中間插資料就會留下一列非法資料。
 *   同一個交易裡跑其實碰不到，但寫對的順序不用付出任何代價。
 */
alter table public.bank_accounts drop constraint if exists bank_accounts_tail_len;

do $$
begin
  alter table public.bank_accounts
    add constraint bank_accounts_tail_len
    check (kind = 'cash' or account_no_tail ~ '^[0-9]{5}$');
exception when duplicate_object then
  null;
end $$;

alter table public.bank_accounts alter column account_no_tail drop not null;

/*
 * ★ 唯一索引不用動。Postgres 的 unique index **不擋多個 null**
 *   （null 彼此不相等），所以以後再多幾個現金帳戶也不會撞。
 *   而四個銀行帳戶的末五碼照舊唯一。
 */

-- ══════════════════════════════════════════════════════════
-- 三、觸發器：現金流水放行
-- ══════════════════════════════════════════════════════════
/*
 * 改的只有開頭那一段「先看是哪一種帳戶」。
 * 底下比對欄位的邏輯與錯誤訊息一字未動 —— 銀行帳戶的行為完全不變。
 */
create or replace function public.bank_txn_memo_only()
returns trigger language plpgsql security definer set search_path to 'public'
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

comment on function public.bank_txn_memo_only() is
  '銀行流水只能改 memo；現金流水（kind=cash）全部可改（migration_184）。'
  '前端也擋，但前端擋不住重新整理後的舊畫面。';

-- ══════════════════════════════════════════════════════════
-- 四、建立現金帳戶
-- ══════════════════════════════════════════════════════════
/*
 * ★ `sort = 9` 不是 5:現金放在所有銀行帳戶**後面**，
 *   而且留出空號給之後可能再開的銀行帳戶。
 *   給 5 的話下次開第五個銀行帳戶就得跟現金搶位置。
 *
 * ★ `parser` 留 null —— 沒有解析器，因為沒有檔案要解析。
 *   匯入端點看到 null 就不會把它當成候選帳戶。
 */
insert into public.bank_accounts
  (name, bank, account_no, account_no_tail, parser, kind, sort)
select '現金', '現金', null, null, null, 'cash', 9
 where not exists (select 1 from public.bank_accounts where kind = 'cash');


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('184_cash_account');
  end if;
end $$;


-- ══════════════════════════════════════════════════════════
-- 自檢的前置：真的塞一筆非法資料，看擋不擋得住
-- ══════════════════════════════════════════════════════════
/*
 * ★★★ 「check 還在嗎」不能用查 pg_constraint 的方式驗 ——
 *   查得到只代表**有那個東西**，不代表它擋得住。
 *   放寬條件時最容易犯的錯是條件寫反（`kind = 'bank' or …`），
 *   而那種錯查 pg_constraint 一樣查得到。所以要實際塞一筆進去。
 *
 * ★★ `begin … exception` 在 plpgsql 裡是一個**隱含的 savepoint**——
 *   insert 失敗只回滾這一小塊，不會把整支 migration 帶走。
 *   （SQL Editor 把整份腳本包在一個交易裡,見 CLAUDE.md）
 */
create temp table _chk184 (ord int, result text) on commit drop;

do $$
declare v_msg text;
begin
  begin
    insert into public.bank_accounts (name, bank, account_no_tail, kind, sort)
    values ('★自檢用,應該進不去', 'x', 'abc', 'bank', 999);
    -- 走到這裡代表沒擋住 —— 把它刪掉再報告
    delete from public.bank_accounts where name = '★自檢用,應該進不去';
    insert into _chk184 values (3, '⚠ 沒擋住!末五碼 abc 被寫進去了(已刪除)');
  exception when check_violation then
    insert into _chk184 values (3, 'OK,擋住了');
  when others then
    get stacked diagnostics v_msg = message_text;
    insert into _chk184 values (3, '擋住了,但錯誤型別不是 check_violation:' || v_msg);
  end;
end $$;

/*
 * 觸發器這一項**只能做結構檢查**，不能實際試。
 *
 * ★★ 因為 SQL Editor 沒有 `auth.uid()`，`current_role_of()` 回 null，
 *   而觸發器第一行就對 null 放行（那條例外是留給匯入排程的）。
 *   從 SQL Editor 試著改金額**一定會成功**，證明不了任何事情。
 *
 * 所以退而檢查三件事:觸發器還掛著、函式裡還有那句 raise exception、
 * 而且新增了 cash 的放行。三個都在的話行為就是對的。
 */
do $$
declare
  v_src  text := coalesce(pg_get_functiondef('public.bank_txn_memo_only()'::regprocedure), '');
  v_trig boolean := exists (
    select 1 from pg_trigger
     where tgrelid = 'public.bank_transactions'::regclass
       and tgname = 'trg_bank_txn_memo_only' and not tgisinternal);
begin
  insert into _chk184 values (4,
    case
      when not v_trig then '⚠ 觸發器不見了 —— 銀行流水現在誰都能改'
      when v_src not like '%raise exception%' then '⚠ 函式裡沒有 raise exception 了'
      when v_src not like '%cash%' then '⚠ 函式裡沒有 cash 的放行 —— 現金流水會改不動'
      else '觸發器在 ＋ 銀行仍會 raise ＋ 現金已放行'
    end);
end $$;

-- ══════════════════════════════════════════════════════════
-- 自檢。★ `raise notice` 在 SQL Editor 看不到，所以回一張表。
-- ★ 排序欄位留在子查詢裡（`v.ord`）—— `order by 1` 會照文字排（migration_181 踩過）。
-- ══════════════════════════════════════════════════════════
select v."檢查項目", v."結果", v."說明" from (

  select 1, '★★★ 現金帳戶建好了',
         coalesce((select name || '｜kind=' || kind
                        || '｜末五碼=' || coalesce(account_no_tail, '(空，正確)')
                        || '｜parser=' || coalesce(parser, '(無，正確)')
                        || '｜sort=' || sort
                     from public.bank_accounts where kind = 'cash'),
                  '⚠ 沒有這一列'),
         '末五碼與 parser 都要是空的 —— 有值的話它會被匯入當成候選帳戶'

  union all
  select 2, '★★ 分頁會長這樣（active 照 sort）',
         (select string_agg(name, ' ｜ ' order by sort, name)
            from public.bank_accounts where active),
         '應該是 70564 ｜ 24145 ｜ 48088 ｜ 08311 ｜ 現金，現金在最後'

  union all
  /*
   * ★★★ 這一項是這支 migration 最重要的一條。
   *   放寬末五碼的檢查之後，**銀行帳戶還是不能亂填**——
   *   實際塞一筆非法資料進去看它擋不擋得住。
   */
  select 3, '★★★ 銀行帳戶的末五碼還是擋得住',
         (select result from _chk184 where ord = 3),
         '實際塞一筆 kind=bank 末五碼 abc 進去,要被擋下來(條件寫反的話這裡會過)'

  union all
  /*
   * ★★★ 第二重要的一條:銀行流水的那道鎖沒有被鬆掉。
   */
  select 4, '★★★ 銀行流水的鎖沒鬆',
         (select result from _chk184 where ord = 4),
         '★ 只能結構檢查:SQL Editor 沒有 auth.uid(),觸發器對它一律放行,試不出來'

  union all
  /*
   * ★ 這支只加一列與一個欄位，**既有帳戶與所有流水都不該動**。
   */
  select 5, '★★ 既有資料沒動',
         (select count(*) filter (where kind = 'bank')::text || ' 個銀行帳戶 ／ '
                 || (select count(*) from public.bank_transactions)::text || ' 筆流水 ／ '
                 || (select count(*) from public.bank_statements)::text || ' 份對帳單'
            from public.bank_accounts),
         '應該是 4 個銀行帳戶 ／ 1865 筆流水 ／ 15 份對帳單,跟跑之前一模一樣'

  union all
  select 6, '現金帳戶的期初餘額',
         coalesce((select coalesce(opening_balance::text, '(留空,第一筆從 0 開始)')
                     from public.bank_accounts where kind = 'cash'), '—'),
         '★ 使用者選的。之後想補期初就改這一欄,前端會重算後面所有餘額'

) v(ord, "檢查項目", "結果", "說明") order by v.ord;
