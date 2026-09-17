/*
 * 查-255到259跑了沒.sql　2026-09-17
 *
 * 【為什麼查這個】
 * `schema_migrations` 裡從 **255 到 259 全部不在**（2026-09-17 查到）。
 * 而那五支的檔案裡**一支都沒有呼叫 `record_migration()`** ——
 * 所以「不在表裡」講的是「它們不會記錄自己」，
 * 不是「它們沒跑」。
 *
 * ══════════════════════════════════════════════════════════
 * 【★★★ 所以不要問那張表，去看它們**做出來的東西**還在不在】
 *
 * 每一支 migration 都留下一個看得見的痕跡：一支函式、一個欄位、
 * 一條約束、一張表。那個痕跡在，它就跑過了 —— 這是**證據**，
 * 不是我的印象，也不是對話紀錄。
 *
 * ★ 這條規矩是 2026-09-05 那次加的:我連續三次說「213／215／216 未跑」，
 *   而三支都在 09-03 跑完了。事實在資料庫裡，不在摘要裡。
 *
 * ══════════════════════════════════════════════════════════
 * 【★★ 兩支 259 分不出來】
 *
 * `migration_259_social_editor.sql` 與 `migration_259_social_write_open.sql`
 * **同一個號碼**，而且兩支建的是**同名的那幾條 policy**。
 * 所以從資料庫這一側看不出跑的是哪一支 ——
 * 只有 `can_edit_social()` 這支函式是 `_social_editor` 獨有的。
 *
 * ★ 下面第 ⑥ 列就是在問這件事。
 *
 * ★ 這支**只讀不寫**，跑幾次都一樣。
 * ══════════════════════════════════════════════════════════
 *
 * 【怎麼看】每一列的判定就是答案。全部 ✅ 的話，那五支都跑過了，
 *          只是沒記錄自己 —— 那就只剩「要不要補記」這個問題。
 */

with fns as (
  /* ★ prokind 一定要濾 —— 掃到聚合函式會整支炸掉（2026-09-01 踩過） */
  select p.proname::text as name
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prokind in ('f', 'p')
),
cols as (
  /* ★ 一定要帶 table_schema='public'（README） */
  select table_name::text as t, column_name::text as c
  from information_schema.columns where table_schema = 'public'
),
tbls as (
  select table_name::text as t from information_schema.tables
  where table_schema = 'public'
),
cons as (
  select conname::text as name from pg_constraint
),
recorded as (
  select name from public.schema_migrations
)

select * from (

  select 1 as ord, '① 255　properties.show_in_room_calendar' as "檢查",
         case when exists (select 1 from cols
                            where t = 'properties' and c = 'show_in_room_calendar')
              then '欄位在' else '★ 欄位不存在' end as "結果",
         case when exists (select 1 from cols
                            where t = 'properties' and c = 'show_in_room_calendar')
              then '✅ 255 跑過了' else '❌ 255 沒跑 —— 房源狀態的隱藏功能是壞的' end as "判定"

  union all
  select 2, '② 256　sync_order_earnest()',
         case when exists (select 1 from fns where name = 'sync_order_earnest')
              then '函式在' else '★ 函式不存在' end,
         case when exists (select 1 from fns where name = 'sync_order_earnest')
              then '✅ 256 跑過了' else '❌ 256 沒跑 —— 訂金不會同步' end

  union all
  select 3, '③ 257　orders_earnest_dates_chk',
         case when exists (select 1 from cons where name = 'orders_earnest_dates_chk')
              then '約束在' else '★ 約束不存在' end,
         case when exists (select 1 from cons where name = 'orders_earnest_dates_chk')
              then '✅ 257 跑過了' else '❌ 257 沒跑' end

  union all
  select 4, '④ 258　social 那三張表',
         coalesce((select string_agg(t, '　' order by t) from tbls
                    where t in ('social_accounts', 'social_posts', 'social_splits')),
                  '★ 一張都沒有'),
         case when (select count(*) from tbls
                     where t in ('social_accounts', 'social_posts', 'social_splits')) = 3
              then '✅ 258 跑過了' else '❌ 258 沒跑完 —— 社群模擬整頁是壞的' end

  union all
  select 5, '⑤ 258　那三張表上有 policy 嗎',
         (select count(*)::text from pg_policies
           where schemaname = 'public' and tablename like 'social\_%') || ' 條',
         case when (select count(*) from pg_policies
                     where schemaname = 'public' and tablename like 'social\_%') > 0
              then '✅ 有 —— 沒有的話查詢會回成功、0 列而且不報錯'
              else '❌ 一條都沒有 —— 社群模擬會是一片空白，不會有錯誤訊息' end

  union all
  /*
   * ★★ 兩支 259 同號，而且建的是同名的 policy —— 分不出來。
   *   `can_edit_social()` 是 `_social_editor` 那一支獨有的，所以問它。
   */
  select 6, '⑥ 259　can_edit_social()（只有 _social_editor 那支有）',
         case when exists (select 1 from fns where name = 'can_edit_social')
              then '函式在' else '★ 函式不存在' end
         || '　│ profiles.is_social_editor '
         || case when exists (select 1 from cols
                               where t = 'profiles' and c = 'is_social_editor')
                 then '在' else '不在' end,
         case when exists (select 1 from fns where name = 'can_edit_social')
               and exists (select 1 from cols
                            where t = 'profiles' and c = 'is_social_editor')
              then '✅ 259_social_editor 跑過了'
              else '❌ 沒跑完 —— IG 那頁會變成所有人都不能編輯' end

  union all
  /*
   * ★★★ 母體要判定（README:自檢的母體是空的 → 每一條都回綠）。
   *   這一列問的是「那五支到底記錄了幾支」——
   *   答案是 0 的話，上面那五個綠勾講的全部是「它跑過了」，
   *   而不是「它被記錄了」。兩件事不一樣。
   */
  select 7, '⑦ 這五支在 schema_migrations 裡記了幾支',
         (select count(*)::text from recorded
           where split_part(name, '_', 1) in ('255', '256', '257', '258', '259')) || ' / 5',
         case when (select count(*) from recorded
                     where split_part(name, '_', 1)
                           in ('255', '256', '257', '258', '259')) = 0
              then '⚠ 一支都沒記 —— 那五支檔案裡都沒有呼叫 record_migration()。'
                   || '上面的✅是「它跑過了」，不是「它被記錄了」'
              else '✅ 有記到' end

  union all
  select 8, '⑧ 現在表裡最新的五支',
         coalesce((select string_agg(name, '　' order by
                          split_part(name, '_', 1)::int desc)
                     from (select name from recorded
                            where split_part(name, '_', 1) ~ '^\d+$'
                            order by split_part(name, '_', 1)::int desc
                            limit 5) x), '（空的）'),
         '參考 —— 這一列只是給你對照'

) v(ord, "檢查", "結果", "判定") order by v.ord;
