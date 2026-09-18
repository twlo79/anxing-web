/*
 * migration_280_report_uploaded_on.sql　2026-09-18
 * 會計報表：「申報日」改叫「上傳日」
 *
 * 【怎麼跑】整份貼進 Supabase SQL Editor，看最後那張自檢表。
 *          ★ 看不到自檢的表格＝整支回滾了，不是「跑成功但沒輸出」。
 *
 * ══════════════════════════════════════════════════════════
 * 【使用者 2026-09-18】「改成上傳日」
 *
 * ══════════════════════════════════════════════════════════
 * 【★★ 為什麼連欄位名一起改，不是只改畫面上那幾個字】
 *
 * 只改標籤的話，資料庫叫 `filed_on`、畫面叫「上傳日」——
 * 三個月後看 SQL 的人會以為那是「送去國稅局那一天」，
 * 而它其實是「傳上來那一天」。**同一件事兩個名字**
 * （README 的用語表:同一個東西在兩頁叫不同名字，
 * 使用者會以為那是兩件事）。
 *
 * ★ `alter table ... rename column` 會**自動跟著改**掛在那一欄上的
 *   check 約束，不用自己去改 `ar_shape_chk` 的定義
 *   （migration_239 那次踩的是**改型別**，那才要先列清單）。
 *
 * ══════════════════════════════════════════════════════════
 * 【★★★ 順手拿掉一條會擋錯人的規則】
 *
 * 275 寫了「申報日不能早於那一期的開始」。那對**申報日**是對的，
 * 對**上傳日**是錯的 ——
 *
 *   401 的期別下拉列到**明年**（migration_275 / lib/report.ts）。
 *   先把 116 年 11-12 月那一份建起來的話，
 *   上傳日是今天（115/9/18），而期別開始是 116/11/1 ——
 *   **今天比期別早，會被擋掉**。
 *
 * ★ 上傳日跟期別本來就沒有先後關係。這一條留著只會擋住正常的使用。
 * ══════════════════════════════════════════════════════════
 */

begin;

-- ══════ ① 改名（check 約束會自己跟著改）══════
do $do$ begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'accounting_reports'
                and column_name = 'filed_on') then
    alter table public.accounting_reports rename column filed_on to uploaded_on;
  end if;
end $do$;

comment on column public.accounting_reports.uploaded_on is
  '上傳日:這一份傳上來那一天(2026-09-18 使用者:「改成上傳日」)。'
  '★ 原本叫 filed_on(申報日),連欄位名一起改 —— '
  '  資料庫叫 filed_on、畫面叫上傳日的話,三個月後看 SQL 的人會誤會。';

-- ══════ ② 把「不能早於期別開始」那一條拿掉 ══════
/*
 * ★★ 整條 check 重建，**其餘四條原封不動**:
 *     標題不可空、月報與 401 要有期別、期別一定是一號、401 起月單數月。
 *   自檢第 ③ 列會一條一條確認它們還在。
 */
alter table public.accounting_reports drop constraint if exists ar_shape_chk;

alter table public.accounting_reports
  add constraint ar_shape_chk check (
    btrim(title) <> ''
    /* 月報與 401 一定要有期別；其他可以沒有 */
    and (kind = '其他' or period_start is not null)
    /* 有期別的話一定是那一期的第一天 */
    and (period_start is null or extract(day from period_start) = 1)
    /* ★★★ 401 兩月一期 —— 起月只能是單數月，選不到「6-7 月」 */
    and (kind <> '401' or period_start is null
         or extract(month from period_start)::int in (1, 3, 5, 7, 9, 11))
    /* ★ 「上傳日不早於期別」那一條**故意拿掉**了 —— 見檔頭 */
  );

do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('280_report_uploaded_on');
  end if;
end $do$;

commit;


-- ══════════════════════════════════════════════════════════
-- 自檢
-- ★★ 這張表在 commit 後面 —— 看不到它 = 整支回滾了。
-- ══════════════════════════════════════════════════════════
select * from (

  select 1 as ord, '★★★ ① 欄位改名了沒（而且舊的不在了）' as "檢查",
         coalesce((select string_agg(column_name, '、' order by column_name)
                     from information_schema.columns
                    where table_schema = 'public'   -- ★ 一定要帶（README）
                      and table_name = 'accounting_reports'
                      and column_name in ('filed_on', 'uploaded_on')), '（兩個都不在）') as "結果",
         case when exists (select 1 from information_schema.columns
                            where table_schema = 'public' and table_name = 'accounting_reports'
                              and column_name = 'filed_on')
              then '❌ 舊的 filed_on 還在 —— 兩個名字並存比沒改更糟'
              when exists (select 1 from information_schema.columns
                            where table_schema = 'public' and table_name = 'accounting_reports'
                              and column_name = 'uploaded_on')
              then '✅ 只剩 uploaded_on'
              else '❌ 兩個都不在' end as "判定"

  union all
  /*
   * ★★★ 改名**不可以弄丟資料**。這一列數的是「有填日期的有幾筆」——
   *   rename 是不動資料的，所以這個數字改完應該跟改之前一樣。
   */
  select 2, '★★ ② 日期有沒有被弄丟',
         (select count(*)::text || ' 份，其中有填日期的 '
                 || count(*) filter (where uploaded_on is not null)::text || ' 份'
            from public.accounting_reports),
         case when (select count(*) from public.accounting_reports) = 0
              then '⚠ 一份都沒有 —— 這一列不算數'
              else '✅ rename 不動資料，這個數字要跟改之前一樣' end

  union all
  /*
   * ★★★ 這一列**一條一條問**，不是只數幾條 ——
   *   重建 check 時抄漏一條不會報錯，只會讓某一種錯誤的資料安靜存進去。
   */
  select 3, '★★★ ③ 其餘四條守衛還在嗎',
         (select string_agg(g.nm, '、' order by g.ord)
            from (values
                    (1, '標題不可空',   'btrim(title)'),
                    (2, '要有期別',     'period_start IS NOT NULL'),
                    (3, '一定是一號',   'day'),
                    (4, '401 單數月',   'ARRAY[1, 3, 5, 7, 9, 11]')
                 ) g(ord, nm, needle)
           where coalesce((select pg_get_constraintdef(c.oid) from pg_constraint c
                            where c.conrelid = 'public.accounting_reports'::regclass
                              and c.conname = 'ar_shape_chk'), '') like '%' || g.needle || '%'),
         case when (select count(*)
                      from (values ('btrim(title)'), ('period_start IS NOT NULL'),
                                   ('day'), ('ARRAY[1, 3, 5, 7, 9, 11]')) g(needle)
                     where coalesce((select pg_get_constraintdef(c.oid) from pg_constraint c
                                       where c.conrelid = 'public.accounting_reports'::regclass
                                         and c.conname = 'ar_shape_chk'), '')
                           like '%' || g.needle || '%') = 4
              then '✅ 四條都在'
              else '❌ 重建時抄漏了 —— 那一種錯誤的資料會安靜存進去' end

  union all
  /*
   * ★★★ 而那一條**不該**還在。還在的話先建明年的期別會被擋掉。
   */
  select 4, '★★★ ④ 「不早於期別」那一條拿掉了沒',
         case when coalesce((select pg_get_constraintdef(c.oid) from pg_constraint c
                              where c.conrelid = 'public.accounting_reports'::regclass
                                and c.conname = 'ar_shape_chk'), '')
                   like '%uploaded_on >=%'
                or coalesce((select pg_get_constraintdef(c.oid) from pg_constraint c
                              where c.conrelid = 'public.accounting_reports'::regclass
                                and c.conname = 'ar_shape_chk'), '')
                   like '%filed_on >=%'
              then '還在 ❌' else '（已經不在）' end,
         case when coalesce((select pg_get_constraintdef(c.oid) from pg_constraint c
                              where c.conrelid = 'public.accounting_reports'::regclass
                                and c.conname = 'ar_shape_chk'), '')
                   like '%>= period_start%'
              then '❌ 還在 —— 先建明年那一期會被擋掉'
              else '✅ 上傳日跟期別沒有先後關係了' end

  union all
  select 5, '⑤ 這一支有沒有被記錄',
         coalesce((select max(name) from public.schema_migrations
                    where name = '280_report_uploaded_on'), '（沒記到）'),
         case when exists (select 1 from public.schema_migrations
                            where name = '280_report_uploaded_on')
              then '✅' else '❌ record_migration 沒寫進去' end

) v(ord, "檢查", "結果", "判定") order by v.ord;
