-- ============================================================
-- migration_211：補回 hk_day.rooms_override（而且改成小數）
--
-- 【症狀】
-- 排班表上「間數」欄打的數字**存不進去**。改完看起來有變，
-- 重新整理就跳回自動值。
--
-- 【原因】
-- `hk_day` 線上只有六欄，沒有 `rooms_override`
-- （2026-09-03 用 information_schema 查證）:
--   period / work_date / staff_id / status / hours / note
--
-- ★★★ `archive/migrations-30-99/migration_60_hk_manual_count.sql`
--   寫著要加這一欄，但**線上沒有** —— 那支沒跑成功，或跑在別的資料庫。
--   而 `schema-baseline.sql` 第 495 行照樣寫著它存在。
--   這是 baseline 第二次跟線上不符（第一次是 09-02 的 RLS policy）。
--
-- ★★ 前端完全沒發現，因為兩邊都是靜默的:
--     讀:`select('*')` → 欄位不存在只是 undefined，不報錯
--     寫:`upsert()` 的回傳值**沒有被檢查**（stats-tab 的 setDay）
--   使用者看到的是「我明明改過，怎麼又變回去了」。
--   前端的錯誤檢查在同一輪補上。
--
-- 【★ 型別是 numeric 不是 int】
-- migration_60 寫的是 `int`。但合掃是各 0.5，畫面上的輸入框
-- 也是 `step="0.5"` —— int 會把 0.5 截成 0，
-- 症狀是「打了 0.5，存完變成空的」，比存不進去更難查。
--
-- 【怎麼跑】整份貼進 Supabase SQL Editor，看最後那張表。
-- ============================================================

begin;

alter table public.hk_day
  add column if not exists rooms_override numeric(6,2);

comment on column public.hk_day.rooms_override is
  '手動覆寫這一天這個人的打掃間數。null = 用房源格自動算的。'
  '★ 小數:合掃各 0.5（migration_211 從 migration_60 的 int 改過來，'
  '而 migration_60 其實沒在線上生效）。';

-- ★ 不能是負數。打掃了負幾間不是任何人想表達的事
do $do$ begin
  alter table public.hk_day
    add constraint hk_day_rooms_override_chk
    check (rooms_override is null or rooms_override >= 0);
exception when duplicate_object then null; end $do$;

do $$
begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('211_hk_day_rooms_override');
  end if;
end $$;

commit;

-- ============================================================
-- 自檢
-- ★ 這一支加的是**欄位**，母體是「有沒有這一欄」不是「有幾列」——
--   所以第 1 列問的是欄位在不在，那才是這支的成敗
--   （09-03 才踩過「母體是空的每一條都回綠」）。
-- ============================================================
select '1. rooms_override 這一欄在不在' as 檢查,
       coalesce(
         (select data_type || '(' || coalesce(numeric_precision::text,'') || ','
                 || coalesce(numeric_scale::text,'') || ')'
            from information_schema.columns
           where table_schema = 'public' and table_name = 'hk_day'
             and column_name = 'rooms_override'),
         '（不存在）') as 結果,
       case when exists (
              select 1 from information_schema.columns
               where table_schema = 'public' and table_name = 'hk_day'
                 and column_name = 'rooms_override')
            then '✅ 加好了'
            else '❌ 沒加成功，下面兩列不用看' end as 判定

union all
-- ★★ 型別要收得下 0.5。int 的話畫面上打 0.5 會被截成 0，
--   而那比「存不進去」更難查 —— 因為它「存進去了」
select '2. 型別收得下小數嗎',
       coalesce((select numeric_scale::text
                   from information_schema.columns
                  where table_schema = 'public' and table_name = 'hk_day'
                    and column_name = 'rooms_override'), '—'),
       case when (select numeric_scale
                    from information_schema.columns
                   where table_schema = 'public' and table_name = 'hk_day'
                     and column_name = 'rooms_override') >= 1
            then '✅ 小數位 ≥ 1，0.5 存得住'
            else '❌ 還是整數，0.5 會被截成 0' end

union all
select '3. 目前有幾列被手動覆寫過',
       (select count(*)::text from public.hk_day where rooms_override is not null),
       '剛加的欄位，預期是 0。之後在排班表改間數才會有值'

union all
select '4. 這一支有沒有被記錄',
       coalesce((select max(name) from public.schema_migrations
                  where name = '211_hk_day_rooms_override'), '（沒記到）'),
       case when exists (select 1 from public.schema_migrations
                          where name = '211_hk_day_rooms_override')
            then '✅' else '❌ record_migration 沒寫進去' end;
