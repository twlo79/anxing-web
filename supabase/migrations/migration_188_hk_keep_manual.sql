/*
 * migration_188 —— 同步不再洗掉人工的東西 ＋ 事件可以「按掉」
 * ============================================================
 * 2026-09-01 使用者：「1. 看什麼沒進系統 2. 手動 key 進去 3. 手動記入後按掉」
 *
 * ============================================================
 * 【★★★ 這支修的是一個正在發生的 bug】
 *
 * `migration_59` 加了 `hk_work_item.source`，comment 寫著:
 *     「manual = 手動新增，**同步永不刪除**」
 * 而房務統計頁的 `addItem()` 註解也寫著「下次同步永不刪除它」。
 *
 * **兩邊都寫了同一句話，中間沒有人做。**
 *
 *   route.ts:  delete from hk_work_item where period = ?      ← 沒帶 source
 *   route.ts:  delete from hk_event     where period = ?      ← cascade 再殺一次
 *
 * 第一個洞在程式碼修（已改成 `.eq('source','timetree')`）。
 * 第二個洞在**這裡** —— 因為它不是 SQL 寫錯，是外鍵的刪除行為:
 *
 *   hk_work_item.event_id ... on delete **cascade**
 *
 * `timetree_edited`（同步來的、但人改過的）那些列身上有 event_id，
 * 所以就算 work_item 的刪除擋住了，**刪 hk_event 時仍然會連帶把它們殺掉**。
 *
 * ★★ 症狀是安靜的:補完當下畫面是對的，下一次同步之後那幾筆消失，
 *   而月底看報表只會覺得「那個人怎麼比印象中少」。
 *   migration_59 的檔頭原話:「那是最傷信任的一種 bug」。
 *
 * ============================================================
 * 【解法：cascade 改成 set null】
 *
 * 事件沒了，工作項還在，只是不再指向任何事件 —— 那正是事實。
 *
 * ★ 不改成 `no action`:那會讓刪除**失敗**，而失敗的是整個同步。
 *   「同步整個掛掉」比「少一個關聯」嚴重得多。
 */

-- ============================================================
-- ① event_id 的外鍵：cascade → set null
-- ============================================================
do $$
declare fk text;
begin
  /*
   * ★ 外鍵名字**去問線上**，不寫死。
   *   Postgres 自動命名通常是 `hk_work_item_event_id_fkey`，
   *   但如果當初是手動命名的就對不上 —— 而 drop 一個不存在的約束
   *   會讓整支 migration 停在這裡。
   */
  select conname into fk
    from pg_constraint
   where conrelid = 'public.hk_work_item'::regclass
     and contype = 'f'
     and pg_get_constraintdef(oid) like '%hk_event%';

  if fk is null then
    raise exception 'hk_work_item 上找不到指向 hk_event 的外鍵 —— 這支 migration 的前提不成立';
  end if;

  execute format('alter table public.hk_work_item drop constraint %I', fk);
  execute 'alter table public.hk_work_item
             add constraint hk_work_item_event_id_fkey
             foreign key (event_id) references public.hk_event(id) on delete set null';
end $$;

comment on column public.hk_work_item.event_id is
  '來自哪一則行事曆事件。null = 手動新增的，或原事件已被同步刪掉。'
  '★ on delete SET NULL（migration_188）—— 原本是 cascade，'
  '會讓 timetree_edited 的列在每次同步時被連帶刪除。';

-- ============================================================
-- ② 事件可以「按掉」
-- ============================================================
/*
 * 「這一則我看過了，不用進系統」——例如聚餐、洗烘折毛巾、
 * 或已經手動補進去了的那幾則。
 *
 * ============================================================
 * 【★★ 為什麼放在 hk_event 上，而不是另開一張表】
 *
 * 使用者選的是「**每個月重按**」（2026-09-01 的選項 1b）。
 *
 * 而 `hk_event` 每次同步都整批刪掉重建 —— 所以把狀態放在它身上，
 * 「同步後按掉的狀態消失」是**自動發生的**，不用寫任何清除邏輯。
 *
 * ★ 如果當初選的是「按掉要跨月保留」，就得另開一張表、
 *   用 period＋日期＋標題當鍵去對回來。**選 1b 省掉了那整張表。**
 *
 * ★★ 代價要說清楚:重新同步之後那幾筆會再出現一次。
 *   那其實不是壞事 —— 行事曆改過的話本來就該再看一眼。
 */
alter table public.hk_event
  add column if not exists dismissed_at timestamptz,
  add column if not exists dismissed_by uuid references public.profiles(id);

comment on column public.hk_event.dismissed_at is
  '被人「按掉」的時間 = 我看過了，這一則不用進系統（migration_188）。'
  '★ 按掉不影響任何統計數字，只是從「待處理」清單移走。'
  '★★ 同步會整批刪掉重建，所以按掉的狀態不跨月保留（使用者選的）。';

/*
 * ★ 部分索引:待處理清單查的是「還沒按掉的」，
 *   而按掉的那些預期會越積越多。
 */
create index if not exists hk_event_todo_idx
  on public.hk_event (period, event_date) where dismissed_at is null;


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('188_hk_keep_manual');
  end if;
end $$;


-- ══════════════════════════════════════════════════════════
-- 自檢。★ `raise notice` 在 SQL Editor 看不到，所以回一張表。
-- ★ 排序欄位留在子查詢裡（`v.ord`）—— `order by 1` 會照文字排（migration_181 踩過）。
-- ══════════════════════════════════════════════════════════
select v."檢查項目", v."結果", v."說明" from (

  /*
   * ★★★ 這一項是這支最重要的一條。
   *   `confdeltype` 是外鍵的刪除行為:c=cascade、n=set null、a=no action。
   *   還是 c 的話，同步照樣會把人改過的項目殺掉。
   */
  select 1, '★★★ event_id 改成 SET NULL 了',
         /*
          * ★★ `confdeltype` 的型別是 `"char"`（單位元組），不是 text。
          *   直接 `'…' || confdeltype` 會 ERROR 42725:
          *   「operator is not unique: unknown || "char"」——
          *   Postgres 有好幾個 `||` 的候選，挑不出唯一的那個。
          *   **明寫 `::text`**，不要靠推斷（2026-09-01 踩過）。
          */
         coalesce((select case confdeltype
                            when 'n' then '✅ SET NULL'
                            when 'c' then '⚠ 還是 CASCADE —— 同步仍會刪掉人改過的項目'
                            else '⚠ 是 ' || confdeltype::text end
                     from pg_constraint
                    where conrelid = 'public.hk_work_item'::regclass
                      and contype = 'f'
                      and pg_get_constraintdef(oid) like '%hk_event%'),
                  '⚠ 找不到那個外鍵'),
         'CASCADE 的話刪 hk_event 會把 timetree_edited 的列一起帶走'

  union all
  select 2, '★★ 按掉的欄位建好了',
         (select string_agg(column_name || '（' || data_type || '）', '、' order by column_name)
            from information_schema.columns
           where table_schema = 'public' and table_name = 'hk_event'
             and column_name in ('dismissed_at', 'dismissed_by')),
         '要看到兩個欄位。少一個的話「誰按的」記不下來'

  union all
  select 3, '★ 待處理的部分索引',
         coalesce((select 'OK：' || indexdef from pg_indexes
                    where schemaname = 'public' and indexname = 'hk_event_todo_idx'),
                  '⚠ 沒建起來（不影響功能，只是查詢慢一點）'),
         '只索引還沒按掉的 —— 按掉的會越積越多'

  union all
  /*
   * ★★ 現在有幾筆是人工的。**這個數字就是這次修好之前，
   *   每一次同步都會被洗掉的量。**
   */
  select 4, '★★ 目前有幾筆人工資料',
         (select count(*) filter (where source = 'manual')::text || ' 筆手動新增 ／ '
                 || count(*) filter (where source = 'timetree_edited')::text || ' 筆同步後改過 ／ '
                 || count(*)::text || ' 筆總計'
            from public.hk_work_item),
         '★ 這兩種以前每次同步都會消失。是 0 的話很可能是已經被洗掉了'

  union all
  select 5, '★ 事件與工作項的總數',
         (select (select count(*) from public.hk_event)::text || ' 則事件 ／ '
                 || (select count(*) from public.hk_work_item)::text || ' 筆工作項'),
         '這支只改結構，不動任何一列資料 —— 數字跟跑之前要一樣'

) v(ord, "檢查項目", "結果", "說明") order by v.ord;
