/* ══════════════════════════════════════════════════════════════════════
 * migration_289  「上層」只留一支欄位                        2026-09-22
 *
 * ★★★ 這支在修 **migration_287 自己造出來的問題**。
 *
 * `properties` 上有**兩支在講同一件事**的欄位：
 *
 *   parent_property_id  本來就有。**畫面上那個「上層」下拉寫的是它**
 *                       （房源設定頁），訂單頁、營收表也都讀它
 *   parent_id           migration_287（2026-09-21）加的。
 *                       **只有住房率在讀**（occupancy.ts、財務儀表板）
 *
 * 於是:使用者在畫面上設「上層」→ 寫進舊欄位 → **住房率看不到**。
 * 287 那一輪只把開封／JPR／信陽那幾間寫進新欄位，之後每一次
 * 在 UI 上的修改都只進舊欄位，兩邊越差越遠 ——
 * 而畫面正常、數字正常，**沒有任何地方會叫**。
 * （CLAUDE.md:「一份資料存在兩個地方」「一個靜默的讀 ＋ 一個靜默的寫
 *   ＝ 一個不存在的功能」）
 *
 * 修法不是對帳，是**讓寫的人只有一個** —— 留 `parent_property_id`
 * （畫面在寫的那一支），住房率改讀它。
 *
 * ══════════════════════════════════════════════════════════
 * 【這支做什麼】
 *
 *   ① 把 `parent_id` 有值而 `parent_property_id` 是空的那幾列補過去
 *      （2026-09-22 線上查到是 4 列:信陽5／5-1／5-2／5-3 → 信陽整層）
 *   ② 兩邊都有值而且**不一樣**的話 → raise，不要猜哪一個對
 *   ③ 把 `parent_id` 標成 deprecated（COMMENT），**這支不刪它**
 *
 * ★★★ 為什麼不在這支就 drop:線上跑著的前端還在
 *   `select ... parent_id`。先 drop 的話，財務儀表板會在下一次
 *   查詢時整個掛掉。順序必須是:
 *
 *      1. 先推「住房率改讀 parent_property_id」的那版 code
 *      2. 再跑這支（補資料 ＋ 標記）
 *      3. 確認住房率沒變之後，migration_290 才 drop 那一欄
 *
 * ★★ 自檢在 commit 後面 —— **看不到那張表就是整支回滾了**。
 * ══════════════════════════════════════════════════════════════════════ */

begin;

-- ── ② 先擋住「兩邊都有值而且不一樣」──────────────────
do $do$
declare n int;
begin
  select count(*) into n from public.properties
   where parent_property_id is not null
     and parent_id is not null
     and parent_property_id <> parent_id;
  if n > 0 then
    raise exception
      '有 % 列的兩支上層欄位互相矛盾 —— 不要猜哪一個對，先人工看過', n;
  end if;
end $do$;

-- ── ① 補過去 ────────────────────────────────────────
/* ★ 只補「舊的是空的」那幾列。用最終狀態驗（下面自檢），
     不是用影響列數 —— 跑第二次影響 0 列但結果一樣對。 */
update public.properties
   set parent_property_id = parent_id
 where parent_property_id is null
   and parent_id is not null;

-- ── ③ 標記 ──────────────────────────────────────────
comment on column public.properties.parent_id is
  'DEPRECATED（migration_289，2026-09-22）。'
  '「上層」只認 parent_property_id —— 畫面上那個下拉寫的是它。'
  '這一欄是 migration_287 多開的第二支，資料已經合併過去。'
  '等「住房率改讀 parent_property_id」那版 code 上線並確認之後，'
  '由 migration_290 drop 掉。在那之前不要再寫它。';

comment on column public.properties.parent_property_id is
  '上層房源（整棟／整層）。**全站唯一一支**:房源設定頁的「上層」下拉、'
  '訂單頁、營收表、住房率都讀這一支（migration_289 合併）。'
  '葉子才進住房率的分母，父層的佔用往下展開。';

do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('289_merge_parent_col');
  end if;
end $do$;

commit;


-- ══════════════════════════════════════════════════════════
-- 自檢
-- ★★★ 看不到下面這張表 ＝ 整支回滾了，不是「跑成功但沒輸出」。
-- ★★ 每一列問的都是**最終狀態**，跑第二次答案一模一樣。
-- ══════════════════════════════════════════════════════════
select * from (
  select 0 as s, '⓪ ⚠ 母體：房源總數' as 項目,
         (select count(*)::text from public.properties) as 值,
         case when (select count(*) from public.properties) = 0
              then '❌ 一間都沒有 —— 下面不算數' else '✅ 有東西可以檢查' end as 判定

  union all
  select 1, '① 還有沒有「新欄位有值、舊欄位空著」的列（應該 0）',
         (select count(*)::text from public.properties
           where parent_id is not null and parent_property_id is null),
         case when (select count(*) from public.properties
                     where parent_id is not null and parent_property_id is null) = 0
              then '✅ 都補過去了' else '❌ 還有沒補到的' end

  union all
  select 2, '② 兩邊互相矛盾的列（應該 0）',
         (select count(*)::text from public.properties
           where parent_property_id is not null and parent_id is not null
             and parent_property_id <> parent_id),
         case when (select count(*) from public.properties
                     where parent_property_id is not null and parent_id is not null
                       and parent_property_id <> parent_id) = 0
              then '✅' else '❌ 有矛盾 —— 不該 commit 才對' end

  union all
  select 3, '③ 信陽那四間的上層（應該都是「信陽整層」）',
         coalesce((select string_agg(p.name || '→' ||
                    coalesce((select x.name from public.properties x where x.id = p.parent_property_id), '（空）'),
                    '、' order by p.name)
                   from public.properties p where p.name like '信陽5%'), '（沒有這幾間）'),
         case when (select count(*) from public.properties p
                     where p.name like '信陽5%' and p.parent_property_id is null) = 0
              then '✅ 都有上層了' else '❌ 還有空的' end

  union all
  select 4, '④ 有上層的房源一共幾間',
         (select count(*)::text from public.properties where parent_property_id is not null),
         case when (select count(*) from public.properties where parent_property_id is not null) > 0
              then '✅' else '⚠ 一間都沒有 —— 子母房源等於沒設定' end

  union all
  select 5, '⑤ parent_id 標成 deprecated 了嗎',
         case when coalesce(col_description('public.properties'::regclass,
                (select attnum from pg_attribute
                  where attrelid = 'public.properties'::regclass and attname = 'parent_id')
              ), '') like 'DEPRECATED%' then '是' else '沒有' end,
         case when coalesce(col_description('public.properties'::regclass,
                (select attnum from pg_attribute
                  where attrelid = 'public.properties'::regclass and attname = 'parent_id')
              ), '') like 'DEPRECATED%' then '✅' else '❌' end

  union all
  select 6, '⑥ 這支跑過了沒（schema_migrations）',
         coalesce((select name from public.schema_migrations
                    where name = '289_merge_parent_col'), '（沒有紀錄）'),
         case when exists (select 1 from public.schema_migrations
                            where name = '289_merge_parent_col')
              then '✅' else '⚠ 沒記到' end
) x
order by s;
