/*
 * 查-補代墊前最後一問.sql　2026-09-17（第三輪，只讀不寫）
 *
 * ══════════════════════════════════════════════════════════
 * 【上一輪查到什麼】
 *
 *   有請款單的支出 195 筆 ＝ 安幸 186 ＋ 愛皮 9
 *   安幸那 186 筆沒有代墊是**對的**（自己的錢付自己的費用）。
 *   愛皮那 9 筆:**4 筆勾了、5 筆沒勾**，而沒勾的 5 筆
 *   全部在同一張單 `PR-202608-086` 上（$246+$300+$217+$305+$261 ＝ $1,329）。
 *
 *   所以這不是「整批漏勾」，是**一張單漏勾**。
 *
 * ══════════════════════════════════════════════════════════
 * 【★★★ 但去畫面上補勾**不會有用** —— 這是這一輪最要緊的事】
 *
 * migration_237 的 `gen_expenses_from_pr()` 第一道守衛是：
 *
 *     if old.purchased_on is null then     ← 只有「第一次確認出款」才進去
 *
 * 代墊的暫付是在那個 if 裡面建的。`PR-202608-086` **早就出款了**
 * （支出都產生了），所以現在把 `advance_for_book` 改成 'aipi'：
 *
 *     · 欄位確實會變成 aipi、畫面上那顆勾會亮
 *     · **但一列暫付都不會產生**，`expenses.advance_id` 也還是 null
 *     · 而且**不會有任何錯誤訊息**
 *
 * ★ 這正是 README 那條「靜默的寫」——看起來做完了，實際上什麼都沒發生。
 *   要補就得由 migration 直接補三樣:欄位、暫付那一列、支出的 advance_id。
 *
 * ══════════════════════════════════════════════════════════
 * 【所以這一支在問的是：那 $1,329 到底是誰的錢出的】
 *
 * 甲　從安幸的**銀行帳戶**出去（`payout_account` 有值）
 *     → 安幸真的少了 $1,329，愛皮欠安幸 $1,329。**補代墊是對的。**
 *
 * 乙　從 Cindy 的**零用金**出去，而那 $30,000 還掛在暫付上沒收回
 *     → 補代墊的話，安幸同時掛著「Cindy 欠 30,000」與「愛皮欠 1,329」，
 *       而現金只出去過一次。**那是同一筆錢算兩次。**
 *
 * ★ 第 ② 列就在分辨這件事:看那張單的付款帳戶與付款方式。
 * ★★ 第 ⑥ 列查到「備註寫零用金的支出 $72,966 > 零用金 $30,000」——
 *   那代表中間一定有撥補。撥補如果是從銀行出的，甲就成立。
 *
 * ══════════════════════════════════════════════════════════
 * 【★ 第 ④ 列是對照組:已經勾了的那 4 筆長什麼樣】
 *   它們是「做對的樣子」。補的那一張要長得跟它們一樣，
 *   不然同一種單會有兩種形狀,而半年後沒有人分得出哪一種才對。
 *
 * ★ 這支**只讀不寫**，跑第二次、第十次答案都一樣。
 * ══════════════════════════════════════════════════════════
 */

with aipi_ex as (
  /* 愛皮那 9 筆有單的支出 */
  select e.id, e.spent_on, e.item_name, abs(e.amount)::int as amt,
         e.request_id, e.advance_id, e.pay_account,
         r.req_no, r.advance_for_book, r.payout_account, r.payment_method,
         r.purchased_on, r.status, r.book
  from public.expenses e
  join public.purchase_requests r on r.id = e.request_id
  where coalesce(e.book, 'anxing') = 'aipi'
),
target as (   /* 沒勾的那一張（不寫死單號:用「沒勾」去撈，單號變了也抓得到） */
  select * from aipi_ex where advance_for_book is null
),
okref as (    /* 已經勾了的那幾筆 —— 對照組 */
  select * from aipi_ex where advance_for_book is not null
),
acct as (
  /* 付款帳戶叫什麼名字。零用金／現金的話名字通常看得出來 */
  select code::text as code, name::text as name from public.payment_accounts
),
/*
 * ★★★ 「那個帳戶是不是零用金」要**判定**，不能只在句尾寫一句「除非…」。
 *
 *   第一版寫成「✅ 有付款帳戶…除非那個帳戶叫零用金（看上一格）」——
 *   那等於把唯一的警報關掉:綠勾會讓人直接往下做,
 *   而那句除非沒有人會回頭去比對（README:母體那條同一種病）。
 *
 * ★ 用 ilike 掃名字與代號兩邊。代號常常是 CASH／PETTY 而名字是中文。
 */
petty as (
  select exists (
    select 1 from target t
    left join acct a on a.code = t.payout_account
    where coalesce(a.name, '') ~ '零用金|現金|備用金'
       or coalesce(t.payout_account, '') ~* '^(cash|petty)'
  ) as hit
),
adv as (
  select a.id, a.request_id, a.category, a.for_book, a.counterparty,
         a.amount::int as amt, a.paid_on, a.paid_account, a.refunded_amount
  from public.advance_payments a
)

select * from (

  /*
   * ★ 母體要判定（README:母體是空的 → 每一條都回綠）。
   *   愛皮一筆有單的支出都沒有的話，下面每一列都證明不了任何事。
   */
  select 1 as ord, '① 母體：愛皮有單的支出' as "檢查",
         (select count(*)::text from aipi_ex) || ' 筆　│ 沒勾代墊的 '
         || (select count(*)::text from target) || ' 筆　│ 勾了的 '
         || (select count(*)::text from okref) || ' 筆' as "結果",
         case when (select count(*) from aipi_ex) = 0
              then '⚠ 一筆都沒有 —— **下面全部不算數**,要重查'
              when (select count(*) from target) = 0
              then '✅ 已經全部勾了 —— 不用補,這一輪到此為止'
              else '要補的是那 ' || (select count(*) from target) || ' 筆' end as "判定"

  union all
  /*
   * ★★★ 這一列是答案。付款帳戶有值 → 錢從銀行出去 → 甲。
   */
  select 2, '② 沒勾的那張單，錢從哪個帳戶出去',
         coalesce((select string_agg(distinct
                     req_no || '：出款日 ' || coalesce(purchased_on::text, '（沒有）')
                     || '　方式 ' || coalesce(payment_method, '（沒填）')
                     || '　帳戶 ' || coalesce(
                          (select name from acct where acct.code = t.payout_account),
                          coalesce(t.payout_account, '（沒填）')),
                     E'\n') from target t), '（沒有要補的單）'),
         case when not exists (select 1 from target)
              then '⚠ 沒有要補的'
              when exists (select 1 from target where payout_account is null)
              then '❌ **付款帳戶是空的** —— 那筆錢從哪出去的系統不知道,'
                   || '有可能是零用金。先問出來再補,不要猜'
              when (select hit from petty)
              then '❌ **那個帳戶就是零用金／現金** —— 補代墊的話,'
                   || '安幸會同時掛著「Cindy 欠 30,000」與「愛皮欠 1,329」,'
                   || '而現金只出去過一次。**先不要補**,要先把零用金那一側理清楚'
              else '✅ 是銀行帳戶,不是零用金 —— 錢真的從安幸的戶頭出去,'
                   || '愛皮欠安幸這筆。補代墊是對的' end

  union all
  /*
   * ★★ 支出那一側自己的付款帳戶。跟上一列不一致的話，
   *   代表這筆錢的來源在兩個地方記了兩種說法。
   */
  select 3, '③ 那幾筆支出自己記的付款帳戶',
         coalesce((select string_agg(
                     left(item_name, 20) || ' $' || amt
                     || ' → ' || coalesce(
                          (select name from acct where acct.code = t.pay_account),
                          coalesce(t.pay_account, '（空白）')),
                     E'\n' order by item_name) from target t), '（沒有）'),
         case when exists (select 1 from target where pay_account is null)
              then '⚠ 有空白的 —— 空白不等於零用金,只是沒填。跟第 ② 列一起看'
              else '參考 —— 跟第 ② 列對得起來就沒問題' end

  union all
  /*
   * ★★★ 對照組。已經勾了的那幾筆**真的產生暫付了嗎**。
   *   沒有的話，代表那條路徑本身就有問題,補之前要先弄清楚。
   */
  select 4, '④ 對照組：已經勾了的那幾筆，暫付真的產生了嗎',
         coalesce((select string_agg(
                     o.req_no || '（' || o.advance_for_book || '）→ '
                     || case when exists (select 1 from adv where adv.request_id = o.request_id)
                             then '暫付 $' || (select amt::text from adv where adv.request_id = o.request_id limit 1)
                             else '**沒有暫付**' end
                     || case when o.advance_id is null then '　支出沒接回去' else '　支出有接' end,
                     E'\n' order by o.req_no) from (select distinct req_no, request_id, advance_for_book, advance_id from okref) o),
                  '（一筆勾了的都沒有）'),
         case when not exists (select 1 from okref)
              then '⚠ 沒有對照組 —— 那「勾了會怎樣」只能照程式碼推,不能照資料看'
              when exists (select 1 from okref o
                            where not exists (select 1 from adv where adv.request_id = o.request_id))
              then '❌ 有勾了卻沒暫付的 —— **那條路徑本身有問題**,先查它再補'
              else '✅ 勾了就有暫付 —— 這是「對的樣子」,要補的那張也要長這樣' end

  union all
  /*
   * ★ 現在的代墊暫付全貌。上一輪說「代墊 2 筆 $11,880」——
   *   暫付是**一張單一列**不是一筆支出一列，所以 4 筆支出出自 2 張單是正常的。
   *   這一列把它印出來確認,不要用推的。
   */
  select 5, '⑤ 現在的代墊暫付',
         coalesce((select string_agg(
                     counterparty || ' $' || amt || '（' || paid_on || '，已收回 '
                     || coalesce(refunded_amount, 0)::int || '）', '　' order by paid_on)
                    from adv where category = '代墊'), '（一筆代墊都沒有）'),
         case when not exists (select 1 from adv where category = '代墊')
              then '⚠ 一筆都沒有'
              else '參考 —— 補完之後這裡會多一列「愛皮 $'
                   || coalesce((select sum(amt)::text from target), '0') || '」' end

  union all
  /*
   * ★★ 零用金那一側。撥補有沒有被記成暫付 ——
   *   有的話，$72,966 > $30,000 就解釋得通,而且甲成立。
   */
  select 6, '⑥ 零用金那一側：有沒有撥補的紀錄',
         '零用金暫付 ' || (select count(*)::text from adv where category = '零用金')
         || ' 筆 $' || coalesce((select sum(amt)::text from adv where category = '零用金'), '0')
         || '　│ 備註寫「撥補」的支出 '
         || (select count(*)::text from public.expenses where note ilike '%撥補%')
         || ' 筆 $' || coalesce((select sum(abs(amount))::bigint::text
                                   from public.expenses where note ilike '%撥補%'), '0'),
         case when (select count(*) from adv where category = '零用金') = 0
              then '⚠ 沒有零用金暫付 —— 那第 ⑥ 列證明不了什麼'
              when (select count(*) from public.expenses where note ilike '%撥補%') = 0
              then '⚠ 沒有任何支出寫著撥補 —— 那 $72,966 是怎麼從 $30,000 花出來的,'
                   || '要問出來（這是零用金自己的問題,不擋補代墊）'
              else '✅ 有撥補紀錄 —— 每一次撥補都是安幸真的付錢出去,'
                   || '所以愛皮那 $1,329 不會跟零用金重複算' end

  union all
  /*
   * ★★★ 補完之後要長什麼樣。**先印出來給人看**,
   *   不是等 migration 跑完才知道它做了什麼。
   */
  select 7, '⑦ 如果要補，會建出這一列',
         coalesce((select '類別 代墊　對象 愛皮　金額 $' || sum(amt)::text
                   || '　日期 ' || coalesce(max(purchased_on)::text, '?')
                   || '　收款帳戶 ' || coalesce(
                        (select name from acct where acct.code = max(t.payout_account)),
                        coalesce(max(t.payout_account), '（沒填 → 補不了）'))
                   from target t), '（沒有要補的）'),
         case when not exists (select 1 from target) then '⚠ 沒有要補的'
              when exists (select 1 from target where payout_account is null)
              then '❌ 收款帳戶填不出來 —— 收回時錢要回到哪個帳戶沒有答案,**先不要補**'
              when (select hit from petty)
              then '❌ 收款帳戶是零用金 —— 見第 ② 列,**先不要補**'
              else '✅ 這一列補得出來。確認金額與帳戶對,我就寫 migration' end

) v(ord, "檢查", "結果", "判定") order by v.ord;
