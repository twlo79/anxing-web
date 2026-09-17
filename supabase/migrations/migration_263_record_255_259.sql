/*
 * migration_263_record_255_259.sql　2026-09-17
 * 把 255～259 補記進 schema_migrations
 *
 * 【怎麼跑】整份貼進 Supabase SQL Editor，看最後那張自檢表。
 *          ★ 看不到自檢的表格＝整支回滾了，不是「跑成功但沒輸出」。
 *
 * ══════════════════════════════════════════════════════════
 * 【為什麼】
 *
 * `schema_migrations` 裡從 **255 到 259 全部不在**。
 * 原因不是它們沒跑 —— 是那五個檔案**一支都沒有呼叫 `record_migration()`**
 * （2026-09-17 grep 過，六個檔案全是 0）。
 *
 * `查-255到259跑了沒.sql` 已經用**它們做出來的東西**證明五支都跑過了：
 *
 *   255　properties.show_in_room_calendar 欄位在
 *   256　sync_order_earnest() 函式在
 *   257　orders_earnest_dates_chk 約束在
 *   258　social 那三張表都在,六條 policy 也在
 *   259　can_edit_social() 函式在 ＋ profiles.is_social_editor 欄位在
 *
 * ══════════════════════════════════════════════════════════
 * 【★★★ 每一列的 insert 自己帶著證據】
 *
 * 不是五行 `insert ... values`。每一列都**先問那個痕跡在不在**，
 * 在才記。痕跡不在就不記 —— 而自檢會把它標紅。
 *
 *   ★ 理由:這支的輸入是「我相信它跑過了」。
 *     把那個相信寫成無條件的 insert 的話，
 *     它就變成一張**看起來很完整、而且說謊**的紀錄表 ——
 *     比缺五列更糟，因為缺五列至少看得出來缺。
 *
 *   ★★ 所以這支可以在任何一台資料庫上跑:沒跑過那幾支的資料庫，
 *     它一列都不會記。
 *
 * ══════════════════════════════════════════════════════════
 * 【★★ 為什麼不記 259_social_write_open】
 *
 * 259 有**兩個檔案**：`_social_editor` 與 `_social_write_open`，
 * 而且兩支建的是**同名的那幾條 policy** —— 從資料庫這一側分不出來。
 *
 * 唯一分得出來的是 `can_edit_social()`，那是 `_social_editor` 獨有的，
 * 而現在線上的 policy 走的就是它 —— 所以 `_social_write_open`
 * 是**被取代掉的舊版**，沒有跑過（或跑過但已被覆蓋）。
 *
 * ★ 沒有證據的東西不記。那個檔案建議直接刪掉，不然下一輪
 *   又要再問一次「259 到底是哪一支」。
 *
 * ══════════════════════════════════════════════════════════
 * 【這支不動任何資料表】
 *
 * 只往 `schema_migrations` 寫最多五列。沒有 alter、沒有 drop、
 * 沒有碰任何一張業務表。跑兩次結果一樣（`on conflict do nothing`）。
 * ══════════════════════════════════════════════════════════
 */

begin;

/*
 * ★ `insert ... select ... where exists(那個痕跡)` ——
 *   痕跡不在就是 0 列，不是記一筆假的。
 */

-- 255　房源狀態的「不顯示在行事曆」
insert into public.schema_migrations (name)
select '255_room_calendar_hide'
 where exists (select 1 from information_schema.columns
                where table_schema = 'public' and table_name = 'properties'
                  and column_name = 'show_in_room_calendar')
on conflict (name) do nothing;

-- 256　訂金同步
insert into public.schema_migrations (name)
select '256_order_earnest'
 where exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                where n.nspname = 'public' and p.prokind in ('f', 'p')
                  and p.proname = 'sync_order_earnest')
on conflict (name) do nothing;

-- 257　訂金單不帶日期
insert into public.schema_migrations (name)
select '257_earnest_order_no_dates'
 where exists (select 1 from pg_constraint
                where conname = 'orders_earnest_dates_chk')
on conflict (name) do nothing;

-- 258　社群模擬那三張表
insert into public.schema_migrations (name)
select '258_social_ig'
 where (select count(*) from information_schema.tables
         where table_schema = 'public'
           and table_name in ('social_accounts', 'social_posts', 'social_splits')) = 3
on conflict (name) do nothing;

/*
 * 259　小編。
 * ★★ 兩個條件都要成立 —— 只有函式或只有欄位的話，那支是跑到一半停的，
 *   而「跑到一半」不該被記成「跑完了」。
 */
insert into public.schema_migrations (name)
select '259_social_editor'
 where exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                where n.nspname = 'public' and p.prokind in ('f', 'p')
                  and p.proname = 'can_edit_social')
   and exists (select 1 from information_schema.columns
                where table_schema = 'public' and table_name = 'profiles'
                  and column_name = 'is_social_editor')
on conflict (name) do nothing;

do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('263_record_255_259');
  end if;
end $do$;

commit;


-- ══════════════════════════════════════════════════════════
-- 自檢
-- ══════════════════════════════════════════════════════════

with want as (
  select * from (values
    ('255_room_calendar_hide',      'properties.show_in_room_calendar'),
    ('256_order_earnest',           'sync_order_earnest()'),
    ('257_earnest_order_no_dates',  'orders_earnest_dates_chk'),
    ('258_social_ig',               'social 三張表'),
    ('259_social_editor',           'can_edit_social() ＋ is_social_editor')
  ) as t(name, trace)
),
got as (
  select w.name, w.trace,
         exists (select 1 from public.schema_migrations m where m.name = w.name) as ok
  from want w
),
gap as (
  /*
   * ★★★ 200 之後**還缺哪幾號**。
   *   這一列才是這支真正要回答的問題 —— 補完之後還有沒有洞。
   *   只問「那五支記到了嗎」的話，別的地方的洞看不出來。
   */
  select string_agg(g::text, '　' order by g) as miss
  from generate_series(200, 263) g
  where not exists (
    select 1 from public.schema_migrations m
     where split_part(m.name, '_', 1) = g::text)
)

select * from (

  select 1 as ord, '① 五支補記進去了嗎' as "檢查",
         (select string_agg(name || case when ok then ' ✅' else ' ❌' end, '　' order by name)
            from got) as "結果",
         case when (select count(*) from got where ok) = 5 then '✅ 5/5'
              else '❌ 只記到 ' || (select count(*) from got where ok)
                   || ' 支 —— 沒記到的那幾支，它的痕跡在資料庫裡找不到' end as "判定"

  union all
  /*
   * ★★ 這一列證明**證據還在**,不只是「表裡有那一行」。
   *   有人把欄位砍掉而紀錄留著的話,這一列會叫。
   */
  select 2, '② 那五個痕跡現在還在嗎',
         (select string_agg(trace, '　' order by name) from want),
         case when (select count(*) from got where ok) = 5
              then '✅ 五個痕跡都在 —— 紀錄跟實際狀況對得上'
              else '⚠ 有對不上的,看上面那一列' end

  union all
  select 3, '③ 200～263 之間還缺哪幾號',
         coalesce((select miss from gap), '（沒有缺）'),
         case when (select miss from gap) is null
              then '✅ 200 之後一號都沒缺'
              else '⚠ 這幾號不在表裡 —— 可能是沒跑,也可能是跟 255～259 一樣沒記錄自己。'
                   || '照「去看它做出來的東西還在不在」的方法一個一個查' end

  union all
  select 4, '④ 這一支有沒有被記錄',
         coalesce((select max(name) from public.schema_migrations
                    where name = '263_record_255_259'), '（沒記到）'),
         case when exists (select 1 from public.schema_migrations
                            where name = '263_record_255_259')
              then '✅' else '❌ record_migration 沒寫進去' end

) v(ord, "檢查", "結果", "判定") order by v.ord;
