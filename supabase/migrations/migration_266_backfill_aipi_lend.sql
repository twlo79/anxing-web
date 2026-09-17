/*
 * migration_266_backfill_aipi_lend.sql　2026-09-17
 * 補回漏勾「安幸代墊」的請款單（愛皮 PR-202608-086）
 *
 * 【怎麼跑】整份貼進 Supabase SQL Editor，看最後那張自檢表。
 *          ★ 看不到自檢的表格＝整支回滾了，不是「跑成功但沒輸出」。
 *
 * ══════════════════════════════════════════════════════════
 * 【為什麼不能去畫面上勾一勾就好】
 *
 * `gen_expenses_from_pr()`（migration_237）第一道守衛是：
 *
 *     if old.purchased_on is null then     ← 只有「第一次確認出款」才進去
 *
 * 代墊的暫付是在那個 if **裡面**建的。086 早就出款了，所以現在把
 * `advance_for_book` 改成 'aipi'：
 *
 *     · 欄位確實會變、畫面上那顆勾會亮
 *     · **一列暫付都不會產生**，`expenses.advance_id` 也還是 null
 *     · 而且不會有任何錯誤訊息
 *
 * ★★★ 一個靜默的寫 ＝ 一個不存在的功能（README 2026-09-03 那條）。
 *   所以三樣東西要在這裡直接補：欄位、暫付那一列、支出的 advance_id。
 *
 * ══════════════════════════════════════════════════════════
 * 【★★★ 為什麼敢補 —— 以及我上一輪判錯了什麼】
 *
 * 上一輪的查詢在第 ② 列判了紅，理由是付款帳戶叫 `(安幸)現金`，
 * 而我那條檢查拿「現金」兩個字去比對名字就當成 Cindy 的零用金。
 *
 * **那是誤報。** `(安幸)現金` 是安幸自己的現金帳戶（一個 payment_account）；
 * Cindy 那 $30,000 是 `advance_payments` 的一列，對象欄寫著 Cindy。
 * 兩者是不同的東西 —— 而我拿名字去猜，猜錯了。
 *
 * 真正的證據是**對照組**：
 *
 *     PR-202608-075（愛皮）→ 暫付 $4,530　已記
 *     PR-202608-077（愛皮）→ 暫付 $7,350　已記
 *     PR-202608-086（愛皮）→ **沒記**
 *
 * 三張都是愛皮的單、都出款了。前兩張記了代墊，第三張沒有 ——
 * 那不是兩種做法，那是**漏了一張**。
 *
 * ★★ 所以這支的守衛不是「帳戶叫什麼名字」，而是
 *   **「已經做對的那幾張，跟這一張用的是不是同一個付款帳戶」**。
 *   不是的話代表它真的是另一種情況，整支 raise 停下來，不要自作主張。
 *
 * ══════════════════════════════════════════════════════════
 * 【★★ 為什麼不會跟零用金重複算】
 *
 * 那 61 筆備註寫「零用金撥補」的支出共 $72,966，而零用金只給了 $30,000 ——
 * 中間必然撥補過很多次，而**每一次撥補都是安幸真的付錢出去**。
 * 零用金那 $30,000 是「Cindy 手上還有多少」，愛皮這 $1,329 是
 * 「愛皮欠安幸多少」—— 兩個對象不同、兩筆錢不同。
 *
 * ★ 零用金那一側自己有問題（$72,966 是怎麼從 $30,000 花出來的、
 *   撥補有沒有記成暫付），那是另一輪要查的，**不擋這一支**。
 *
 * ══════════════════════════════════════════════════════════
 * 【跑兩次結果一樣】
 *   · `advance_for_book` 的 update 帶 `is null` 條件
 *   · `advance_payments` 有 `ap_request_uniq(request_id)`，走 on conflict
 *   · `expenses.advance_id` 的 update 帶 `is null` 條件
 *   第二次跑：三個都影響 0 列，自檢一模一樣。
 * ══════════════════════════════════════════════════════════
 */

begin;

do $do$
declare
  r          record;
  v_ref_acct text;
  v_ref_n    int;
  v_items    numeric;
  v_ex       numeric;
  v_ap       uuid;
  v_done     int := 0;
begin
  /*
   * 要補的：其他事業體的單、已出款、沒勾代墊、而且真的產生過支出。
   *
   * ★ 不寫死單號。寫死的話這支只修得了今天這一張，
   *   而下一張漏勾的（一定會有，因為自動勾是今天才上線的）
   *   得再寫一支一模一樣的 migration。
   * ★★ 但**只補已經有支出的**。沒有支出的單代表還沒真的出款，
   *   那種要走正常流程,不是在這裡補。
   */
  for r in
    select pr.id, pr.req_no, pr.book, pr.payout_account, pr.purchased_on,
           pr.advance_usage, pr.note, pr.requester_id
      from public.purchase_requests pr
     where coalesce(pr.book, 'anxing') <> 'anxing'
       and pr.advance_for_book is null
       and pr.advance_category is null        -- 暫支款那種本來就不該有代墊
       and pr.status = 'approved'
       and pr.purchased_on is not null
       and exists (select 1 from public.expenses e where e.request_id = pr.id)
     order by pr.req_no
  loop

    /*
     * ══════ 守衛 ⓪：收回時錢要回到哪 ══════
     *
     * `paid_account` 是「收回時錢回到這個帳戶」。空的話收不回來，
     * 那筆暫付會永遠掛著而沒有人知道該怎麼結掉。
     *
     * ★ 這一道要**排在對照組前面**。排後面的話，帳戶是空的時候
     *   會被對照組先攔下來（空帳戶當然找不到同帳戶的對照組），
     *   而那句訊息講的是「找不到對照組」—— 看的人會去找對照組，
     *   真正的原因（帳戶沒填）一個字都沒提到。
     */
    if r.payout_account is null then
      raise exception '% 停下來：付款帳戶是空的，收回時錢要回哪裡沒有答案', r.req_no;
    end if;

    /*
     * ══════ 守衛 ①：對照組 ══════
     *
     * 同一本帳、已經勾了代墊、而且**同一個付款帳戶**的單有幾張。
     * 一張都沒有的話，這張單是那本帳的第一張代墊 ——
     * 那就沒有「做對的樣子」可以比對，我不該自己決定它算不算代墊。
     *
     * ★★★ 這一條就是上一輪那個誤報的修法:
     *   不要問「帳戶叫什麼名字」（我會猜錯），
     *   要問「同樣從這個帳戶出去的單，之前是怎麼記的」。
     */
    select count(*), min(x.payout_account)
      into v_ref_n, v_ref_acct
      from public.purchase_requests x
     where x.book = r.book
       and x.advance_for_book is not null
       and x.id <> r.id
       and x.payout_account is not distinct from r.payout_account;

    if v_ref_n = 0 then
      raise exception
        '% 停下來：同一本帳（%）、同一個付款帳戶（%）底下，'
        '找不到任何一張已經記了代墊的單可以比對。'
        '這可能是那本帳的第一張代墊，也可能它根本不是代墊 —— '
        '這支不猜，請人確認過再補。',
        r.req_no, r.book, coalesce(r.payout_account, '（沒填）');
    end if;

    /*
     * ══════ 守衛 ②：金額對得起來嗎 ══════
     *
     * 暫付的金額要跟觸發器算的一樣 —— `sum(purchase_request_items.amount)`。
     * 而支出是一個項目一筆從同一批 items 產生的，所以兩邊應該相等。
     *
     * ★★ 不相等代表這張單中間被動過（項目改了、支出被刪了、
     *   或有支出被記到別本帳上）。那種情況我不知道正確答案是什麼，
     *   **停下來報數字**，不要挑一個看起來比較合理的。
     */
    select coalesce(sum(i.amount), 0) into v_items
      from public.purchase_request_items i where i.request_id = r.id;
    select coalesce(sum(abs(e.amount)), 0) into v_ex
      from public.expenses e where e.request_id = r.id;

    if v_items <= 0 then
      raise exception '% 停下來：項目加總是 %，代墊金額必須大於 0', r.req_no, v_items;
    end if;
    if round(v_items) <> round(v_ex) then
      raise exception
        '% 停下來：項目加總 % 與已產生的支出加總 % 對不起來。'
        '中間有東西被改過或刪過 —— 先查清楚是哪一筆，不要照其中一個數字補。',
        r.req_no, round(v_items), round(v_ex);
    end if;

    -- ══════ 開始補 ══════

    update public.purchase_requests
       set advance_for_book = book
     where id = r.id and advance_for_book is null;

    /*
     * 暫付那一列。**每一個欄位都照 migration_237 的觸發器抄**，
     * 不要憑印象寫 —— 兩邊長得不一樣的話，
     * 半年後沒有人分得出哪一種才是對的（README 2026-09-03 那條）。
     */
    insert into public.advance_payments (
      request_id, category, for_book, counterparty, usage, estate_id,
      amount, paid_on, paid_account, note, created_by
    ) values (
      r.id, '代墊', r.book,
      case r.book when 'aipi' then '愛皮' when 'hongsha' then '洪鯊' else r.book end,
      coalesce(nullif(r.advance_usage, ''), '代墊請款單 ' || r.req_no),
      null,                                  -- ★ 代墊不掛物業:費用在別本帳上
      v_items, r.purchased_on, r.payout_account, r.note, r.requester_id
    )
    on conflict do nothing;

    select id into v_ap from public.advance_payments where request_id = r.id;

    /* 支出接回暫付。接不回去的話畫面上看不出這幾筆跟那列暫付有關。 */
    update public.expenses
       set advance_id = v_ap
     where request_id = r.id and advance_id is null;

    v_done := v_done + 1;
    raise notice '% 補好了：代墊 % → % $%（帳戶 %）',
      r.req_no, r.book,
      case r.book when 'aipi' then '愛皮' when 'hongsha' then '洪鯊' else r.book end,
      round(v_items), r.payout_account;
  end loop;

  /*
   * ★ `raise notice` 在 SQL Editor 看不到（README）。所以真正要看的是
   *   下面那張自檢表 —— 這裡的 notice 只是本機乾跑時方便。
   */
  if v_done = 0 then
    raise notice '沒有要補的 —— 可能已經跑過了（這支是冪等的）';
  end if;
end $do$;

do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('266_backfill_aipi_lend');
  end if;
end $do$;

commit;


-- ══════════════════════════════════════════════════════════
-- 自檢
-- ══════════════════════════════════════════════════════════

with other_pr as (
  /* 其他事業體、已出款、有產生支出的單 —— 這支的母體 */
  select pr.id, pr.req_no, pr.book, pr.advance_for_book, pr.payout_account
    from public.purchase_requests pr
   where coalesce(pr.book, 'anxing') <> 'anxing'
     and pr.status = 'approved' and pr.purchased_on is not null
     and exists (select 1 from public.expenses e where e.request_id = pr.id)
),
lend as (
  select a.request_id, a.counterparty, a.amount::int as amt, a.paid_on,
         a.paid_account, coalesce(a.refunded_amount, 0)::int as back
    from public.advance_payments a where a.category = '代墊'
),
/*
 * ══════════════════════════════════════════════════════════
 * 【★★★ 2026-09-17 修：第一版的 ④⑥ 是誤報】
 *
 * 第一版跑出來 ④「沒接回暫付 1 筆」、⑥「帳本對不起來 1 筆」，
 * 而查出來那是同一列:**PR-202608-077 的匯款手續費 $15**。
 *
 *   項目支出 $7,350 [aipi]　有接暫付
 *   匯款手續費   $15 [anxing]　沒接　← 被我標紅的那一筆
 *
 * 而它是**對的**:
 *   · 手續費是安幸真的花掉、收不回來的錢，本來就不是代墊
 *     （purchases 頁:「手續費不跟著岔開…那不是暫支」）
 *   · 所以它記在安幸帳上、沒有 advance_id，兩件事都是設計好的
 *   · 證據在第 ④ 列:暫付 $7,350 ＝ 同帳本支出 $7,350，
 *     而全部支出 $7,365 —— 差的剛好就是那 $15
 *
 * ★★★ 這正是 README 那條「自檢沒涵蓋既有資料的合法形狀」。
 *   誤報會把真警報淹掉 —— 兩個紅字擺在那裡，下次真的漏了一筆
 *   也只會被當成「喔又是那兩個」。
 *
 * ★★ 修法是加 `source_item_id is not null`:**只數從請款項目長出來的支出**。
 *   手續費那一筆是另一條路徑產生的（migration_83），它沒有 source_item_id。
 *
 * ★ 但**不能默默排除掉** —— 底下第 ⑥ 列把手續費單獨印出來。
 *   安靜地少數一種東西，跟誤報一樣糟:下次它真的出問題時沒有人看得到。
 * ══════════════════════════════════════════════════════════
 */
orphan as (
  /* 勾了代墊，但**從項目長出來的**支出沒接回暫付 */
  select count(*) as n from public.expenses e
   join other_pr p on p.id = e.request_id
   where p.advance_for_book is not null and e.advance_id is null
     and e.source_item_id is not null
),
bookgap as (
  /* 從項目長出來的支出，帳本該跟它那張單一樣（pr_book_guard 擋的） */
  select count(*) as n from public.expenses e
   join other_pr p on p.id = e.request_id
   where coalesce(e.book, 'anxing') is distinct from p.book
     and e.source_item_id is not null
),
fees as (
  /* 不是從項目長出來的（匯款手續費那種）。單獨數，不要藏起來。 */
  select count(*) as n, coalesce(sum(abs(e.amount))::int, 0) as amt,
         count(*) filter (where coalesce(e.book, 'anxing') = 'anxing') as on_anxing
    from public.expenses e
    join other_pr p on p.id = e.request_id
   where e.source_item_id is null
),
gap as (
  select string_agg(g::text, '　' order by g) as miss
    from generate_series(200, 266) g
   where not exists (select 1 from public.schema_migrations m
                      where split_part(m.name, '_', 1) = g::text)
)

select * from (

  /*
   * ★★★ 母體要判定（README:母體是空的 → 每一條都回綠）。
   *   其他事業體一張已出款的單都沒有的話，下面每一列都自動成立。
   */
  select 1 as ord, '① 母體：其他事業體已出款、有支出的單' as "檢查",
         (select count(*)::text from other_pr) || ' 張　│ 勾了代墊的 '
         || (select count(*) filter (where advance_for_book is not null) from other_pr)::text
         || ' 張　│ 沒勾的 '
         || (select count(*) filter (where advance_for_book is null) from other_pr)::text
         || ' 張' as "結果",
         case when (select count(*) from other_pr) = 0
              then '⚠ **一張都沒有 —— 下面全部不算數**'
              else '參考 —— 第 ② 列在判它' end as "判定"

  union all
  /*
   * ★★★ 這一列是這支的目的。跑完之後**一張都不該剩**。
   */
  select 2, '② 還有沒有漏勾的',
         coalesce((select string_agg(req_no || '（' || book || '）', '　' order by req_no)
                     from other_pr where advance_for_book is null), '（沒有）'),
         case when (select count(*) from other_pr) = 0 then '⚠ 母體是空的,不算數'
              when exists (select 1 from other_pr where advance_for_book is null)
              then '❌ 還有漏的 —— 上面那幾張沒補到,要看是被哪一道守衛擋下來'
              else '✅ 全部都勾了' end

  union all
  /*
   * ★★ 勾了 ≠ 有暫付。這一列問的是**暫付那一列真的在嗎** ——
   *   只改欄位不建暫付，正是「去畫面上勾一勾」會發生的事。
   */
  select 3, '③ 勾了的單，暫付真的建出來了嗎',
         (select count(*) filter (where advance_for_book is not null) from other_pr)::text
         || ' 張勾了　│ 其中有暫付的 '
         || (select count(*) from other_pr p
              where p.advance_for_book is not null
                and exists (select 1 from lend l where l.request_id = p.id))::text || ' 張',
         case when (select count(*) filter (where advance_for_book is not null) from other_pr) = 0
              then '⚠ 一張勾了的都沒有 —— 這一列證明不了什麼'
              when exists (select 1 from other_pr p
                            where p.advance_for_book is not null
                              and not exists (select 1 from lend l where l.request_id = p.id))
              then '❌ 有勾了卻沒暫付的 —— 那就是「欄位改了但什麼都沒發生」'
              else '✅ 勾一張就有一列暫付' end

  union all
  /*
   * ★★ 支出有沒有接回暫付。沒接的話畫面上看不出這幾筆屬於那列暫付，
   *   收回的時候不知道沖銷掉的是哪些錢。
   */
  select 4, '④ 項目支出接回暫付了嗎（不含手續費）',
         '沒接回去的 ' || (select n from orphan)::text || ' 筆',
         case when (select count(*) filter (where advance_for_book is not null) from other_pr) = 0
              then '⚠ 沒有勾了的單,不算數'
              when (select n from orphan) > 0
              then '❌ 還有 ' || (select n from orphan) || ' 筆沒接 —— 收回時對不出是哪幾筆'
              else '✅ 都接上了（手續費那種不算,它本來就不是代墊,見第 ⑥ 列）' end

  union all
  /*
   * ★ 現在的代墊全貌。補之前是 2 列 $11,880，補完應該是 3 列。
   */
  select 5, '⑤ 代墊暫付現況',
         coalesce((select count(*)::text || ' 列　$' || sum(amt)::text
                     || '（未收回 ' || count(*) filter (where back = 0)::text || ' 列）'
                     from lend), '（一列都沒有）'),
         case when not exists (select 1 from lend) then '⚠ 一列都沒有'
              else '參考 —— 對一下「其他收支帳」與「暫收付管理 → 暫付」兩頁的數字' end

  union all
  /*
   * ★★ 這一列**不是這支造成的**，是順手把它照出來。
   *   其他事業體的單產生的支出，照理說 book 要跟單一樣
   *   （一張單只能有一本帳，pr_book_guard 擋的）。
   *   對不起來的那幾筆會讓「愛皮這個月花多少」少算。
   */
  /*
   * ★★ 上面 ④⑤ 都把手續費排除掉了。**這一列就是把它請出來**——
   *   安靜地少數一種東西，跟誤報一樣糟。
   */
  select 6, '⑥ 手續費那種（不從項目長出來的支出）',
         (select n from fees)::text || ' 筆 $' || (select amt from fees)::text
         || '　│ 記在安幸帳上的 ' || (select on_anxing from fees)::text || ' 筆',
         case when (select n from fees) = 0
              then '✅ 一筆都沒有'
              when (select on_anxing from fees) = (select n from fees)
              then '✅ 全部記在安幸帳上、不進代墊 —— 這是對的:'
                   || '手續費是安幸真的花掉、收不回來的錢'
              else '⚠ 有 ' || ((select n from fees) - (select on_anxing from fees))
                   || ' 筆沒記在安幸帳上 —— 手續費照理都該是安幸的,要看一下' end

  union all
  select 7, '⑦ 項目支出的帳本，跟它那張單對得起來嗎',
         (select n from bookgap)::text || ' 筆對不起來',
         case when (select count(*) from other_pr) = 0 then '⚠ 母體是空的,不算數'
              when (select n from bookgap) > 0
              then '⚠ 有 ' || (select n from bookgap) || ' 筆 —— **這是另一個問題**,'
                   || '不是這支造成的。那幾筆會讓那本帳的月支出少算,要另外查'
              else '✅ 每一筆項目支出都記在它那張單的帳本上' end

  union all
  select 8, '⑧ 200～266 之間還缺哪幾號',
         coalesce((select miss from gap), '（沒有缺）'),
         case when (select miss from gap) is null then '✅ 一號都沒缺'
              else '⚠ 還缺：' || (select miss from gap) end

  union all
  select 9, '⑨ 這一支有沒有被記錄',
         coalesce((select max(name) from public.schema_migrations
                    where name = '266_backfill_aipi_lend'), '（沒記到）'),
         case when exists (select 1 from public.schema_migrations
                            where name = '266_backfill_aipi_lend')
              then '✅' else '❌ record_migration 沒寫進去' end

) v(ord, "檢查", "結果", "判定") order by v.ord;
