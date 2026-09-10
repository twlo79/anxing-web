begin;

/*
 * migration_241  代墊只掛同一本帳的支出
 * ------------------------------------------------------------
 * 2026-09-10 —— 修 migration_240 的錯。
 *
 * ★★★ 240 的第 ③ 步寫成:
 *
 *     update expenses e set advance_id = a.id
 *       from advance_payments a ... where e.request_id = r.id
 *
 * **用 `request_id` 接，沒有分帳本。** 而一張請款單的支出不只一種:
 *
 *     項目支出   book = aipi     ← 愛皮的費用，該掛代墊
 *     匯費       book = anxing   ← 安幸的郵電費（sync_pr_fee_expense）
 *                                  ★ 這一筆**不該掛**
 *
 * 症狀:自檢第 ③ 條「暫付 $11,880 vs 支出 $11,895」差 $15 ——
 * 也就是愛皮被多算了一筆它沒欠的手續費。
 *
 * ★★ 錢沒有記錯（匯費還是記在安幸的郵電費上），
 *   錯的是**「誰欠誰」多算了 15 塊**。這種錯不會讓任何數字變紅:
 *   兩張報表各自看起來都正常。
 *
 * ============================================================
 * 【★★ 為什麼匯費是安幸的成本】
 *
 * 安幸選擇用「匯款」這個方式付錢，手續費是它自己的營運成本 ——
 * 愛皮欠的是那筆費用本身（11,880），不是安幸怎麼把錢送出去。
 *
 * ★ 若日後決定「代墊連手續費一起代墊」，那要做的是把匯費**改記到愛皮帳上**
 *   再讓它掛代墊 —— 而不是讓一筆 anxing 的支出掛著 aipi 的代墊。
 *   一筆支出的帳本與它的代墊對象不一致，是一個講不通的狀態。
 *
 * ============================================================
 * 【★★★ 240 的自檢也錯了，一起修】
 *
 * 240 的第 ⑤ 條寫「筆數應該是 3」，而 3 是我從一段**加了日期篩選**的
 * 診斷查詢數出來的 —— 那段濾掉了匯費。
 * 於是我拿「問法不同的兩個查詢」互相比較，
 * 得到一個必定為紅的檢查，而實際上一筆重複都沒有產生。
 *
 * ★ `CLAUDE.md` 已經有這一條（2026-09-02「拿兩個問法不同的檢查互相比較」）。
 *   底下的自檢改成**兩邊問同一件事**:都只算「跟代墊同一本帳的支出」。
 * ------------------------------------------------------------
 */

/*
 * ★ 只動「代墊」類別的。押金、保證金、零用金那些暫付本來就不掛支出，
 *   掃進來的話會去改一批跟這件事無關的資料。
 */
update public.expenses e
   set advance_id = null
  from public.advance_payments a
 where e.advance_id = a.id
   and a.category = '代墊'
   and coalesce(e.book, 'anxing') <> coalesce(a.for_book, 'anxing');

do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('241_advance_same_book');
  end if;
end $do$;

commit;


-- ══════════════════════════════════════════════════════════
-- 自檢
--
-- ★★★ 看不到這張表 = 上面爆了、整支回滾。
-- ══════════════════════════════════════════════════════════
select v.ord, v."檢查", v."結果", v."判定" from (

  select 1, '①★★★ 還有沒有「帳本對不起來」的代墊支出',
         coalesce((select string_agg(coalesce(e.book,'anxing') || '→' || a.for_book
                                     || ' $' || e.amount::text, '、')
                     from public.expenses e
                     join public.advance_payments a on a.id = e.advance_id
                    where a.category = '代墊'
                      and coalesce(e.book,'anxing') <> coalesce(a.for_book,'anxing')),
                  '（0 筆）'),
         case when not exists (
                select 1 from public.expenses e
                  join public.advance_payments a on a.id = e.advance_id
                 where a.category = '代墊'
                   and coalesce(e.book,'anxing') <> coalesce(a.for_book,'anxing'))
              then '✅' else '❌ 還有掛錯的' end

  union all
  /*
   * ★★★ 這一條是 240 第 ③ 條的正確版本:
   *   兩邊都只問「跟代墊同一本帳的支出」——
   *   240 那邊右邊算的是「這張單的全部支出」（含安幸的匯費），
   *   左右問的不是同一件事，所以必定對不上。
   */
  select 2, '②★★★ 每一筆代墊 vs 它那本帳的支出',
         coalesce((select string_agg(x.who || ' 暫付$' || x.adv::text
                                     || ' / 支出$' || x.exp::text, '　' order by x.who)
                     from (
                       select a.counterparty as who, a.amount as adv,
                              coalesce((select sum(e.amount) from public.expenses e
                                         where e.advance_id = a.id), 0) as exp
                         from public.advance_payments a
                        where a.category = '代墊') x), '（沒有代墊）'),
         case when not exists (
                select 1 from public.advance_payments a
                 where a.category = '代墊'
                   and a.amount <> coalesce((select sum(e.amount) from public.expenses e
                                              where e.advance_id = a.id), 0))
              then '✅ 每一筆都對得上' else '❌ 有對不上的' end

  union all
  select 3, '③ 匯費現在記在哪一本',
         coalesce((select string_agg(coalesce(e.book,'anxing') || ' $' || e.amount::text, '、')
                     from public.expenses e
                     join public.purchase_requests r on r.id = e.request_id
                    where r.advance_for_book is not null
                      and coalesce(e.book,'anxing') <> coalesce(r.book,'anxing')),
                  '（這些單沒有別本帳的支出）'),
         /*
          * ★ 不判對錯 —— 匯費留在安幸是**刻意**的（見檔頭）。
          *   這一條只是把它印出來，讓人看得到那筆錢去哪了。
          */
         'ℹ 匯費是安幸的營運成本，留在安幸帳上'

  union all
  select 4, '④ 支出總筆數沒有變多',
         (select count(*)::text from public.expenses e
           join public.purchase_requests r on r.id = e.request_id
          where r.req_no in ('PR-202608-075','PR-202608-077')) || ' 筆',
         /*
          * ★★ 240 這一條寫死「應該是 3」，而 3 是從一段加了日期篩選的
          *   查詢數出來的 —— 濾掉了匯費。這裡改成**跟基準無關**的問法:
          *   4 筆（三筆項目 ＋ 一筆匯費）。真正要防的是「變成 7、8 筆」。
          */
         case when (select count(*) from public.expenses e
                     join public.purchase_requests r on r.id = e.request_id
                    where r.req_no in ('PR-202608-075','PR-202608-077')) <= 4
              then '✅ 沒有重複產生' else '❌ 變多了 —— 立刻查' end

  union all
  select 5, '⑤ 愛皮這個月的支出總額',
         '$' || coalesce((select sum(e.amount)::text from public.expenses e
                           where coalesce(e.book,'anxing') = 'aipi'
                             and e.spent_on >= '2026-09-01'
                             and e.spent_on <  '2026-10-01'), '0'),
         'ℹ 應該還是 11,880 —— 這一支只動 advance_id，不動任何金額'

) v(ord, "檢查", "結果", "判定") order by v.ord;
