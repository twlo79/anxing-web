/*
 * migration_276_form_usage_note.sql　2026-09-18
 * 檔案下載：多一欄「使用說明」（收起來的那一段）
 *
 * 【怎麼跑】整份貼進 Supabase SQL Editor，看最後那張自檢表。
 *          ★ 看不到自檢的表格＝整支回滾了，不是「跑成功但沒輸出」。
 *          ★★ migration_273 要先跑完（這支只是給它的表加一欄）。
 *
 * ══════════════════════════════════════════════════════════
 * 【使用者 2026-09-18】
 *   「多一個 toggle 使用說明 可以編輯」→ 甲／乙 並排 → **選乙**
 *
 *   甲　一個欄位:現在那行說明變成多行，列上顯示第一行
 *   乙　**兩個欄位**:一行短的（列上一直看得到）＋ 一段長的（收起來）← 選這個
 *
 * ══════════════════════════════════════════════════════════
 * 【★★ 為什麼是新的一欄，不是把 `note` 改成多行】
 *
 * 那是甲案。使用者選了乙 —— 兩欄各有各的工作:
 *
 *     note        一行。**列上一直看得到**，回答「這是什麼」
 *     usage_note  一段。收起來，回答「怎麼填、填完交給誰」
 *
 * ★ 舊資料不用動:`usage_note` 是 null 就是「沒有使用說明」，
 *   那一列不畫那顆 ▾。**不要 backfill 成空字串** ——
 *   null 與 '' 變成兩種「沒有」之後，畫面就得判兩次
 *   （README:先 grep 那一欄的 create/alter table 再決定空值長什麼樣）。
 *
 * ══════════════════════════════════════════════════════════
 * 【權限一個字都沒動】
 *
 * `board_forms` 的四條 policy 照舊（migration_273）——
 * 加一欄不會改變誰看得到、誰改得動。自檢第 ③ 列確認這件事。
 * ══════════════════════════════════════════════════════════
 */

begin;

alter table public.board_forms
  add column if not exists usage_note text;

comment on column public.board_forms.usage_note is
  '使用說明:怎麼填、填完交給誰(2026-09-18 使用者選的乙案)。'
  '★ 列上收起來,點「使用說明 ▾」才展開 —— 跟 note 是**兩件事**:'
  '  note 一行、一直看得到,回答「這是什麼」;'
  '  usage_note 一段、收起來,回答「怎麼填」。'
  '★★ null ＝ 沒有使用說明,那一列不畫那顆 ▾。不要 backfill 成空字串。';

do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('276_form_usage_note');
  end if;
end $do$;

commit;


-- ══════════════════════════════════════════════════════════
-- 自檢
-- ★★ 這張表在 commit 後面 —— 看不到它 = 整支回滾了。
-- ══════════════════════════════════════════════════════════
select * from (

  select 1 as ord, '① 欄位加上去了沒' as "檢查",
         coalesce((select c.column_name || '（' || c.data_type || '，'
                     || case when c.is_nullable = 'YES' then '可空' else 'NOT NULL ❌' end || '）'
                     from information_schema.columns c
                    where c.table_schema = 'public'   -- ★ 一定要帶（README）
                      and c.table_name = 'board_forms'
                      and c.column_name = 'usage_note'), '（不在）') as "結果",
         case when not exists (select 1 from information_schema.columns
                                where table_schema = 'public' and table_name = 'board_forms'
                                  and column_name = 'usage_note')
              then '❌ 沒加上去'
              when exists (select 1 from information_schema.columns
                            where table_schema = 'public' and table_name = 'board_forms'
                              and column_name = 'usage_note' and is_nullable = 'NO')
              then '❌ 不可以是 NOT NULL —— 舊的那幾筆本來就沒有使用說明'
              else '✅ text，可空' end as "判定"

  union all
  /*
   * ★★ `note` 必須還在。乙案是**兩欄並存** ——
   *   不小心把舊的那一欄改掉的話，列上那一行短說明會整排消失。
   */
  select 2, '★★ ② 原本的「說明」那一欄還在嗎',
         coalesce((select string_agg(column_name, '、' order by column_name)
                     from information_schema.columns
                    where table_schema = 'public' and table_name = 'board_forms'
                      and column_name in ('note', 'usage_note')), '（都不在）'),
         case when (select count(*) from information_schema.columns
                     where table_schema = 'public' and table_name = 'board_forms'
                       and column_name in ('note', 'usage_note')) = 2
              then '✅ 兩欄都在（乙案:一行短的 ＋ 一段長的）'
              else '❌ 少一欄 —— 乙案要兩欄並存' end

  union all
  /*
   * ★★★ 加一欄不可以動到權限。四條 policy 要原封不動。
   */
  select 3, '★★★ ③ 權限有沒有被動到',
         coalesce((select string_agg(policyname::text, '　' order by policyname)
                     from pg_policies
                    where schemaname = 'public' and tablename = 'board_forms'), '（沒有 policy）'),
         case when (select count(*) from pg_policies
                     where schemaname = 'public' and tablename = 'board_forms') = 4
              then '✅ 還是四條，一個字都沒動'
              else '❌ 不是四條 —— 這支不該碰權限，去看 migration_273' end

  union all
  /*
   * ★ 母體要判定。現在有幾份檔案、其中幾份已經有使用說明 ——
   *   剛跑完一定是 0 份有，那是對的，但要說出來
   *   （README:母體是空的 → 每一條都回綠）。
   */
  select 4, '④ 母體：現在有幾份檔案',
         case when to_regclass('public.board_forms') is null then '★ 表不在'
              else (select count(*)::text || ' 份，其中已經有使用說明的 '
                      || count(*) filter (where btrim(coalesce(usage_note, '')) <> '')::text
                      || ' 份' from public.board_forms) end,
         case when to_regclass('public.board_forms') is null then '❌ 表不在'
              when (select count(*) from public.board_forms) = 0
              then '⚠ 一份檔案都沒有 —— 上面驗的只是欄位的形狀'
              else '✅ 有東西可以檢查（剛跑完「0 份有使用說明」是對的）' end

  union all
  /*
   * ★ 舊資料不要被 backfill 成空字串 —— null 與 '' 變成兩種「沒有」的話，
   *   畫面上「要不要畫那顆 ▾」就得判兩次。
   */
  select 5, '★ ⑤ 有沒有被填成空字串',
         case when to_regclass('public.board_forms') is null then '★ 表不在'
              else (select count(*) filter (where usage_note = '')::text || ' 筆是空字串'
                      from public.board_forms) end,
         case when to_regclass('public.board_forms') is null then '❌ 表不在'
              when (select count(*) from public.board_forms where usage_note = '') = 0
              then '✅ 沒有 —— 「沒有使用說明」只有 null 一種形狀'
              else '❌ 有空字串 —— 「沒有」變成兩種形狀了' end

  union all
  select 6, '⑥ 這一支有沒有被記錄',
         coalesce((select max(name) from public.schema_migrations
                    where name = '276_form_usage_note'), '（沒記到）'),
         case when exists (select 1 from public.schema_migrations
                            where name = '276_form_usage_note')
              then '✅' else '❌ record_migration 沒寫進去' end

) v(ord, "檢查", "結果", "判定") order by v.ord;
