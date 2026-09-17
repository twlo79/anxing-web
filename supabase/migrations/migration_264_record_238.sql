/*
 * migration_264_record_238.sql　2026-09-17
 * 把 238 補記進 schema_migrations —— 200 之後最後一個洞
 *
 * 【怎麼跑】整份貼進 Supabase SQL Editor，看最後那張自檢表。
 *          ★ 看不到自檢的表格＝整支回滾了，不是「跑成功但沒輸出」。
 *
 * ══════════════════════════════════════════════════════════
 * 【為什麼】
 *
 * 263 跑完之後，200～263 之間只剩 **238** 不在表裡。
 * 原因跟 255～259 一樣：`migration_238_platform_costco.sql`
 * **沒有呼叫 `record_migration()`**。
 *
 * 238 做的事只有一行：把 `purchase_demand_items.platform` 裡的
 * 「好事多」改成「好市多」（2026-09-10 使用者:「改成 好市多 幫我換字」）。
 *
 * ══════════════════════════════════════════════════════════
 * 【★★★ 這一支的痕跡不是欄位，是 COMMENT】
 *
 * 238 沒有建表、沒有加欄位、沒有加約束 —— 它只改了資料。
 * 所以「它跑過了嗎」不能問 schema。
 *
 * 但它**順手重寫了那一欄的 COMMENT**，而且那段文字裡寫著自己的編號
 * （「改選項時要一起改舊值（migration_238 就是這麼來的）」）。
 * 222 設的是另一段，不含這句 —— 所以這段註解就是 238 的簽名。
 *
 * ★★ **不要只用資料判斷**。「還有沒有『好事多』」答案是 0 的話，
 *   可能是 238 清乾淨了，**也可能是根本沒有人選過好事多**。
 *   母體是空的時候，每一條檢查都會自動成立
 *   （2026-09-03 踩過 migration_210 那次，六個綠勾而母體是 0）。
 *   所以資料只當**佐證**，判定走 COMMENT。
 *
 * ══════════════════════════════════════════════════════════
 * 【為什麼值得補這一號】
 *
 * 補完之後，「200 之後還缺哪幾號」這個檢查才會變成一個**真的警報**。
 * 現在它永遠是⚠，而一個永遠亮著的燈沒有人會看 ——
 * 那正是 README 那條「誤報會把真警報淹掉」。
 *
 * ★ 這支不動任何資料。只往 `schema_migrations` 寫最多一列。
 *   跑兩次結果一樣。
 * ══════════════════════════════════════════════════════════
 */

begin;

insert into public.schema_migrations (name)
select '238_platform_costco'
 where coalesce(
         col_description('public.purchase_demand_items'::regclass,
           (select a.attnum from pg_attribute a
             where a.attrelid = 'public.purchase_demand_items'::regclass
               and a.attname = 'platform')),
         '') ~ '\mmigration_238\M'
on conflict (name) do nothing;

do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('264_record_238');
  end if;
end $do$;

commit;


-- ══════════════════════════════════════════════════════════
-- 自檢
-- ══════════════════════════════════════════════════════════

with cm as (
  select coalesce(
    col_description('public.purchase_demand_items'::regclass,
      (select a.attnum from pg_attribute a
        where a.attrelid = 'public.purchase_demand_items'::regclass
          and a.attname = 'platform')), '') as body
),
dat as (
  select
    count(*) filter (where platform = '好事多') as old_,
    count(*) filter (where platform = '好市多') as new_,
    count(*) as n
  from public.purchase_demand_items
),
gap as (
  select string_agg(g::text, '　' order by g) as miss
  from generate_series(200, 264) g
  where not exists (
    select 1 from public.schema_migrations m
     where split_part(m.name, '_', 1) = g::text)
)

select * from (

  select 1 as ord, '① 238 的簽名（那一欄的 COMMENT）' as "檢查",
         case when (select body from cm) ~ '\mmigration_238\M'
              then '註解裡有提到 migration_238' else '★ 沒提到' end as "結果",
         case when (select body from cm) ~ '\mmigration_238\M'
              then '✅ 238 跑過了' else '❌ 沒跑 —— 舊的「好事多」還在，下拉會顯示空白' end as "判定"

  union all
  select 2, '② 238 補記進去了嗎',
         case when exists (select 1 from public.schema_migrations
                            where name = '238_platform_costco')
              then '在表裡了' else '★ 沒記到' end,
         case when exists (select 1 from public.schema_migrations
                            where name = '238_platform_costco')
              then '✅'
              else '❌ 沒記到 —— 上面第 ① 列是紅的話這是對的（沒證據就不記）' end

  union all
  /*
   * ★★ 資料只是**佐證**,不拿它當判定 —— 母體可能本來就是空的。
   *   所以這一列先講母體有幾筆。
   */
  select 3, '③ 佐證：那一欄的資料',
         '好事多 ' || (select old_ from dat) || ' 筆　好市多 ' || (select new_ from dat)
         || ' 筆　│ 母體 ' || (select n from dat) || ' 筆',
         case when (select n from dat) = 0
              then '⚠ 一筆採購項目都沒有 —— 這一列證明不了任何事，看第 ① 列'
              when (select old_ from dat) > 0
              then '❌ 還有 ' || (select old_ from dat)
                   || ' 筆是「好事多」—— 那幾筆的下拉會顯示空白'
              when (select new_ from dat) = 0
              then '⚠ 好市多也是 0 —— 可能本來就沒人選過這個平台,證明不了什麼'
              else '✅ 舊值清乾淨了' end

  union all
  /*
   * ★★★ 這一列是整件事的收尾。
   *   補完之後這裡該是「沒有缺」—— 而從今以後它變成一個**真的警報**:
   *   哪天又有人寫了不記錄自己的 migration，這一格就會亮。
   */
  select 4, '④ 200～264 之間還缺哪幾號',
         coalesce((select miss from gap), '（沒有缺）'),
         case when (select miss from gap) is null
              then '✅ 一號都沒缺 —— 從現在起這一格亮了就是真的有事'
              else '⚠ 還缺:' || (select miss from gap)
                   || '　照「去看它做出來的東西還在不在」一個一個查' end

  union all
  select 5, '⑤ 這一支有沒有被記錄',
         coalesce((select max(name) from public.schema_migrations
                    where name = '264_record_238'), '（沒記到）'),
         case when exists (select 1 from public.schema_migrations
                            where name = '264_record_238')
              then '✅' else '❌ record_migration 沒寫進去' end

) v(ord, "檢查", "結果", "判定") order by v.ord;
