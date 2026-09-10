begin;

/*
 * migration_240  補建「安幸代墊愛皮」的暫付紀錄
 * ------------------------------------------------------------
 * 2026-09-10 使用者：「那現在 安幸代墊愛皮的部分 會變暫支嗎」
 *
 * ★★★ 現況（查證過，不是推測）
 *
 *   req_no          book  advance_for_book  item              amount  advance_id
 *   PR-202608-075   aipi  null              115/7月勞保費        3,102  null
 *   PR-202608-075   aipi  null              115/7月健保費        1,428  null
 *   PR-202608-077   aipi  null              115/7-8月管理服務費  7,350  null
 *
 * 這三筆是 migration_236／237 之前產生的 —— 那時候請款單上還沒有
 * 「安幸代墊」那個勾選框。所以:
 *
 *   愛皮  帳上有 11,880 的費用     ✅ 對的
 *   安幸  **什麼都沒有**            ❌ 錢出去了，帳上看不出誰欠誰
 *
 * ★★ 少的不是費用，是**應收**。安幸付了錢卻沒有任何一筆紀錄說
 *   「愛皮欠我 11,880」—— 而少一筆應收不會讓任何數字變紅，
 *   只會讓安幸的資產看起來比實際少。
 *
 * ============================================================
 * 【★★★ 為什麼只補這兩張，不寫成一條通則】
 *
 * 直覺是「凡是 book 不是 anxing、又有支出、又沒有暫付的，一律補」。
 * **不做** —— 那等於假設「其他事業體的請款一定是安幸代墊」，
 * 而那個假設沒有根據:愛皮哪天用自己的帳戶付一筆，
 * 這條通則會替它憑空長出一筆安幸的應收。
 *
 * ★ 所以這一支**只動使用者確認過的那兩張單**，
 *   而底下的自檢會把「其他長得像的候選」列出來讓人自己決定
 *   （`CLAUDE.md`:建議，不自動;對不上的不猜）。
 *
 * ============================================================
 * 【★★ 為什麼補資料不會再產生一次支出】
 *
 * `gen_expenses_from_pr()` 的第一道守衛是
 *
 *     if old.purchased_on is null then
 *
 * 這兩張單早就有出款日了，所以把 `advance_for_book` 補上去時
 * 那一整塊**不會執行**。查證過才寫，不是憑印象。
 *
 * ★ 一張請款單**一筆暫付**（`ap_request_uniq`），不是一筆支出一筆 ——
 *   跟觸發器同一個做法，所以 075 那兩筆共用一筆 4,530 的暫付。
 * ------------------------------------------------------------
 */

-- ── 要補的單。改這裡就好，底下不用動 ──────────────────
create temp table _m240(req_no text primary key) on commit drop;
insert into _m240 values ('PR-202608-075'), ('PR-202608-077');

-- ── ① 把單標記成「安幸代墊」───────────────────────────
/*
 * ★ 先擋掉不該補的:帳本必須不是 anxing（安幸付安幸沒有代墊這回事），
 *   而且不能已經是暫支款（兩者互斥，跟觸發器同一條規則）。
 */
do $do$
declare bad text;
begin
  select string_agg(r.req_no || '（' || coalesce(r.book,'anxing')
                    || coalesce('，暫支=' || r.advance_category, '') || '）', '、')
    into bad
    from public.purchase_requests r
    join _m240 m on m.req_no = r.req_no
   where coalesce(r.book,'anxing') = 'anxing' or r.advance_category is not null;
  if bad is not null then
    raise exception '這幾張不該補代墊：% —— 安幸自己的單沒有代墊，暫支款與代墊互斥', bad;
  end if;

  -- ★ 找不到單就停下來，不要默默補 0 張（母體是 0 的那條坑）
  if (select count(*) from public.purchase_requests r join _m240 m on m.req_no = r.req_no)
     <> (select count(*) from _m240) then
    raise exception '有單號找不到 —— 對一下有沒有打錯';
  end if;
end $do$;

update public.purchase_requests r
   set advance_for_book = coalesce(r.book, 'anxing')
  from _m240 m
 where m.req_no = r.req_no
   and r.advance_for_book is null;

-- ── ② 建暫付。★ 欄位照 gen_expenses_from_pr 抄，不要憑印象 ──
insert into public.advance_payments (
  request_id, category, for_book, counterparty, usage, estate_id,
  amount, paid_on, paid_account, note, created_by
)
select
  r.id, '代墊', coalesce(r.book, 'anxing'),
  -- ★ 對象是「要還錢的人」，不是廠商 —— 廠商已經收到錢了
  case coalesce(r.book,'anxing')
    when 'aipi' then '愛皮' when 'hongsha' then '洪鯊' else r.book end,
  coalesce(nullif(r.advance_usage, ''), '代墊請款單 ' || r.req_no),
  null,                                   -- ★ 代墊不掛物業:費用在別本帳上
  (select sum(i.amount) from public.purchase_request_items i where i.request_id = r.id),
  r.purchased_on,
  r.payout_account,                       -- ★ 收回時要回到這個帳戶
  r.note, r.requester_id
from public.purchase_requests r
join _m240 m on m.req_no = r.req_no
on conflict do nothing;                   -- ap_request_uniq：重跑不會變成兩列

-- ── ③ 支出指回那筆暫付 ────────────────────────────────
/*
 * ★★★ 2026-09-10 修:一定要加**帳本條件**。
 *
 * 原本只用 `e.request_id = r.id` 接 —— 而一張請款單的支出不只一種:
 *
 *     項目支出   book = aipi     ← 愛皮的費用，該掛代墊
 *     匯費       book = anxing   ← 安幸的郵電費，**不該掛**
 *
 * 少了這個條件，愛皮會被算成欠了一筆它沒欠的手續費（$15）。
 * 錢沒有記錯，錯的是「誰欠誰」—— 而那種錯不會讓任何數字變紅。
 *
 * ★★ 這一行也讓這支變成**重跑安全**:沒有它的話，
 *   240 跑第二次會把 migration_241 拆掉的匯費**重新掛回去**。
 */
update public.expenses e
   set advance_id = a.id
  from public.advance_payments a
  join public.purchase_requests r on r.id = a.request_id
  join _m240 m on m.req_no = r.req_no
 where e.request_id = r.id
   and e.advance_id is null
   and coalesce(e.book, 'anxing') = coalesce(a.for_book, 'anxing');

do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('240_backfill_advance');
  end if;
end $do$;

commit;


-- ══════════════════════════════════════════════════════════
-- 自檢
--
-- ★★★ 在 commit 之後。**看不到它 = 上面爆了、整支回滾**。
-- ══════════════════════════════════════════════════════════
with tgt as (
  select r.id, r.req_no, r.book, r.advance_for_book, r.purchased_on
    from public.purchase_requests r
   where r.req_no in ('PR-202608-075', 'PR-202608-077')
)
select v.ord, v."檢查", v."結果", v."判定" from (

  select 1, '① 兩張單都標成代墊了',
         coalesce((select string_agg(req_no || '→' || coalesce(advance_for_book,'(null)'), '　')
                     from tgt), '（找不到單）'),
         case when (select count(*) from tgt where advance_for_book is not null) = 2
              then '✅' else '❌' end

  union all
  select 2, '② 暫付建出來了',
         coalesce((select string_agg(t.req_no || '：$' || a.amount::text, '　' order by t.req_no)
                     from tgt t join public.advance_payments a on a.request_id = t.id), '（一筆都沒有）'),
         case when (select count(*) from tgt t
                     join public.advance_payments a on a.request_id = t.id) = 2
              then '✅' else '❌' end

  union all
  select 3, '③★★★ 暫付總額 vs **同一本帳的**支出總額',
         '暫付 $' || coalesce((select sum(a.amount)::text from tgt t
                                join public.advance_payments a on a.request_id = t.id), '0')
         || '　支出 $' || coalesce((select sum(e.amount)::text from tgt t
                                     join public.expenses e on e.request_id = t.id
                                    where coalesce(e.book,'anxing') = coalesce(t.book,'anxing')), '0'),
         /*
          * ★★★ 這一條是整支最重要的。兩邊對不上的話，
          *   安幸記的應收跟愛皮記的費用是兩個數字 ——
          *   而**兩邊各自看起來都正常**，只有相減時差一截。
          *
          * ★★ 2026-09-10 修:右邊原本算「這張單的全部支出」，
          *   而那含了記在安幸的匯費 —— **左右問的不是同一件事**，
          *   所以必定差一個手續費。這是 CLAUDE.md 那條
          *   「拿兩個問法不同的檢查互相比較」（2026-09-02）。
          */
         case when coalesce((select sum(a.amount) from tgt t
                              join public.advance_payments a on a.request_id = t.id), 0)
                 = coalesce((select sum(e.amount) from tgt t
                              join public.expenses e on e.request_id = t.id
                             where coalesce(e.book,'anxing') = coalesce(t.book,'anxing')), 0)
              then '✅ 一致' else '❌ 對不上 —— 先不要往下走' end

  union all
  -- ★ 分母只算「跟代墊同一本帳的」—— 安幸的匯費本來就不該接上
  select 4, '④ 該接的支出都指回暫付了',
         (select count(*)::text from tgt t join public.expenses e on e.request_id = t.id
           where e.advance_id is not null) || ' / '
         || (select count(*)::text from tgt t join public.expenses e on e.request_id = t.id
              where coalesce(e.book,'anxing') = coalesce(t.book,'anxing')),
         case when not exists (
                select 1 from tgt t join public.expenses e on e.request_id = t.id
                 where e.advance_id is null
                   and coalesce(e.book,'anxing') = coalesce(t.book,'anxing'))
              then '✅' else '❌ 還有支出沒接上' end

  union all
  select 5, '⑤ 沒有重複產生支出',
         (select count(*)::text from tgt t join public.expenses e on e.request_id = t.id)
         || ' 筆（含安幸的匯費）',
         /*
          * ★★ 觸發器的守衛是 `if old.purchased_on is null` —— 這兩張早就有
          *   出款日，所以 update 不會再跑一次那一塊。這一條是**驗證那個判斷**:
          *   多產生一組的話帳直接雙倍，而總額只是「比較大」。
          *
          * ★★★ 2026-09-10 修:原本寫死「應該是 3」，而那個 3 是我從一段
          *   **加了日期篩選**的診斷查詢數出來的 —— 它濾掉了匯費。
          *   於是這一條必定為紅，而實際上一筆重複都沒有產生。
          *   基準值不可以來自一個問法不同的查詢（CLAUDE.md，2026-09-02）。
          *
          * ★ 改成上界:項目 ＋ 最多一筆匯費 = 4。真正要防的是「變成 7、8 筆」。
          */
         case when (select count(*) from tgt t join public.expenses e on e.request_id = t.id) <= 4
              then '✅ 沒有重複產生' else '❌ 筆數變多了 —— 立刻查' end

  union all
  select 6, '⑥ 其他長得像的候選（不自動補，給人看）',
         coalesce((select string_agg(x.req_no || '：$' || x.amt::text, '、')
                     from (select r.req_no, sum(e.amount) as amt
                             from public.purchase_requests r
                             join public.expenses e on e.request_id = r.id
                            where coalesce(r.book,'anxing') <> 'anxing'
                              and r.advance_for_book is null
                            group by r.req_no) x), '（沒有了）'),
         /*
          * ★ 刻意**不判對錯**。「其他事業體的請款一定是安幸代墊」
          *   這個假設沒有根據 —— 愛皮哪天用自己的帳戶付，
          *   自動補會替它憑空長出一筆安幸的應收。
          */
         'ℹ 要不要補由人決定，把單號加進 _m240 再跑一次'

) v(ord, "檢查", "結果", "判定") order by v.ord;
