/*
 * migration_282_report_filed_on.sql　2026-09-18
 * 會計報表：把「申報日」加回來（跟上傳日是兩件事），順便把現有三份的日期押上
 *
 * 【怎麼跑】整份貼進 Supabase SQL Editor，看最後那張自檢表。
 *          ★ 看不到自檢的表格＝整支回滾了，不是「跑成功但沒輸出」。
 *
 * ══════════════════════════════════════════════════════════
 * 【使用者 2026-09-18】
 *   「日期 這三份幫我押上 2026/09/18 上傳」
 *   「401 放上申報日 2026/9/10」
 *   「還是可以填申報日 非必填」
 *
 * ══════════════════════════════════════════════════════════
 * 【★★★ 這不是把 280 改回去】
 *
 * 280 把 `filed_on` 改名成 `uploaded_on`，當時的判斷是
 * 「同一件事不要有兩個名字」。**那個判斷的前提是它們是同一件事** ——
 * 而它們不是:
 *
 *   · 上傳日 = 這份檔案什麼時候進到系統（自動帶，人不用管）
 *   · 申報日 = 什麼時候送出去給國稅局（人填，而且常常是空的）
 *
 * 愛皮那一份正好把差別攤開來:檔案 9/10 傳進來、9/10 也送出去，
 * 兩個數字一樣 —— 所以一開始看不出來這是兩欄。
 *
 * ★ 所以這一支是**新增一欄**，不是回退。`uploaded_on` 一個字不動。
 *
 * ══════════════════════════════════════════════════════════
 * 【★★ 為什麼不給 filed_on 加「不早於期別」的守衛】
 *
 * 那條規則對申報日**是講得通的**（沒有人在那一期開始前就申報）。
 * 但 275 正是在這一欄上加了它、280 又得把它拆掉 ——
 * 同一個位置連踩兩次之後，我不想再用「講得通」當理由加守衛。
 *
 * ★ 它擋得住的是打錯年份（2025 打成 2026）那種，
 *   而那種錯誤看得到也改得回來;
 *   它擋不住的那一天，畫面上只會回一句
 *   `violates check constraint`，使用者看不懂要改哪一格。
 * ★★ 前端不擋、資料庫不擋 —— 這一欄純粹是記錄，錯了就改。
 *
 * ══════════════════════════════════════════════════════════
 * 【★★★ 押日期那一段有一道閘門，會擋下來不會亂改】
 *
 * 使用者說的「這三份」指的是**他螢幕上當下那三份**。
 * 這支如果等到第四份傳上來才跑，無條件 update 會把新的那一份
 * 也押成 9/18 —— 而那個日期是假的，畫面上看不出來。
 *
 * 所以底下先數一次:**不是 3 份就整支報錯停下來**（會全部回滾）。
 * 那時候把錯誤訊息貼回來，改成指名道姓的 update 就好。
 *
 * ══════════════════════════════════════════════════════════
 * 【跑兩次結果一樣】
 *   欄位是 `add column if not exists`；
 *   兩行 update 押的是固定日期，第二次跑押上去的值一模一樣。
 * ══════════════════════════════════════════════════════════
 */

begin;

-- ══════ ① 申報日:新增一欄，可以空 ══════
alter table public.accounting_reports
  add column if not exists filed_on date;

comment on column public.accounting_reports.filed_on is
  '申報日:送出去給國稅局那一天(2026-09-18 使用者:「還是可以填申報日 非必填」)。'
  '★ 非必填 —— 還沒申報就是空的,畫面上那一段整段不出現。'
  '★★ 跟 uploaded_on(上傳日)是**兩件事**:上傳日是檔案進系統那天(自動帶),'
  '  申報日是送出去那天(人填)。愛皮 115年7-8月 剛好兩個都是 9/10,'
  '  所以一開始看起來像同一欄 —— 它不是。'
  '★★★ 故意**沒有**「不早於期別」的 check:275 在這一欄加過、280 拆掉過,'
  '  同一個位置不再用「講得通」當理由加守衛(見檔頭)。';

-- ══════ ② 閘門：現在必須剛好是那三份 ══════
/*
 * ★★★ 這一段是整支唯一會擋人的地方。擋下來是對的 ——
 *   多出來的那一份不該被押上一個假的上傳日。
 */
do $do$
declare v_n int;
begin
  select count(*) into v_n from public.accounting_reports;
  if v_n <> 3 then
    raise exception
      '現在有 % 份報表，不是寫這支時的 3 份 —— 整支停下來沒有改任何東西。'
      '把這句話貼回對話裡，我改成指名道姓的 update（不然新傳的那幾份會被押上一個假的上傳日）。',
      v_n;
  end if;
end $do$;

-- ══════ ③ 三份都押上 2026/09/18 上傳 ══════
update public.accounting_reports
   set uploaded_on = date '2026-09-18';

-- ══════ ④ 401 那一份的申報日 2026/09/10 ══════
/*
 * ★ 現在只有一份 401（愛皮 115年7-8月）。上面那道閘門已經確認過
 *   總數是 3，所以這裡用 kind 指得到唯一的那一份。
 */
update public.accounting_reports
   set filed_on = date '2026-09-10'
 where kind = '401';

do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('282_report_filed_on');
  end if;
end $do$;

commit;


-- ══════════════════════════════════════════════════════════
-- 自檢
-- ★★ 這張表在 commit 後面 —— 看不到它 = 整支回滾了。
-- ══════════════════════════════════════════════════════════
select * from (

  select 1 as ord, '① 申報日這一欄建起來了沒' as "檢查",
         coalesce((select data_type || case when is_nullable = 'YES' then '，可以空' else '，不可空 ❌' end
                     from information_schema.columns
                    where table_schema = 'public'   -- ★ 一定要帶（README）
                      and table_name = 'accounting_reports'
                      and column_name = 'filed_on'), '（沒有這一欄）') as "結果",
         case when exists (select 1 from information_schema.columns
                            where table_schema = 'public' and table_name = 'accounting_reports'
                              and column_name = 'filed_on' and is_nullable = 'YES')
              then '✅ 非必填'
              else '❌ 沒建起來，或建成了不可空 —— 不可空的話沒申報的那幾份存不進去' end as "判定"

  union all
  /*
   * ★★★ 上傳日那一欄**不可以**被動到。這一支是新增一欄，不是把 280 改回去。
   */
  select 2, '★★ ② 上傳日那一欄還在嗎（不該被改掉）',
         coalesce((select string_agg(column_name, '、' order by column_name)
                     from information_schema.columns
                    where table_schema = 'public' and table_name = 'accounting_reports'
                      and column_name in ('uploaded_on', 'filed_on')), '（都不在）'),
         case when (select count(*) from information_schema.columns
                     where table_schema = 'public' and table_name = 'accounting_reports'
                       and column_name in ('uploaded_on', 'filed_on')) = 2
              then '✅ 兩欄並存 —— 上傳日（自動）與申報日（人填）是兩件事'
              else '❌ 少一欄' end

  union all
  /*
   * ★★★ 母體要判定，不是「參考值」（README 2026-09-03 的坑）。
   *   母體是 0 的話下面每一條都會自動成立，六個綠勾等於沒檢查。
   */
  select 3, '★★★ ③ 有幾份報表',
         (select count(*)::text || ' 份' from public.accounting_reports),
         case when (select count(*) from public.accounting_reports) = 0
              then '⚠ 一份都沒有 —— 下面全部不算數'
              when (select count(*) from public.accounting_reports) <> 3
              then '⚠ 不是 3 份 —— 上面那道閘門應該已經擋下來了，這裡看到就是哪裡不對'
              else '✅ 3 份，跟押日期時一樣' end

  union all
  /*
   * ★★★ 這一列問的是**結果對不對**（每一份的上傳日都是 9/18 嗎），
   *   不是「這次跑改了幾列」—— 後者跑第二次會變 0，看起來像壞掉
   *   （README 2026-09-05 的坑）。跑第十次答案都一樣。
   */
  select 4, '★★★ ④ 三份的上傳日都押上 2026/09/18 了嗎',
         (select count(*) filter (where uploaded_on = date '2026-09-18')::text
                 || ' / ' || count(*)::text || ' 份是 2026-09-18'
            from public.accounting_reports),
         case when (select count(*) from public.accounting_reports) = 0 then '⚠ 沒有東西可檢查'
              when (select count(*) from public.accounting_reports
                     where uploaded_on is distinct from date '2026-09-18') = 0
              then '✅ 每一份都是 9/18'
              else '❌ 有漏 —— 畫面上那幾份會是「—」或舊日期' end

  union all
  /*
   * ★★★ 同上:問結果。而且**兩邊都問** ——
   *   401 那一份要有 9/10，**其餘兩份要是空的**。
   *   只問前者的話，「全部都被押上 9/10」會回綠。
   */
  select 5, '★★★ ⑤ 申報日只有 401 那一份有',
         (select '401：' || coalesce(max(filed_on) filter (where kind = '401')::text, '（空的）')
                 || '　·　其餘有填的 '
                 || count(*) filter (where kind <> '401' and filed_on is not null)::text || ' 份'
            from public.accounting_reports),
         case when (select count(*) from public.accounting_reports) = 0 then '⚠ 沒有東西可檢查'
              when (select count(*) from public.accounting_reports
                     where kind = '401' and filed_on = date '2026-09-10') = 1
               and (select count(*) from public.accounting_reports
                     where kind <> '401' and filed_on is not null) = 0
              then '✅ 401 是 9/10，月報那兩份留空'
              else '❌ 押錯了 —— 月報那兩份不該有申報日' end

  union all
  /*
   * ★ 形狀的守衛不該被這一支動到（它管的是標題、期別、401 單數月）。
   */
  select 6, '⑥ 形狀的守衛還在嗎（不該被動到）',
         coalesce((select string_agg(conname::text, '、' order by conname)
                     from pg_constraint
                    where conrelid = 'public.accounting_reports'::regclass
                      and contype = 'c'), '（一條都沒有）'),
         case when (select count(*) from pg_constraint
                     where conrelid = 'public.accounting_reports'::regclass
                       and contype = 'c'
                       and conname::text in ('ar_kind_chk', 'ar_shape_chk')) = 2
              then '✅ 兩條都在，一個字沒動'
              else '❌ 少了 —— 這支不該碰它們' end

  union all
  select 7, '⑦ 這一支有沒有被記錄',
         coalesce((select max(name) from public.schema_migrations
                    where name = '282_report_filed_on'), '（沒記到）'),
         case when exists (select 1 from public.schema_migrations
                            where name = '282_report_filed_on')
              then '✅' else '❌ record_migration 沒寫進去' end

) v(ord, "檢查", "結果", "判定") order by v.ord;
