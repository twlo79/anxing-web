-- ============================================================
-- migration_214：把 08-14 庭玉的「正隆多間」拆成三筆
--
-- 【這一筆是什麼】（2026-09-03 使用者提供）
--   08-14 庭玉在正隆掃了 4B3、13A5、14B1 三間，工作量算一半。
--   當初只記成一筆代碼「正隆多間」、`units_override = 0.50`。
--
--   「正隆多間」不在 `hk_property` 裡 → 算不出清潔費 → 整筆掉出去，
--   而排班表上看起來完全正常（它照樣算 0.5 間的打掃量與報酬）。
--
-- 【拆法】一份工算 0.5 間，攤給三間 → 每間 1/6
--
--   間數  1 ÷ 6 = 0.1667 → 兩位小數只存得下 0.17
--   點數  7 ÷ 6 = 1.1667
--   支出  9000 ÷ 6 = 1,500
--
-- ★★★ 0.17 × 3 = 0.51，**多了 0.01**。所以第三筆記 0.16，
--   三筆合計剛好 0.50 —— 跟原本那一筆一模一樣。
--   不配這個尾差的話，打掃量、報酬點數、清潔費三個數字會同時多一點點，
--   而「多一點點」是最不會有人發現的那種錯。
--
-- 【為什麼是 migration 不是手點】
-- 手點是「改一筆 ＋ 新增兩筆」三個動作，中間斷掉就是間數對不上 0.5。
-- 包在一個交易裡:要嘛三筆都成，要嘛原本那筆原封不動。
--
-- 【怎麼跑】整份貼進 Supabase SQL Editor，看最後那張表。
-- ============================================================

begin;

do $do$
declare
  w   record;
  n   int;
  bad text;
begin
  -- ── 1. 找出那一筆，必須剛好一筆 ──────────────────────────
  select count(*) into n
    from public.hk_work_item
   where period = '202608'
     and work_date = date '2026-08-14'
     and property_code = '正隆多間';

  if n = 0 then
    raise notice '找不到「正隆多間」—— 可能已經拆過了。這一支不做事。';
    return;
  elsif n > 1 then
    raise exception '「正隆多間」有 % 筆不是 1 筆 —— 中止，先確認是哪幾筆', n;
  end if;

  select * into w
    from public.hk_work_item
   where period = '202608'
     and work_date = date '2026-08-14'
     and property_code = '正隆多間';

  /*
   * ★★ 原本的間數必須是 0.50。不是的話代表有人動過它，
   *   而我下面要寫的 0.17/0.17/0.16 是**照 0.5 算出來的** ——
   *   基準變了還照抄就是編一個數字出來。
   */
  if coalesce(w.units_override, 1) <> 0.50 then
    raise exception '原本的間數是 %（預期 0.50）—— 中止，拆法要重算',
      coalesce(w.units_override, 1);
  end if;

  -- ── 2. 三個代碼都要真的能算出錢 ──────────────────────────
  /*
   * ★★★ 拆完還是算不出錢的話，這一支只是把一個問題變成三個。
   *   所以先確認三個代碼都在房務主檔、都指到 ERP 房源、都有清潔費。
   */
  select string_agg(c.code, '、') into bad
    from (values ('4B3'), ('13A5'), ('14B1')) as c(code)
    left join public.hk_property hp on hp.code = c.code
    left join public.properties  p  on p.id = hp.property_id
   where hp.id is null or hp.property_id is null or p.clean_price is null;

  if bad is not null then
    raise exception '這些代碼還算不出錢:% —— 先去補設定，不然拆完照樣掉出去', bad;
  end if;

  -- ── 3. 三筆新的 ──────────────────────────────────────────
  -- ★ 日期／人／工作類型全部照抄原本那筆，只有房源與間數是新的
  insert into public.hk_work_item
    (period, work_date, property_code, work_type, staff_id, source, note, units_override)
  select w.period, w.work_date, v.code, w.work_type, w.staff_id, 'manual',
         'migration_214 從「正隆多間」拆出來（原本一筆 0.5 間，三間各 1/6）',
         v.units
    from (values ('4B3', 0.17), ('13A5', 0.17), ('14B1', 0.16))
         as v(code, units);

  get diagnostics n = row_count;
  if n <> 3 then
    raise exception '只新增了 % 筆（預期 3）—— 中止，整份回滾', n;
  end if;

  -- ── 4. 刪掉原本那筆 ──────────────────────────────────────
  -- ★ 留著的話 0.5 會被算兩次（原本一筆 ＋ 新的三筆）
  delete from public.hk_work_item where id = w.id;

  get diagnostics n = row_count;
  if n <> 1 then
    raise exception '刪除影響 % 列（預期 1）—— 中止，整份回滾', n;
  end if;
end $do$;

do $$
begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('214_split_zhenglong_multi');
  end if;
end $$;

commit;

-- ============================================================
-- 自檢
-- ★ 母體要判定 —— 這一支的成敗就是「那三筆在不在」。
-- ============================================================
select '1. 三筆拆出來了嗎' as 檢查,
       (select count(*)::text from public.hk_work_item
         where work_date = date '2026-08-14'
           and property_code in ('4B3', '13A5', '14B1')) as 結果,
       case when (select count(*) from public.hk_work_item
                   where work_date = date '2026-08-14'
                     and property_code in ('4B3', '13A5', '14B1')) = 3
            then '✅ 三筆都在' else '❌ 不是 3 筆，下面幾列不用看' end as 判定

union all
-- ★★★ 這一列是重點:總間數必須還是 0.50。多了就是重複算、少了就是漏算
select '2. 那三筆的間數合計（要剛好 0.50）',
       coalesce((select sum(units_override)::text from public.hk_work_item
                  where work_date = date '2026-08-14'
                    and property_code in ('4B3', '13A5', '14B1')), '—'),
       case when (select coalesce(sum(units_override), 0) from public.hk_work_item
                   where work_date = date '2026-08-14'
                     and property_code in ('4B3', '13A5', '14B1')) = 0.50
            then '✅ 跟原本那筆一樣'
            else '❌ 對不上 0.50 —— 打掃量與報酬會跟著錯' end

union all
select '3. 原本那筆還在不在（要不在）',
       (select count(*)::text from public.hk_work_item
         where property_code = '正隆多間'),
       case when (select count(*) from public.hk_work_item
                   where property_code = '正隆多間') = 0
            then '✅ 已經刪掉，不會重複算'
            else '❌ 還在 —— 0.5 被算了兩次' end

union all
-- ★★ 拆完要真的算得出錢。算不出來的話這支只是把一個問題變成三個
select '4. 這三筆算不算得出清潔費',
       coalesce((select string_agg(w.property_code || ' ' ||
                                   coalesce(p.clean_price::text, '未設價'), '、')
                   from public.hk_work_item w
                   left join public.hk_property hp on hp.code = w.property_code
                   left join public.properties  p  on p.id = hp.property_id
                  where w.work_date = date '2026-08-14'
                    and w.property_code in ('4B3', '13A5', '14B1')), '—'),
       case when not exists (
              select 1 from public.hk_work_item w
              left join public.hk_property hp on hp.code = w.property_code
              left join public.properties  p  on p.id = hp.property_id
              where w.work_date = date '2026-08-14'
                and w.property_code in ('4B3', '13A5', '14B1')
                and p.clean_price is null)
            then '✅ 三間都有價，產生支出時會進去'
            else '❌ 還是有算不出錢的' end

union all
select '5. 這一支有沒有被記錄',
       coalesce((select max(name) from public.schema_migrations
                  where name = '214_split_zhenglong_multi'), '（沒記到）'),
       case when exists (select 1 from public.schema_migrations
                          where name = '214_split_zhenglong_multi')
            then '✅' else '❌ record_migration 沒寫進去' end;
