/*
 * migration_268_usage_smart_cut.sql　2026-09-17
 * 修 267：項目名稱不要砍在括號中間
 *
 * 【怎麼跑】整份貼進 Supabase SQL Editor，看最後那張自檢表。
 *          ★ 看不到自檢的表格＝整支回滾了，不是「跑成功但沒輸出」。
 *          ★★ migration_267 要先跑完（你 2026-09-17 跑了）。
 *
 * ══════════════════════════════════════════════════════════
 * 【267 跑出來長這樣】
 *
 *     愛皮 $1329　「115/7月電信費-0975792181(115/6/1-1 等 5 筆」
 *                                              ↑ 砍在這裡
 *
 * 一個沒關的括號 ＋ 半截日期。**看起來像壞掉**，
 * 而使用者看到壞掉的東西不會想「這是截斷」，會想「這系統有問題」。
 *
 * ★★★ 267 的註解裡我自己寫著「截斷之後看到的是半個項目名稱，
 *   比只看到一個完整的還糟」—— 然後只做了一個 `left(…, 30)`。
 *   **講了那句話，卻沒照著做。**
 *
 * ══════════════════════════════════════════════════════════
 * 【改成兩步】
 *
 *   ① 去掉**結尾的一組括號** —— 那裡面是期間，摘要行不需要
 *      `115/7月電信費-0975792181(115/6/1-115/6/30)` → `115/7月電信費-0975792181`
 *      `旅平險(115/7/1-115/12/23)`                  → `旅平險`
 *
 *   ② 還是太長（>24）才截，而且**補一個「…」**
 *      一看就知道是截的,不是壞的。
 *
 * ★ 去括號有守門:去完剩不到 2 個字就不去。
 *   `（暫定）` 那種整個是括號的,去完會變空白 —— 空白比什麼都糟。
 * ★★ 半形全形都認（`(`／`（`）。只認半形的話，中文輸入法打的那種漏掉。
 *
 * ══════════════════════════════════════════════════════════
 * 【★★★ 難的是「哪幾列可以改」】
 *
 * 267 之後，那幾列已經不是 `代墊請款單 %` 了 —— 我把唯一的記號蓋掉了。
 * 所以現在**分不出「系統寫的」跟「人自己打的」**。
 * 照 `category = '代墊'` 全部重寫的話，會蓋掉人手打的字。
 *
 * ★ 解法:只改**現在的值剛好等於 267 那個函式會產生的值**的那幾列。
 *   等於 → 那是 267 寫的，重寫它是安全的。
 *   不等於 → 有人動過，**不要碰**。
 *
 * ★★ 外加還沒被 267 碰過的（還寫著 `代墊請款單 %`）。
 *
 * ★★★ 這是 267 留下的債。要是 267 當初把「這是系統寫的」記在
 *   一個獨立的地方（例如一個 boolean 欄位），這裡就不用玩這種猜謎。
 *   下次再遇到「改寫別人寫的欄位」，記號要另外存。
 *
 * ══════════════════════════════════════════════════════════
 * 【跑兩次結果一樣】第二次跑時，那幾列的值已經等於**新**函式的輸出，
 *   不再等於舊函式的輸出 → where 條件不成立 → 影響 0 列。
 * ══════════════════════════════════════════════════════════
 */

begin;

/*
 * 一個項目名稱 → 摘要行上該顯示的樣子。
 *
 * ★ `immutable`:同樣的輸入永遠同樣的輸出，沒有讀任何資料表。
 *   標成 immutable 才能放進索引或 generated column（現在沒用到，但不要擋住將來）。
 */
create or replace function public.advance_usage_short(p text)
returns text language plpgsql immutable
set search_path = public
as $fn$
declare
  t text;
  s text;
begin
  t := btrim(coalesce(p, ''));
  if t = '' then return null; end if;

  /*
   * ① 去掉結尾那一組括號（半形或全形）。
   * ★ 去完剩不到 2 個字就不去 —— 「（暫定）」那種會被清成空白。
   */
  if t ~ '[（(][^（()）]*[)）]$' then
    s := btrim(regexp_replace(t, '[（(][^（()）]*[)）]$', ''));
    if char_length(s) >= 2 then t := s; end if;
  end if;

  /*
   * ② 還是太長才截，而且補「…」。
   * ★ 不補的話看起來像名字本來就長那樣（267 就是這樣）。
   */
  if char_length(t) > 24 then t := left(t, 24) || '…'; end if;
  return t;
end $fn$;

comment on function public.advance_usage_short(text) is
  '把一個項目名稱收成摘要行能放的長度:先去掉結尾的括號(通常是期間),'
  '還太長才截到 24 字並補「…」。'
  '★ 去括號剩不到 2 字就不去 —— 「（暫定）」那種會被清成空白。';

/* 濃縮整張單。★ 只換掉裡面那個 `left(…, 30)`，其餘照 267。 */
create or replace function public.advance_usage_from_items(p_request uuid)
returns text language sql stable
set search_path = public
as $fn$
  with i as (
    select item_name
      from public.purchase_request_items
     where request_id = p_request
       and coalesce(btrim(item_name), '') <> ''
     order by sort, item_name
  ),
  n as (select count(*) as c from i),
  first1 as (select item_name from i limit 1)
  select case
           when (select c from n) = 0 then null
           when (select c from n) = 1
             then public.advance_usage_short((select item_name from first1))
           else public.advance_usage_short((select item_name from first1))
                || ' 等 ' || (select c from n)::text || ' 筆'
         end
$fn$;

/*
 * ══════════════════════════════════════════════════════════
 * 回填
 * ══════════════════════════════════════════════════════════
 *
 * ★★★ `v1` 是 **267 那個函式的算式**，原樣抄在這裡。
 *   拿它跟現在的值比 —— 一樣就是 267 寫的，改它安全；
 *   不一樣就是有人動過，跳過。
 *
 * ★ 不要把 v1 也做成一支函式留在資料庫裡:那是一個
 *   **只有這一支 migration 用得到、而且永遠不該再被呼叫**的東西。
 *   留著的話下一個人會以為它還在服役。
 */
with v1 as (
  select a.id,
         (with i as (
            select item_name from public.purchase_request_items
             where request_id = a.request_id
               and coalesce(btrim(item_name), '') <> ''
             order by sort, item_name),
           n as (select count(*) as c from i),
           f as (select item_name from i limit 1)
          select case when (select c from n) = 0 then null
                      when (select c from n) = 1 then left((select item_name from f), 30)
                      else left((select item_name from f), 30)
                           || ' 等 ' || (select c from n)::text || ' 筆' end) as old_out
    from public.advance_payments a
   where a.category = '代墊' and a.request_id is not null
)
update public.advance_payments a
   set usage = public.advance_usage_from_items(a.request_id)
  from v1
 where v1.id = a.id
   and (a.usage = v1.old_out or coalesce(a.usage, '') like '代墊請款單 %')
   and coalesce(btrim(public.advance_usage_from_items(a.request_id)), '') <> '';

do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('268_usage_smart_cut');
  end if;
end $do$;

commit;


-- ══════════════════════════════════════════════════════════
-- 自檢
-- ══════════════════════════════════════════════════════════

with lend as (
  select a.id, a.usage, a.amount::int as amt, a.counterparty, r.req_no,
         (select count(*) from public.purchase_request_items i
           where i.request_id = a.request_id) as items
    from public.advance_payments a
    left join public.purchase_requests r on r.id = a.request_id
   where a.category = '代墊'
),
/* ★★ 括號有沒有被砍斷:開括號的數量 <> 關括號的數量 */
broken as (
  select count(*) as n from lend
   where (length(usage) - length(replace(replace(usage, '(', ''), '（', '')))
      <> (length(usage) - length(replace(replace(usage, ')', ''), '）', '')))
),
gap as (
  select string_agg(g::text, '　' order by g) as miss
    from generate_series(200, 268) g
   where not exists (select 1 from public.schema_migrations m
                      where split_part(m.name, '_', 1) = g::text)
)

select * from (

  select 1 as ord, '① 母體：代墊暫付' as "檢查",
         (select count(*)::text from lend) || ' 列' as "結果",
         case when (select count(*) from lend) = 0
              then '⚠ **一列都沒有 —— 下面全部不算數**'
              else '參考 —— 第 ②③ 列在判它' end as "判定"

  union all
  /*
   * ★★★ 這一列是這支的目的:括號不准被砍成單邊。
   *   數開括號與關括號的數量,不一樣就是砍斷了。
   */
  select 2, '② 有沒有砍斷的括號',
         (select n from broken)::text || ' 列',
         case when (select count(*) from lend) = 0 then '⚠ 母體是空的,不算數'
              when (select n from broken) > 0
              then '❌ 還有 ' || (select n from broken)
                   || ' 列的括號是單邊的 —— 那看起來像壞掉,不像截斷'
              else '✅ 沒有單邊括號' end

  union all
  /*
   * ★★★ 光看「沒有壞括號」不夠 —— 全部變空白也會通過那一條。
   *   這一列把實際的字印出來。
   */
  select 3, '③ 現在長什麼樣',
         coalesce((select string_agg(
                     coalesce(counterparty, '?') || ' $' || amt || '　「'
                     || coalesce(usage, '（空白）') || '」',
                     E'\n' order by amt desc) from lend), '（沒有）'),
         case when (select count(*) from lend) = 0 then '⚠ 母體是空的,不算數'
              when exists (select 1 from lend where coalesce(btrim(usage), '') = '')
              then '❌ 有空白的 —— 那一欄空著比什麼都糟'
              when exists (select 1 from lend where coalesce(usage, '') like '代墊請款單 %')
              then '⚠ 還有寫著單號的 —— 它們撈不到項目,刻意留著原字'
              else '✅ 每一列都是項目名稱' end

  union all
  /*
   * ★★ 截斷的那幾列要**看得出是截斷**（結尾有「…」），
   *   不是看起來名字本來就長那樣。
   */
  select 4, '④ 有被截斷的嗎，看得出來嗎',
         (select count(*) filter (where usage like '%…%') from lend)::text || ' 列有「…」　│ 最長 '
         || coalesce((select max(char_length(usage))::text from lend), '0') || ' 個字',
         case when (select count(*) from lend) = 0 then '⚠ 母體是空的,不算數'
              when (select count(*) filter (where usage like '%…%') from lend) = 0
              then '✅ 一列都沒被截 —— 名字都放得下'
              else '✅ 截到的那幾列結尾都有「…」,看得出來是截的' end

  union all
  select 5, '⑤ 「等 N 筆」跟項目筆數對得起來嗎',
         coalesce((select string_agg(
                     coalesce(req_no, '?') || '：' || items || ' 項　'
                     || case when usage like '%等 % 筆' then '有寫' else '沒寫' end,
                     E'\n' order by req_no) from lend), '（沒有）'),
         case when (select count(*) from lend) = 0 then '⚠ 母體是空的,不算數'
              when exists (select 1 from lend
                            where items > 1 and coalesce(usage, '') not like '%等 % 筆'
                              and coalesce(usage, '') not like '代墊請款單 %')
              then '❌ 有多項卻沒寫「等 N 筆」的 —— 看起來只有一項,金額會對不上'
              when exists (select 1 from lend
                            where items = 1 and coalesce(usage, '') like '%等 % 筆')
              then '❌ 只有一項卻寫了「等 N 筆」'
              else '✅ 對得起來' end

  union all
  /*
   * ★★★ 下一張新的代墊會不會也用新的截法。
   *   只問「觸發器在不在」不夠 —— 它呼叫的函式換掉了,要確認換成功。
   */
  select 6, '⑥ 下一張新的代墊會用新的截法嗎',
         case when to_regprocedure('public.advance_usage_short(text)') is null
              then '★ advance_usage_short 不存在'
              else '短名函式 ✅　'
                   || case when exists (
                        select 1 from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
                         where ns.nspname = 'public' and p.proname = 'advance_usage_from_items'
                           and p.prokind in ('f','p')      -- ★ 聚合函式會炸（README 2026-09-01）
                           and pg_get_functiondef(p.oid) like '%advance_usage_short%')
                        then '濃縮函式有接上 ✅' else '濃縮函式**沒有**呼叫它 ❌' end
                   || '　'
                   || case when exists (select 1 from pg_trigger t
                             where t.tgrelid = 'public.advance_payments'::regclass
                               and t.tgname = 'trg_ap_usage_from_items' and not t.tgisinternal)
                        then '觸發器 ✅' else '觸發器 ❌' end
         end,
         case when to_regprocedure('public.advance_usage_short(text)') is null
              then '❌ 新函式不見了'
              when not exists (
                select 1 from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
                 where ns.nspname = 'public' and p.proname = 'advance_usage_from_items'
                   and p.prokind in ('f','p')
                   and pg_get_functiondef(p.oid) like '%advance_usage_short%')
              then '❌ 濃縮函式還是舊的 —— 這次回填對了,但**下一張新的又會砍在括號中間**'
              when not exists (select 1 from pg_trigger t
                                where t.tgrelid = 'public.advance_payments'::regclass
                                  and t.tgname = 'trg_ap_usage_from_items' and not t.tgisinternal)
              then '❌ 觸發器不見了 —— 下一張新的會留著單號'
              else '✅ 三樣都在' end

  union all
  select 7, '⑦ 200～268 之間還缺哪幾號',
         coalesce((select miss from gap), '（沒有缺）'),
         case when (select miss from gap) is null then '✅ 一號都沒缺'
              else '⚠ 還缺：' || (select miss from gap) end

  union all
  select 8, '⑧ 這一支有沒有被記錄',
         coalesce((select max(name) from public.schema_migrations
                    where name = '268_usage_smart_cut'), '（沒記到）'),
         case when exists (select 1 from public.schema_migrations
                            where name = '268_usage_smart_cut')
              then '✅' else '❌ record_migration 沒寫進去' end

) v(ord, "檢查", "結果", "判定") order by v.ord;
