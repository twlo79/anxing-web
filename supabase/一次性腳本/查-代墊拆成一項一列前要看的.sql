/*
 * 查-代墊拆成一項一列前要看的.sql　2026-09-18（只讀不寫）
 *
 * ══════════════════════════════════════════════════════════
 * 【使用者 2026-09-18：「請款單裡有的項目 要拆出來」】
 *
 * 現在的代墊暫付是**一張請款單一列**：
 *
 *     115/7月勞保費 等 2 筆        $4,530
 *     115/7月電信費-0975… 等 5 筆  $1,329
 *     115/7-8月管理服務費          $7,350
 *
 * 要改成**一個項目一列**（8 列）：
 *
 *     115/7月健保費   $1,428     115/7月電信費-0975  $246
 *     115/7月勞保費   $3,102     115/8月電信費-2778  $305
 *     旅平險          $261       115/7月電信費-2778  $300
 *     115/7-8月管理服務費 $7,350  115/8月電信費-0975  $217
 *
 * ★★★ 這樣「一列暫付」就對到「一筆支出」1:1 —— 愛皮還錢時
 *   收回哪一列，愛皮那邊就長出哪一筆實支。現在是 1:多，對不起來。
 *
 * ══════════════════════════════════════════════════════════
 * 【★★★ 為什麼要先跑這支，而不是直接寫 migration】
 *
 * 要拆得動，得改三樣東西，而**三樣我都還沒看過線上真正長什麼樣**：
 *
 *   ① `ap_request_uniq`      它就是「一張單只准一列」的那條約束
 *   ② `gen_expenses_from_pr` 130 行，我手上只有 migration_237 的版本 ——
 *                            238～271 之間有沒有人動過它，我不知道
 *   ③ 還有誰在讀 advance_payments（收回那條路可能假設一列對一張單）
 *
 * ★ 憑我手上那份副本去 `create or replace`，等於拿可能過期的東西
 *   蓋掉線上的，而蓋掉的部分**不會叫**（README 2026-09-01 那條）。
 *
 * ★★ 所以這支把線上的真貨印出來。**第 ② 列印的是整段函式**，
 *   會很長 —— 那正是重點，我要照著它改，不是照我的記憶改。
 *
 * ★ 這支**只讀不寫**，跑幾次都一樣。
 * ══════════════════════════════════════════════════════════
 */

with lend as (
  select a.id, a.request_id, a.usage, a.amount::int as amt, a.counterparty,
         a.refunded_on, coalesce(a.refunded_amount, 0)::int as back
    from public.advance_payments a where a.category = '代墊'
),
/*
 * ★ prokind 一定要濾 —— 掃到聚合函式整支會炸（README 2026-09-01）
 */
writers as (
  select p.proname::text as name
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prokind in ('f','p')
     and pg_get_functiondef(p.oid) ~ '\madvance_payments\M'
),
/* advance_payments 上所有的唯一索引與約束 —— 擋路的就在裡面 */
uniq as (
  select i.relname::text as name, pg_get_indexdef(x.indexrelid)::text as def
    from pg_index x
    join pg_class i on i.oid = x.indexrelid
   where x.indrelid = 'public.advance_payments'::regclass
     and x.indisunique
)

select * from (

  /*
   * ★ 母體要判定。一列代墊都沒有的話，下面問的東西都沒有意義。
   */
  select 1 as ord, '① 現在的代墊暫付' as "檢查",
         coalesce((select string_agg(
                     coalesce(usage, '（沒有項目）') || '　$' || amt
                     || case when back > 0 then '　已收回 ' || back else '' end,
                     E'\n' order by amt desc) from lend), '（一列都沒有）') as "結果",
         case when not exists (select 1 from lend)
              then '⚠ **一列代墊都沒有 —— 下面全部不算數**'
              when exists (select 1 from lend where back > 0)
              then '⚠ 已經有收回過的 —— 拆的時候那筆收回要跟著拆，先講清楚是哪一列'
              else '✅ 都還沒收回 —— 拆起來乾淨（沒有已收回的錢要重新分配）' end as "判定"

  union all
  /*
   * ★★★ 這一列是這支最要緊的:**線上那支函式的真正內容**。
   *   我要照著它改，不是照 migration_237 的副本改。
   *   ★ 很長,整段貼回來給我就好。
   */
  select 2, '② gen_expenses_from_pr 線上的真正內容',
         coalesce((select pg_get_functiondef(p.oid)::text
                     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                    where n.nspname = 'public' and p.proname = 'gen_expenses_from_pr'
                      and p.prokind in ('f','p') limit 1),
                  '★ 找不到這支函式'),
         case when not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                                where n.nspname = 'public' and p.proname = 'gen_expenses_from_pr'
                                  and p.prokind in ('f','p'))
              then '❌ 找不到 —— 那代墊是從哪產生的？要重查'
              else '★ 整段貼回來給我。我照這一份改,不照我手上的副本' end

  union all
  /*
   * ★★★ 擋路的約束。「一張單一列」就是它在保證的。
   */
  select 3, '③ advance_payments 上的唯一索引',
         coalesce((select string_agg(name || '：' || def, E'\n' order by name) from uniq),
                  '（一個都沒有）'),
         case when not exists (select 1 from uniq)
              then '⚠ 一個唯一索引都沒有 —— 那 on conflict do nothing 從來沒生效過,'
                   || '重跑會產生重複的列,要一起查'
              when exists (select 1 from uniq where def ~ '\mrequest_id\M')
              then '✅ 找到了 —— 那條就是「一張單只准一列」,拆之前要換掉它'
              else '⚠ 沒有掛在 request_id 上的 —— 跟我以為的不一樣,要看上面印的' end

  union all
  /*
   * ★★ 還有誰在寫 advance_payments。收回那條路可能也假設
   *   「一列對一張單」——只改產生端而漏了收回端的話，
   *   拆完之後收回會對不到。
   */
  select 4, '④ 還有哪些函式碰 advance_payments',
         coalesce((select string_agg(name, '、' order by name) from writers), '（一支都沒有）'),
         case when not exists (select 1 from writers)
              then '⚠ 一支都沒有 —— 那它全部靠前端寫,要 grep 前端'
              else '★ 這幾支我都要看過 —— 其中有沒有假設「一張單一列」的' end

  union all
  /*
   * ★★ 拆完之後應該有幾列。拿**項目數**算，不是拿支出數算 ——
   *   支出可能包含手續費那種不是從項目長出來的（2026-09-17 踩過）。
   */
  select 5, '⑤ 拆完之後會是幾列',
         (select count(*)::text from public.purchase_request_items i
           where i.request_id in (select request_id from lend where request_id is not null))
         || ' 列（現在 ' || (select count(*)::text from lend) || ' 列）',
         case when not exists (select 1 from lend) then '⚠ 母體是空的,不算數'
              when (select count(*) from public.purchase_request_items i
                     where i.request_id in (select request_id from lend where request_id is not null)) = 0
              then '❌ 那幾張單一個項目都沒有 —— 拆不出來,要查'
              else '參考 —— 金額加總要跟第 ⑥ 列一樣' end

  union all
  /*
   * ★★★ 拆之前跟拆之後**總額必須一樣**。不一樣就是拆的過程漏了或多了。
   *   這一列先把兩個數字擺出來,拆完再對一次。
   */
  select 6, '⑥ 拆之前／之後的總額',
         '現在的代墊合計 $' || coalesce((select sum(amt)::text from lend), '0')
         || '　│ 那幾張單的項目合計 $'
         || coalesce((select sum(i.amount)::bigint::text from public.purchase_request_items i
                       where i.request_id in (select request_id from lend where request_id is not null)), '0'),
         case when not exists (select 1 from lend) then '⚠ 母體是空的,不算數'
              when coalesce((select sum(amt) from lend), 0)
                 = coalesce((select sum(i.amount) from public.purchase_request_items i
                              where i.request_id in (select request_id from lend where request_id is not null)), 0)
              then '✅ 兩邊一樣 —— 拆得開,而且拆完總額不會變'
              else '❌ 兩邊對不上 —— 拆之前要先查清楚差額是什麼,不要硬拆' end

) v(ord, "檢查", "結果", "判定") order by v.ord;
