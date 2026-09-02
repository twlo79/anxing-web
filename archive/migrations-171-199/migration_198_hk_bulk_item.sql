/*
 * migration_198 —— 一筆工作項目可以代表好幾間
 * ============================================================
 * 2026-09-01 使用者：「像這個是一次 多間 / 可以 key 房源我自己打 + 間數 | 打掃點數」
 *
 * 行事曆上「正隆」「時兆三四樓洗衣機間和公區窗戶」這種標題，
 * 一筆其實是那天在那個物業做的**好幾間**。現在的模型是「一列 = 一間」，
 * 所以補的時候不是打一列就好 —— 而使用者也未必知道是哪幾間房號。
 *
 * ============================================================
 * 【★★ 為什麼是 override 而不是「間數」欄位】
 *
 * 兩個欄位都**允許 null**，而 null 有明確的意思:「照原本的算法」。
 *
 *   units_override  = null → 這一列算 1 間（合掃再除人數）
 *   units_override  = 4    → 這一列算 4 間（合掃再除人數）
 *   points_override = null → 點數 = 間數 × 房源的 clean_points
 *   points_override = 3.5  → 點數就是 3.5，不查房源
 *
 * ★★★ 用 `0` 當「沒填」是不行的:「這一筆不算間數」是一個
 *   合理的輸入（例如只想記點數），而它跟「沒填」的行為完全不同。
 *   兩者用同一個值表示的話，之後每一處都要多想一次。
 *
 * ★ 既有的 1,000 多列一律是 null —— 行為一個字都不變。
 *   這是「加一個選配的例外通道」，不是改規則。
 *
 * ============================================================
 * 【點數為什麼也要能手填】
 *
 * 點數本來是「房源的 clean_points」。但「時兆三四樓洗衣機間和公區窗戶」
 * 這種工作**沒有對應的房源**，查不到點數 —— 那正是卡片上
 * 「⚠ N 筆未計」的來源。給一個手填的通道，那筆工作才算得進報酬。
 *
 * ★ 手填的點數是**這一列的總點數**，跟間數一樣會再除以合掃人數。
 *   不然兩個人一起做，點數會變兩倍。
 */

alter table public.hk_work_item
  add column if not exists units_override  numeric(6,2),
  add column if not exists points_override numeric(8,2);

comment on column public.hk_work_item.units_override is
  '這一列算幾間（migration_198）。null = 照原本算 1 間。'
  '★ 給「一筆等於好幾間」的工作用（行事曆標題只寫「正隆」那種）。'
  '★★ 合掃時**還是會除以人數** —— 4 間兩個人做，各算 2 間。';

comment on column public.hk_work_item.points_override is
  '這一列的打掃點數（migration_198）。null = 照房源的 clean_points 算。'
  '★ 給查不到房源、因此算不出點數的工作用 —— 那些原本會落進「⚠ N 筆未計」。'
  '★★ 跟間數一樣會除以合掃人數。';

do $$ begin
  begin
    alter table public.hk_work_item
      add constraint hkwi_override_nonneg_chk
      check ((units_override  is null or units_override  >= 0)
         and (points_override is null or points_override >= 0));
  exception when duplicate_object then null; end;
end $$;


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('198_hk_bulk_item');
  end if;
end $$;


-- ══════════════════════════════════════════════════════════
-- 自檢。
-- ★ 基準值不依賴這支改的東西:第 2 列數的是「有值的筆數」，
--   而這支一筆都不填，正確答案永遠是 0（migration_187／191 踩過）。
-- ══════════════════════════════════════════════════════════
select v."檢查項目", v."結果", v."說明" from (

  select 1, '① 兩個欄位都建好了',
         (select case when count(*) = 2 then '✅ units_override ／ points_override'
                      else '⚠ 只有 ' || count(*) || ' 個' end
            from information_schema.columns
           where table_schema = 'public' and table_name = 'hk_work_item'
             and column_name in ('units_override', 'points_override')),
         '兩個都要有'

  union all
  select 2, '★★ ② 既有資料一列都沒被填值',
         (select case when count(*) filter (where units_override is not null
                                              or points_override is not null) = 0
                      then '✅ ' || count(*) || ' 列全部是 null（行為完全不變）'
                      else '⚠ 有 ' || count(*) filter (where units_override is not null
                                                         or points_override is not null)
                           || ' 列已經有值 —— 這支不該填任何值' end
            from public.hk_work_item),
         '★ null = 照原本算。既有的 1,000 多列行為一個字都不該變'

  union all
  select 3, '③ 約束會擋負數',
         (select case when count(*) = 1 then '✅ hkwi_override_nonneg_chk 在'
                      else '⚠ 沒有' end
            from pg_constraint
           where conrelid = 'public.hk_work_item'::regclass
             and conname = 'hkwi_override_nonneg_chk'),
         '★ 負的間數會讓某人的月合計變少，而畫面上看不出是哪一筆造成的'

  union all
  select 4, '④ 資料筆數沒變',
         (select count(*)::text || ' 列（202608：'
                 || (select count(*) from public.hk_work_item where period = '202608')::text || '）'
            from public.hk_work_item),
         '這支只加兩個欄位，不新增也不刪除'

) v(ord, "檢查項目", "結果", "說明") order by v.ord;
