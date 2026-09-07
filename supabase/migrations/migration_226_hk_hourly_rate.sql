/*
 * migration_226 —— 房務時薪人員的時薪欄位
 * ============================================================
 * 2026-09-07 使用者：「劉姐的也要進支出／時薪 500」
 *
 * ============================================================
 * 【★★★ 為什麼是一個欄位，不是程式裡寫死 500】
 *
 * 那個數字**直接乘出每個月的房務支出**。寫死在原始碼裡的話:
 *
 *   · 調薪的時候沒有人會想到要去翻程式碼、改一行、重新部署
 *   · 而在那之前，帳上每個月都用舊薪資結算,金額一直是錯的
 *   · 更糟的是它**不會錯得很明顯** —— 只是每個月少幾千塊
 *
 * 存成欄位之後，調薪是在房務設定頁改一個數字，下次結算就對了。
 *
 * ★ `numeric(10,2)` 不是 int —— 時薪未必是整數（183.5 之類的日薪折算）。
 * ★ 預設 null 不是 0。「還沒設」與「時薪是 0」是兩件事,
 *   而 `hourlyRows()` 對 null 會把那個人列進「沒設時薪」讓人去補,
 *   對 0 則是同一件事 —— 但 null 讀起來誠實。
 *
 * ============================================================
 * 【★★ 不猜哪一列是劉姐】
 *
 * 用 `count_mode = 'hours'` 找，而且**先數**:剛好一列才填。
 * 兩列以上就中止並印出名字 —— 猜錯的話薪水會算到別人頭上,
 * 而那個錯不會叫（CLAUDE.md:「對不上的不猜」）。
 *
 * 【怎麼跑】整份貼進 Supabase SQL Editor，看最後那張自檢表。
 */

begin;

alter table public.hk_staff
  add column if not exists hourly_rate numeric(10,2);

comment on column public.hk_staff.hourly_rate is
  '時薪。只有 count_mode = ''hours'' 的人用得到（migration_226）。'
  'null = 還沒設 —— 產生支出時會被列進「沒設時薪」，不會當成 0 而安靜跳過。';

do $do$
declare
  n int;
  nm text;
begin
  select count(*) into n from public.hk_staff where count_mode = 'hours' and active;

  if n = 0 then
    raise notice '沒有 count_mode=hours 的人員 —— 欄位加好了，時薪之後在房務設定頁填';
  elsif n > 1 then
    select string_agg(name, '、' order by name) into nm
      from public.hk_staff where count_mode = 'hours' and active;
    raise exception '時薪人員有 % 位（%）—— 中止，不猜哪一位是 500。'
      '請在房務設定頁逐一填時薪', n, nm;
  else
    -- ★ 已經填過就不覆蓋:重跑這一支不該把調過的薪資改回 500
    update public.hk_staff
       set hourly_rate = 500
     where count_mode = 'hours' and active and hourly_rate is null;
  end if;
end $do$;

do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('226_hk_hourly_rate');
  end if;
end $do$;

commit;


-- ══════════════════════════════════════════════════════════
-- 自檢
-- ══════════════════════════════════════════════════════════
select v.ord, v."檢查", v."結果", v."判定" from (

  select 1, '① 欄位加好了',
         coalesce((select data_type || '(' || coalesce(numeric_precision::text, '?')
                     || ',' || coalesce(numeric_scale::text, '?') || ')'
                     from information_schema.columns
                    where table_schema = 'public' and table_name = 'hk_staff'
                      and column_name = 'hourly_rate'), '（沒有這一欄）'),
         case when exists (select 1 from information_schema.columns
                            where table_schema = 'public' and table_name = 'hk_staff'
                              and column_name = 'hourly_rate')
              then '✅ 過' else '❌ 沒加到' end

  union all
  select 2, '②★★ 時薪人員與他們的時薪',
         coalesce((select string_agg(name || '：'
                     || coalesce(hourly_rate::text, '（沒設）'), '、' order by name)
                     from public.hk_staff where count_mode = 'hours' and active),
                  '（沒有時薪人員）'),
         case when not exists (select 1 from public.hk_staff
                                where count_mode = 'hours' and active
                                  and hourly_rate is null)
              then '✅ 都設好了'
              else '⚠ 有人沒設 —— 那個人的工時不會產生支出，會列在「算不出來」那一區' end

  union all
  /*
   * ★★★ 母體要判定:間數人員**不該**有時薪。
   *   有的話代表填錯人了,而那個數字會在某次改 count_mode 之後突然生效。
   */
  select 3, '③★★★ 間數人員身上不該有時薪',
         coalesce((select string_agg(name || '=' || hourly_rate::text, '、' order by name)
                     from public.hk_staff
                    where count_mode <> 'hours' and hourly_rate is not null), '（沒有，正確）'),
         case when not exists (select 1 from public.hk_staff
                                where count_mode <> 'hours' and hourly_rate is not null)
              then '✅ 過' else '⚠ 有間數人員被填了時薪 —— 對一下是不是填錯人' end

  union all
  select 4, '④ 這一支有沒有被記錄',
         coalesce((select max(name) from public.schema_migrations
                    where name = '226_hk_hourly_rate'), '（沒記到）'),
         case when exists (select 1 from public.schema_migrations
                            where name = '226_hk_hourly_rate')
              then '✅' else '❌ record_migration 沒寫進去' end

) v(ord, "檢查", "結果", "判定") order by v.ord;
