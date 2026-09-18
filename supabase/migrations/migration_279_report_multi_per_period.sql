/*
 * migration_279_report_multi_per_period.sql　2026-09-18
 * 會計報表：同一期可以有好幾份（拿掉那條唯一索引）
 *
 * 【怎麼跑】整份貼進 Supabase SQL Editor，看最後那張自檢表。
 *          ★ 看不到自檢的表格＝整支回滾了，不是「跑成功但沒輸出」。
 *
 * ══════════════════════════════════════════════════════════
 * 【使用者 2026-09-18】「401 可以重複上傳」
 *
 * ══════════════════════════════════════════════════════════
 * 【★★★ 我 275 的假設錯了】
 *
 * 275 建了 `ar_period_uniq (kind, period_start)`，前提是
 * 「同一個種類＋同一期只會有一份」。
 *
 * **那個前提是錯的** —— 安幸底下不只一家:畫面上已經有
 * 「正隆-115年 8月」與「愛皮-115年 7-8月」。同一期的 401，
 * 正隆一份、愛皮一份、洪鯊一份，全部都是對的。
 *
 * ★ 我當時沒問「這一期會不會有很多家」就加了唯一索引 ——
 *   而唯一索引擋下來的樣子是一句
 *   `duplicate key value violates unique constraint`，
 *   使用者看不懂，只知道第二份傳不上去。
 *
 * ══════════════════════════════════════════════════════════
 * 【★★ 為什麼是「拿掉」，不是「改成 (kind, period_start, title)」】
 *
 * 標題是**自由輸入**的。多一個空白、少一個橫線就變成另一份，
 * 那條索引擋得住的只有「一個字都不差」的重複 ——
 * 而那種重複本來就很少見。
 *
 * ★ 換句話說它擋不住真的問題，卻會擋住正常的使用。
 * ★★ 「同一期已經有一份了」改成**前端問一句**（`findSamePeriod`）:
 *   同種類、同期別、**而且同標題**才問「要換掉那一份嗎」——
 *   不同公司標題不同，就不會被問。
 *   系統負責看見，人負責決定（README 的判斷原則）。
 *
 * ══════════════════════════════════════════════════════════
 * 【跑兩次結果一樣】`drop index if exists`。
 * ══════════════════════════════════════════════════════════
 */

begin;

drop index if exists public.ar_period_uniq;

/*
 * ★ 查詢用的索引留著 —— 它跟唯一性無關，清單是照
 *   種類＋期別排的（`ar_kind_period_idx`）。
 */
create index if not exists ar_kind_period_idx
  on public.accounting_reports (kind, period_start desc);

comment on column public.accounting_reports.period_start is
  '那一期的第一天。401 兩月一期,起月只能是 1/3/5/7/9/11 —— 見 ar_shape_chk。'
  '★ 不要存「115年 7-8月」這種字串:排序、篩選、找重複全部會對不上。'
  '★★★ 同一期**可以有好幾份**(migration_279):正隆一份、愛皮一份、洪鯊一份。'
  '  275 那條 (kind, period_start) 的唯一索引是錯的假設,已經拿掉。';

do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('279_report_multi_per_period');
  end if;
end $do$;

commit;


-- ══════════════════════════════════════════════════════════
-- 自檢
-- ★★ 這張表在 commit 後面 —— 看不到它 = 整支回滾了。
-- ══════════════════════════════════════════════════════════
select * from (

  select 1 as ord, '★★★ ① 那條唯一索引拿掉了沒' as "檢查",
         case when exists (select 1 from pg_indexes
                            where schemaname = 'public'
                              and tablename = 'accounting_reports'
                              and indexname = 'ar_period_uniq')
              then 'ar_period_uniq 還在 ❌' else '（已經不在）' end as "結果",
         case when exists (select 1 from pg_indexes
                            where schemaname = 'public'
                              and tablename = 'accounting_reports'
                              and indexname = 'ar_period_uniq')
              then '❌ 還在 —— 同一期的第二份還是傳不上去'
              else '✅ 同一期可以有好幾份了' end as "判定"

  union all
  /*
   * ★★ 拿掉唯一索引**不可以**順手拿掉形狀的守衛。
   *   那一條管的是「401 的起月只能是單數月」那些，跟重複無關。
   */
  select 2, '★★ ② 形狀的守衛還在嗎（不該被動到）',
         coalesce((select string_agg(conname::text, '、' order by conname)
                     from pg_constraint
                    where conrelid = 'public.accounting_reports'::regclass
                      and contype = 'c'), '（一條都沒有）'),
         case when (select count(*) from pg_constraint
                     where conrelid = 'public.accounting_reports'::regclass
                       and contype = 'c'
                       and conname::text in ('ar_kind_chk', 'ar_shape_chk')) = 2
              then '✅ 兩條都在，一個字沒動'
              else '❌ 少了 —— 這支不該碰它們，去看 migration_275' end

  union all
  select 3, '③ 查詢用的索引還在嗎',
         coalesce((select string_agg(indexname::text, '、' order by indexname)
                     from pg_indexes
                    where schemaname = 'public' and tablename = 'accounting_reports'
                      and indexname <> 'accounting_reports_pkey'), '（沒有）'),
         case when exists (select 1 from pg_indexes
                            where schemaname = 'public' and tablename = 'accounting_reports'
                              and indexname = 'ar_kind_period_idx')
              then '✅ 在' else '⚠ 不在 —— 清單排序會變慢（不影響正確性）' end

  union all
  /*
   * ★★★ 母體要判定。**而且要證明那件事真的做得到了** ——
   *   「索引不在」跟「同一期存得下第二份」是兩件事。
   *   底下這一列數的是現況:現在同一期有幾份。
   */
  select 4, '★★★ ④ 現在有幾份報表、同一期最多幾份',
         coalesce((select count(*)::text || ' 份，同一個種類＋同一期最多 '
                     || coalesce(max(n)::text, '0') || ' 份'
                     from (select count(*) as n from public.accounting_reports
                            where period_start is not null
                            group by kind, period_start) g
                     cross join (select count(*) from public.accounting_reports) c(count)),
                  '（查不到）'),
         case when (select count(*) from public.accounting_reports) = 0
              then '⚠ 一份都沒有 —— 上面驗的只是索引的形狀'
              else '✅ 有東西可以檢查' end

  union all
  select 5, '⑤ 這一支有沒有被記錄',
         coalesce((select max(name) from public.schema_migrations
                    where name = '279_report_multi_per_period'), '（沒記到）'),
         case when exists (select 1 from public.schema_migrations
                            where name = '279_report_multi_per_period')
              then '✅' else '❌ record_migration 沒寫進去' end

) v(ord, "檢查", "結果", "判定") order by v.ord;
