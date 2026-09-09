/*
 * migration_234 —— 把「安幸辦公室」那個物業與房源停用
 * ============================================================
 * 2026-09-09 使用者:「安幸辦公室 有兩個 合成一個」。
 *
 * ============================================================
 * 【★★★ 為什麼會有兩個 —— 這是 migration_228 造成的】
 *
 * 「安幸辦公室」在這個系統裡本來就存在，但它**不是物業** ——
 * 它是 `purpose_type = 'office'`，跟 `'estate'` 並列的另一類
 * （migration_212）。用途下拉最上面那一個就是它。
 *
 * 而我在 migration_228 建了一個**名叫「安幸辦公室」的 estates 列**,
 * 理由是房務收入的訂單一定要掛在某個物業上（`orders` 沒有 purpose_type）。
 *
 * 於是每一個列出物業的下拉都會出現兩個同名的:
 *
 *     用途 ▾
 *       安幸辦公室      ← purpose_type='office'（真的那個）
 *       正隆 / 時兆 / …
 *       安幸辦公室      ← 我建的假物業
 *
 * ★★ 而且不只是難看:選到下面那個，那筆支出會被歸到
 *   `purpose_type='estate'`，跟選上面那個歸到不同的地方 ——
 *   兩邊在畫面上都顯示「安幸辦公室」。
 *
 * ============================================================
 * 【★★★ 為什麼是「停用」不是「刪掉」】
 *
 * 現在有東西指著它:房務產生的收入訂單（`orders.estate_id`）、
 * 劉姐的工資支出（`expenses.estate_id`）。刪掉會變成孤兒。
 *
 * ★ 停用只是從下拉裡消失。既有資料照舊指得到，名字也查得到。
 *
 * ============================================================
 * 【★★ 為什麼不在前端過濾掉】
 *
 * `from('estates')` 散在 **23 個檔案**。在每一個地方加一行過濾
 * 就是「同一條規則寫 23 次」—— `CLAUDE.md` 那張坑表的第一條，
 * 而漏掉其中一個不會報錯，只會有某一頁還是出現兩個。
 *
 * 多數下拉本來就篩 `.eq('active', true)`，所以停用是**一個地方改、
 * 23 個地方一起生效**。
 *
 * ============================================================
 * 【停用之後不會壞的那兩件事（已經確認過）】
 *
 *   · `purchases/page.tsx:364` 的物業下拉有篩 active → 重複消失 ✅
 *   · `stats-tab.tsx:484` 的 properties 查詢**沒有**篩 active
 *     → 房務按「產生收支」還是找得到安幸辦公室，收入寫得進去 ✅
 *
 * ★★★ 第二條是這支能不能跑的關鍵。properties 那支查詢哪天被加上
 *   `.eq('active', true)`，房務收入就會全部寫不進去而且只有一行錯誤訊息。
 *   自檢第 ③ 條把這件事寫成一個檢查。
 *
 * 【怎麼跑】整份貼進 Supabase SQL Editor，看最後那張自檢表。
 */

begin;

update public.properties p
   set active = false
  from public.estates e
 where p.estate_id = e.id
   and e.name = '安幸辦公室'
   and p.name = '安幸辦公室';

update public.estates
   set active = false
 where name = '安幸辦公室';

do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('234_office_estate_hidden');
  end if;
end $do$;

commit;


-- ══════════════════════════════════════════════════════════
-- 自檢　★ 字串比對一律 ilike —— like 區分大小寫，2026-09-09 踩過
-- ══════════════════════════════════════════════════════════
select v.ord, v."檢查", v."結果", v."判定" from (

  select 1, '①★★★ 那個物業與房源都停用了',
         coalesce((select string_agg(x, '　') from (
                    select '物業:' || e.name || '=' || e.active::text as x
                      from public.estates e where e.name = '安幸辦公室'
                    union all
                    select '房源:' || p.name || '=' || p.active::text
                      from public.properties p where p.name = '安幸辦公室') t), '（找不到）'),
         case when (select count(*) from public.estates
                     where name = '安幸辦公室' and not active) = 1
               and (select count(*) from public.properties
                     where name = '安幸辦公室' and not active) >= 1
              then '✅ 兩個都停用了' else '❌ 還有一個是啟用的' end

  union all
  select 2, '②★★★ 用途下拉裡不再有第二個「安幸辦公室」',
         coalesce((select string_agg(name, '、' order by sort, name)
                     from public.estates where active), '（沒有啟用的物業）'),
         case when (select count(*) from public.estates
                     where active and name = '安幸辦公室') = 0
              then '✅ 啟用的物業裡沒有它了'
              else '❌ 還在 —— 下拉還是會出現兩個' end

  union all
  /*
   * ★★★ 這一條釘的是「停用之後房務還產生得出收入」。
   *   `stats-tab` 是靠 properties 那張表找安幸辦公室的,
   *   而那支查詢**沒有**篩 active —— 所以停用不影響。
   *   哪天有人幫它加上 `.eq('active', true)`，房務收入會全部寫不進去。
   */
  select 3, '③★★★ 房務還找得到安幸辦公室（房源那一列還在，只是停用）',
         coalesce((select p.name || '（active=' || p.active::text || '）→ 物業 '
                          || coalesce(e.name, '（無）')
                     from public.properties p
                     left join public.estates e on e.id = p.estate_id
                    where p.name = '安幸辦公室' limit 1), '（找不到）'),
         case when exists (select 1 from public.properties where name = '安幸辦公室')
              then '✅ 列還在 —— stats-tab 的查詢沒篩 active，找得到'
              else '❌ 房源不見了 —— 房務收入會寫不進去' end

  union all
  select 4, '④ 現在有多少東西指著它（所以不能刪只能停用）',
         (select '收入訂單 ' || (select count(*) from public.orders o
                                  join public.estates e on e.id = o.estate_id
                                 where e.name = '安幸辦公室')::text || ' 筆　'
                 || '支出 ' || (select count(*) from public.expenses x
                                 join public.estates e on e.id = x.estate_id
                                where e.name = '安幸辦公室')::text || ' 筆'),
         '👀 這些照舊指得到，名字也查得到 —— 停用只是從下拉消失'

  union all
  select 5, '⑤ 這一支有沒有被記錄',
         coalesce((select max(name) from public.schema_migrations
                    where name = '234_office_estate_hidden'), '（沒記到）'),
         case when exists (select 1 from public.schema_migrations
                            where name = '234_office_estate_hidden')
              then '✅' else '❌ record_migration 沒寫進去' end

) v(ord, "檢查", "結果", "判定") order by v.ord;
