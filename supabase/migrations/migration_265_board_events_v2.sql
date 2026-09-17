/*
 * migration_265_board_events_v2.sql　2026-09-17
 * 活動改版：上傳開關、代上傳、活動通知
 *
 * 【怎麼跑】整份貼進 Supabase SQL Editor，看最後那張自檢表。
 *          ★ 看不到自檢的表格＝整支回滾了，不是「跑成功但沒輸出」。
 *          ★★ migration_262 要先跑完（你 2026-09-17 跑了）。
 *
 * ══════════════════════════════════════════════════════════
 * 【這支做三件事】
 *
 *   ① board_events.uploads_open   開會要「打開」才收得了檔案
 *   ② board_files.author_id       這份資料是**誰的**（代上傳用）
 *   ③ notification_prefs.board    活動通知的開關
 *
 * ══════════════════════════════════════════════════════════
 * 【★★★ ① 開關不能只擋畫面】
 *
 * 使用者 2026-09-17：「開會上傳資料 是有一個 toggle 打開才能上傳」。
 *
 * 只把按鈕藏起來的話，開關關著照樣傳得進去 —— 而畫面上**看不到**
 * 那些檔案（它不畫關著的那一塊）。東西在 storage 裡佔著位子，
 * 沒有人知道它在。**比不擋更糟。**
 *
 * 所以 `board_files` 的 insert policy 要求：
 *   那一場是 **meeting**、而且 **uploads_open 是 true**。
 * 前端 lib/board.ts 的 `canUpload()` 是同一條規則。
 *
 * ══════════════════════════════════════════════════════════
 * 【★★ ② author_id：誰的內容 ≠ 誰按的上傳】
 *
 * 使用者問：「如果代上傳 會分辨出來是誰的內容嗎」——
 * 原本**不會**。`uploaded_by` 記的是按下上傳那個人。
 * 芊幫唐傳，那份就掛在芊底下，而畫面上看不出有任何不對。
 *
 *   uploaded_by  誰按的上傳   → 出事要查是誰傳錯的
 *   author_id    這是誰的     → 平常要找「唐的人力表」
 *
 * ★ 兩個都留著。只留一個，在另一種情況下就不夠用。
 * ★★ 既有的列 backfill 成 `author_id = uploaded_by` ——
 *   留 null 的話那些檔案會掉進一個沒有名字的分組裡。
 *
 * ══════════════════════════════════════════════════════════
 * 【★★ ③ 活動通知預設「開」】
 *
 * 跟採購需求（migration_140）同一個理由：這是新功能，
 * 沒有「維持現狀」的問題 —— 而收不到的人就不知道有活動，
 * 那正是這個功能要解決的事。
 *
 * ★ `notify-kinds.ts` 的 `NOTIFY_DEFAULT.board` 要跟這裡的 default 一致。
 *   不一致的話，沒有偏好列的人在畫面上看到的開關狀態，
 *   跟實際會不會收到**是兩回事**。
 *
 * ══════════════════════════════════════════════════════════
 * 【跑兩次結果一樣】`if not exists` ＋ `drop policy if exists`。
 * ══════════════════════════════════════════════════════════
 */

begin;

-- ── ① 上傳開關 ──────────────────────────────────────────

alter table public.board_events
  add column if not exists uploads_open boolean not null default false;

comment on column public.board_events.uploads_open is
  '開會才有意義:true 才收得了檔案。'
  '★ 這條規則在 board_files 的 insert policy 裡也有一份，兩邊要一樣。'
  '前端是 lib/board.ts 的 canUpload()。';

/*
 * ★★ all_day 停用（2026-09-17 使用者:「必填 日期 時間」）。
 *   欄位留著不刪 —— 刪欄位的風險比留著大，而它也沒有擋住誰。
 *   但要在這裡講清楚，不然三個月後有人看到會以為還能用。
 */
comment on column public.board_events.all_day is
  '【已停用 2026-09-17】原本是「只有日期沒有時間」的活動。'
  '現在日期與時間都是必填,新的列一律 false。留著只為了舊資料。';

-- ── ② 代上傳 ────────────────────────────────────────────

alter table public.board_files
  add column if not exists author_id uuid references public.profiles(id) on delete set null;

/*
 * ★★★ 既有的列補上 author_id。
 *   留 null 的話那些檔案會掉進一個沒有名字的分組裡 ——
 *   畫面上是一個叫「—」的人，而那個人不存在。
 */
update public.board_files set author_id = uploaded_by where author_id is null;

comment on column public.board_files.author_id is
  '這份資料是**誰的**。代上傳時跟 uploaded_by 不同(芊幫唐傳 → author=唐、uploaded_by=芊)。'
  '★ 畫面照 author_id 分組,uploaded_by 顯示成「芊代傳」的小標。'
  '★★ 兩個都要留:出事要查誰傳的,平常要找誰的。';

/*
 * ★★★ 上傳的 policy 改成三個條件都要成立。
 *
 *   ① 是自己按的上傳（uploaded_by = auth.uid()）
 *   ② 那一場是開會
 *   ③ 那一場的上傳開關是開的
 *
 * ★ author_id **不限制** —— 代傳的重點就是填別人。
 *   限制成 = auth.uid() 的話這個功能整個沒有意義。
 */
drop policy if exists board_files_insert on public.board_files;
create policy board_files_insert on public.board_files
  for insert
  with check (
    auth.uid() is not null
    and uploaded_by = auth.uid()
    and exists (
      select 1 from public.board_events e
       where e.id = event_id
         and e.kind = 'meeting'
         and e.uploads_open
    )
  );

-- ── ③ 活動通知 ──────────────────────────────────────────

alter table public.notification_prefs
  add column if not exists board boolean not null default true;

comment on column public.notification_prefs.board is
  '活動通知(佈告欄的開會／團聚)。預設 true —— 新功能,收不到的人就不知道有活動。'
  '★ 前端 lib/notify-kinds.ts 的 NOTIFY_DEFAULT.board 要跟這個 default 一樣。';

do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('265_board_events_v2');
  end if;
end $do$;

commit;


-- ══════════════════════════════════════════════════════════
-- 自檢
-- ══════════════════════════════════════════════════════════

with cols as (
  /* ★ 一定要帶 table_schema='public'（README） */
  select table_name::text as t, column_name::text as c,
         data_type::text as ty, is_nullable::text as nul,
         coalesce(column_default, '')::text as def
  from information_schema.columns where table_schema = 'public'
),
ins as (
  select coalesce(with_check, '') as body from pg_policies
  where schemaname = 'public' and tablename = 'board_files' and policyname = 'board_files_insert'
),
cnt as (
  select
    (select count(*) from public.board_files) as f,
    (select count(*) from public.board_files where author_id is null) as orphan,
    (select count(*) from public.board_events) as e,
    (select count(*) from public.board_events where uploads_open) as open_
),
gap as (
  select string_agg(g::text, '　' order by g) as miss
  from generate_series(200, 265) g
  where not exists (
    select 1 from public.schema_migrations m
     where split_part(m.name, '_', 1) = g::text)
)

select * from (

  select 1 as ord, '① 三個新欄位' as "檢查",
         (case when exists (select 1 from cols
                 where t = 'board_events' and c = 'uploads_open') then 'uploads_open ✅' else 'uploads_open ❌' end)
         || '　' ||
         (case when exists (select 1 from cols
                 where t = 'board_files' and c = 'author_id') then 'author_id ✅' else 'author_id ❌' end)
         || '　' ||
         (case when exists (select 1 from cols
                 where t = 'notification_prefs' and c = 'board') then 'prefs.board ✅' else 'prefs.board ❌' end) as "結果",
         case when (select count(*) from cols where
                     (t = 'board_events' and c = 'uploads_open')
                  or (t = 'board_files' and c = 'author_id')
                  or (t = 'notification_prefs' and c = 'board')) = 3
              then '✅ 3/3' else '❌ 沒加完' end as "判定"

  union all
  select 2, '② 通知預設是「開」嗎',
         coalesce((select 'default=' || def || '　is_nullable=' || nul from cols
                    where t = 'notification_prefs' and c = 'board'), '★ 欄位不存在'),
         case when exists (select 1 from cols
                            where t = 'notification_prefs' and c = 'board'
                              and nul = 'NO' and def like '%true%')
              then '✅ 預設收得到 —— notify-kinds.ts 的 NOTIFY_DEFAULT.board 也要是 true'
              else '❌ 預設對不上,畫面上的開關會跟實際行為不一樣' end

  union all
  /*
   * ★★★ 這一列是這支最要緊的。
   *   不是問「policy 在不在」，是問**它的條件裡有沒有那兩個字**。
   *   policy 在、但條件沒改的話，開關關著照樣傳得進去。
   */
  select 3, '③ 上傳 policy 真的看開關嗎',
         coalesce((select left(body, 90) || '…' from ins), '★ 沒有這條 policy'),
         case when not exists (select 1 from ins) then '❌ policy 不見了 —— 誰都傳不上去'
              when (select body from ins) ~ '\muploads_open\M'
               and (select body from ins) ~ '\mmeeting\M'
              then '✅ 開關關著／團聚 都擋得住（不只擋畫面）'
              else '❌ 條件裡沒有 uploads_open 或 meeting —— 開關是假的' end

  union all
  /*
   * ★★ 既有檔案有沒有補到 author_id。
   *   ★ 母體要判定:一份檔案都沒有的話，「孤兒 0 筆」是自動成立的，
   *     證明不了 backfill 有跑（README:母體是空的 → 每一條都回綠）。
   */
  select 4, '④ 既有檔案都補上「這是誰的」了嗎',
         '檔案 ' || (select f from cnt) || ' 份　│ 沒有 author_id 的 '
         || (select orphan from cnt) || ' 份',
         case when (select f from cnt) = 0
              then '⚠ 一份檔案都沒有 —— 這一列證明不了 backfill 有沒有跑'
              when (select orphan from cnt) > 0
              then '❌ 還有 ' || (select orphan from cnt)
                   || ' 份沒有 —— 它們會掉進一個叫「—」的分組'
              else '✅ 都補上了' end

  union all
  select 5, '⑤ 活動與開關的現況',
         '活動 ' || (select e from cnt) || ' 場　│ 開放上傳的 ' || (select open_ from cnt) || ' 場',
         case when (select e from cnt) = 0
              then '⚠ 一場都沒有 —— 正常，這支只開路'
              when (select open_ from cnt) = 0
              then '✅ 都是關的（預設 false，要人去打開）'
              else '✅ 有 ' || (select open_ from cnt) || ' 場開放中' end

  union all
  select 6, '⑥ 200～265 之間還缺哪幾號',
         coalesce((select miss from gap), '（沒有缺）'),
         case when (select miss from gap) is null
              then '✅ 一號都沒缺'
              else '⚠ 還缺：' || (select miss from gap) end

  union all
  select 7, '⑦ 這一支有沒有被記錄',
         coalesce((select max(name) from public.schema_migrations
                    where name = '265_board_events_v2'), '（沒記到）'),
         case when exists (select 1 from public.schema_migrations
                            where name = '265_board_events_v2')
              then '✅' else '❌ record_migration 沒寫進去' end

) v(ord, "檢查", "結果", "判定") order by v.ord;
