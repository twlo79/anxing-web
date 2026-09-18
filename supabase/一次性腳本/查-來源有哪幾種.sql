/*
 * 查-來源有哪幾種.sql　2026-09-18
 * 營收頁「來源」那個下拉：資料庫裡實際有哪幾種，下拉列得完嗎
 *
 * 【怎麼跑】整份貼進 Supabase SQL Editor。**只有 select，不改任何東西。**
 *
 * ══════════════════════════════════════════════════════════
 * 【使用者 2026-09-18】「其他 和 其他收入 有甚麼不一樣」
 *
 * 【為什麼要查，不是直接回答】
 *
 * 程式碼裡有**兩個同名的常數，值不一樣**:
 *
 *     lib/revenue-report.ts   OTHER_BIZ_SOURCE = 'other'
 *     lib/book.ts             OTHER_BIZ_SOURCE = 'other_biz'
 *
 * 而營收頁的下拉只列了八個值,`other_biz` 不在裡面。
 * 兩邊哪一個是實際存進 `orders.source` 的,**只有資料說得準** ——
 * 我照程式碼推的話，會給出一個聽起來很合理但可能是錯的答案
 * （CLAUDE.md:判定照程式碼寫、沒拿同一列的資料對，2026-09-03 踩過）。
 * ══════════════════════════════════════════════════════════
 */

-- ══════════════════════════════════════════════════════════
-- ① 每一種來源有幾筆，下拉裡選不選得到
-- ══════════════════════════════════════════════════════════
/*
 * ★★ 右邊那一欄是**判定**不是參考值。
 *   「選不到」代表:那幾筆在營收頁的來源下拉裡挑不出來，
 *   而且清單上那一格會直接印出英文（SOURCE_LABEL 沒有那個鍵時
 *   會 fallback 成原值）—— 使用者看到 `other_biz` 不知道那是什麼。
 */
with known(src, label) as (
  /* ★ 這八個就是 revenues/page.tsx 的 SOURCE_ORDER ＋ SOURCE_LABEL */
  values ('airbnb',    'Airbnb'),
         ('agoda',     'Agoda'),
         ('private',   '私下'),
         ('longterm',  '長租'),
         ('office',    '辦公室租金'),
         ('company',   '公司登記'),
         ('oneoff',    '其他收入'),
         ('other',     '其他')
)
select o.source                                        as "來源(資料庫存的值)",
       coalesce(k.label, '❌ 下拉裡沒有這個選項')        as "下拉上的名字",
       count(*)                                        as "筆數",
       to_char(sum(o.amount), 'FM999,999,999')         as "金額",
       min(o.checkin)::text || ' ~ ' || max(o.checkin)::text as "日期範圍",
       case when k.src is null
            then '❌ 選不到，而且來源那一格會直接印出這串英文'
            else '✅ 選得到' end                        as "判定"
  from public.orders o
  left join known k on k.src = o.source
 group by o.source, k.src, k.label
 order by count(*) desc, o.source;


-- ══════════════════════════════════════════════════════════
-- ② 「其他收入」底下是哪些科目
-- ══════════════════════════════════════════════════════════
/*
 * ★ 剛加進下拉的「房務清潔」「人事費」應該出現在這一張表裡。
 *   出現了＝那兩項篩得到東西;沒出現＝篩出來會是空的。
 * ★★ 母體要判定 —— 一筆都沒有的話這張表整張不算數（CLAUDE.md）。
 */
select coalesce(nullif(btrim(o.fee_type), ''), '（沒填科目）') as "科目",
       count(*)                                as "筆數",
       to_char(sum(o.amount), 'FM999,999,999') as "金額",
       case when coalesce(btrim(o.fee_type), '') in ('房務清潔', '人事費')
            then '★ 這一項現在在來源下拉裡選得到'
            else '' end                        as "備註"
  from public.orders o
 where o.source = 'oneoff'
 group by 1, o.fee_type
 order by count(*) desc, 1;


-- ══════════════════════════════════════════════════════════
-- ③ 「其他」與「其他事業體」到底是不是同一批
-- ══════════════════════════════════════════════════════════
/*
 * ★★★ 這一列回答的就是使用者問的那句話。
 *   `book` 是帳本（anxing / aipi / hongsha）——
 *   如果 source='other' 的那幾筆 book 都是愛皮／洪鯊，
 *   那「其他」就是「其他事業體」的意思;
 *   如果一筆都沒有而 `other_biz` 有一堆，那下拉那一項是**對不到東西的**。
 */
select case when o.source = 'oneoff' then '其他收入 (oneoff)'
            when o.source = 'other'  then '其他 (other)'
            else '其他事業體 (' || o.source || ')' end as "哪一種",
       coalesce(o.book, '（沒填）')                     as "帳本",
       count(*)                                        as "筆數",
       to_char(sum(o.amount), 'FM999,999,999')         as "金額"
  from public.orders o
 where o.source in ('oneoff', 'other', 'other_biz')
 group by 1, o.book
 order by 1, count(*) desc;
