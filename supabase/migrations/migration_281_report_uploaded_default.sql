/*
 * migration_281_report_uploaded_default.sql　2026-09-18
 * 會計報表：上傳日自動填，不再讓人手打
 *
 * 【怎麼跑】整份貼進 Supabase SQL Editor，看最後那張自檢表。
 *          ★ 看不到自檢的表格＝整支回滾了，不是「跑成功但沒輸出」。
 *
 * ══════════════════════════════════════════════════════════
 * 【使用者 2026-09-18】「不用上傳日，自動吃」
 *
 * ══════════════════════════════════════════════════════════
 * 【★★ 為什麼不是把欄位刪掉】
 *
 * 刪掉的話已經填過的那幾筆（愛皮那份是 2026-09-10）就沒了，
 * 而那是他自己打進去的資料 —— **拿掉一個欄位不該順便丟掉裡面的東西**。
 *
 * 所以欄位留著，只是:
 *   · 資料庫給它 `default current_date`
 *   · 畫面上那一格拿掉，改成傳檔案的當天自動帶
 *
 * ★★ 兩邊都做是刻意的:前端明寫是為了「換檔案時也要更新」，
 *   default 是最後一道 —— 哪天有人從別的路徑塞一筆進來，
 *   那一筆也不會是 null（而 null 在畫面上就是一個看不出原因的空白）。
 *
 * ══════════════════════════════════════════════════════════
 * 【★ 舊資料不補】
 *
 * 現在是 null 的那兩筆（正隆那兩份月報）**不動**。
 * 補成今天的話，那個日期是假的 —— 它們不是今天傳的。
 * 畫面上讓它顯示「—」，那是誠實的（README:對不上的不猜）。
 * ══════════════════════════════════════════════════════════
 */

begin;

alter table public.accounting_reports
  alter column uploaded_on set default current_date;

comment on column public.accounting_reports.uploaded_on is
  '上傳日:這一份傳上來那一天(2026-09-18 使用者:「不用上傳日，自動吃」)。'
  '★ 畫面上沒有這一格 —— 傳檔案時自動帶今天,換檔案時也會更新。'
  '★★ default current_date 是最後一道:從別的路徑塞進來的也不會是 null。'
  '★★★ 舊的 null 不補 —— 補成今天的話那個日期是假的。';

do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('281_report_uploaded_default');
  end if;
end $do$;

commit;


-- ══════════════════════════════════════════════════════════
-- 自檢
-- ★★ 這張表在 commit 後面 —— 看不到它 = 整支回滾了。
-- ══════════════════════════════════════════════════════════
select * from (

  select 1 as ord, '① default 設上去了沒' as "檢查",
         coalesce((select column_default from information_schema.columns
                    where table_schema = 'public'   -- ★ 一定要帶（README）
                      and table_name = 'accounting_reports'
                      and column_name = 'uploaded_on'), '（沒有 default）') as "結果",
         case when coalesce((select column_default from information_schema.columns
                              where table_schema = 'public'
                                and table_name = 'accounting_reports'
                                and column_name = 'uploaded_on'), '')
                   like '%CURRENT_DATE%'
              then '✅ 新的一筆沒帶日期也會自己填今天'
              else '❌ 沒設到 —— 從別的路徑塞進來的會是 null' end as "判定"

  union all
  /*
   * ★★★ 舊的 null **不該**被補掉。補成今天的話那個日期是假的。
   */
  select 2, '★★ ② 舊資料有沒有被亂補',
         (select count(*)::text || ' 份，其中沒有上傳日的 '
                 || count(*) filter (where uploaded_on is null)::text || ' 份'
            from public.accounting_reports),
         case when (select count(*) from public.accounting_reports) = 0
              then '⚠ 一份都沒有 —— 這一列不算數'
              else '✅ null 的留著 —— 它們不是今天傳的，畫面上顯示「—」才誠實' end

  union all
  /*
   * ★ 欄位還在（沒被順手刪掉）—— 已經填過的資料要留著。
   */
  select 3, '③ 欄位還在嗎（不該被刪）',
         case when exists (select 1 from information_schema.columns
                            where table_schema = 'public' and table_name = 'accounting_reports'
                              and column_name = 'uploaded_on')
              then 'uploaded_on 在' else '❌ 不見了' end,
         case when exists (select 1 from information_schema.columns
                            where table_schema = 'public' and table_name = 'accounting_reports'
                              and column_name = 'uploaded_on')
              then '✅ 已經填過的那幾筆還在'
              else '❌ 欄位被刪了 —— 裡面的資料一起沒了' end

  union all
  select 4, '④ 這一支有沒有被記錄',
         coalesce((select max(name) from public.schema_migrations
                    where name = '281_report_uploaded_default'), '（沒記到）'),
         case when exists (select 1 from public.schema_migrations
                            where name = '281_report_uploaded_default')
              then '✅' else '❌ record_migration 沒寫進去' end

) v(ord, "檢查", "結果", "判定") order by v.ord;
