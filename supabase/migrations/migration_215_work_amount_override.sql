-- ============================================================
-- migration_215：工單可以直接指定清潔費金額
--
-- 【為什麼要這個欄位】（2026-09-03 使用者選 B）
--
-- 正隆一份工掃三間、工作量算一半 → 每間 9000 ÷ 6 = **1,500**。
-- 而 1/6 = 0.1666… 用「間數 × 單價」表達不出來:
--   `units_override` 是 numeric(6,2)，0.17 × 9000 = 1,530（差 30）。
--
-- 所以讓人直接講「這份工付多少」。
--
-- ★★★ 代價要知道:金額與「間數 × 單價」從此**可能不一致**。
--   這正是 CLAUDE.md 那條「推導值存成欄位」在警告的形狀。
--   差別有兩個:
--     1. 這是**人明確填的**，不是程式算完存起來的
--     2. 只有填了才生效 —— null 一律走公式，預設行為完全不變
--   所以它是「覆寫」不是「快取」。快取會過期，覆寫不會。
--
-- ★★ 項目名稱在有覆寫時**不印 ×N**（`cleanItemName` 的 fixedAmount）。
--   印了會變成「×0.17」配一筆 1,500，而 0.17 × 9,000 是 1,530 ——
--   看得懂的人會停下來算，然後以為系統錯了。
--
-- 【這一支也修既有資料】
-- 08-14 那三筆已經產生過支出了（1,530 / 1,530 / 1,440），
-- 而產生是 `ignoreDuplicates` —— 重按不會更新。所以一併改。
--
-- 【怎麼跑】整份貼進 Supabase SQL Editor，看最後那張表。
-- ============================================================

begin;

-- ── 1. 欄位 ──────────────────────────────────────────────────
alter table public.hk_work_item
  add column if not exists amount_override numeric(14,2);

comment on column public.hk_work_item.amount_override is
  '這一份工的清潔費直接指定（migration_215）。null = 用「間數 × 房源單價」算。'
  '★ 0 是「這份工不用錢」，跟 null 不同。'
  '★★ 合掃是同一份工的兩列，兩列各帶同一個值 —— 讀的時候取一個不是加總。';

do $do$ begin
  alter table public.hk_work_item
    add constraint hk_work_item_amount_chk
    check (amount_override is null or amount_override >= 0);
exception when duplicate_object then null; end $do$;


-- ── 2. 08-14 正隆那三筆:每間 1,500 ──────────────────────────
do $do$
declare n int;
begin
  update public.hk_work_item
     set amount_override = 1500
   where work_date = date '2026-08-14'
     and property_code in ('4B3', '13A5', '14B1');

  get diagnostics n = row_count;
  if n <> 3 then
    raise exception '設到 % 筆（預期 3）—— 中止。migration_214 跑過了嗎？', n;
  end if;
end $do$;


-- ── 3. 已經產生的那三筆支出，金額改回 1,500 ──────────────────
/*
 * ★★★ 不改的話帳上永遠是 1,530/1,530/1,440。
 *   「產生本月支出」是 upsert ＋ ignoreDuplicates —— 重按不會更新既有的。
 *   那個設計是對的（已經對過的帳不該無聲變動），但代價就是這種時候要手動修。
 *
 * ★ 項目名稱也要一起改。留著「×0.17」配 1,500 會讓人算不出來。
 */
do $do$
declare n int;
begin
  update public.expenses e
     set amount    = 1500,
         item_name = regexp_replace(e.item_name, ' ×[0-9.]+$', '')
   where e.spent_on = date '2026-08-14'
     and e.hk_job_key is not null
     and e.item_name like '房務清潔%'
     and (e.item_name like '%4B3%' or e.item_name like '%13A5%' or e.item_name like '%14B1%');

  get diagnostics n = row_count;
  -- ★ 0 筆是合法的（還沒按過「產生本月支出」），但不是 0 就一定要是 3
  if n <> 0 and n <> 3 then
    raise exception '改到 % 筆支出（預期 0 或 3）—— 中止', n;
  end if;
  raise notice '改了 % 筆既有支出', n;
end $do$;

do $$
begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('215_work_amount_override');
  end if;
end $$;

commit;

-- ============================================================
-- 自檢
-- ============================================================
select '1. amount_override 欄位在不在' as 檢查,
       coalesce((select data_type from information_schema.columns
                  where table_schema = 'public' and table_name = 'hk_work_item'
                    and column_name = 'amount_override'), '（不存在）') as 結果,
       case when exists (select 1 from information_schema.columns
                          where table_schema = 'public' and table_name = 'hk_work_item'
                            and column_name = 'amount_override')
            then '✅' else '❌ 沒加成功，下面不用看' end as 判定

union all
select '2. 那三筆的指定金額',
       coalesce((select string_agg(property_code || ' ' || amount_override::text, '、'
                                   order by property_code)
                   from public.hk_work_item
                  where work_date = date '2026-08-14'
                    and property_code in ('4B3', '13A5', '14B1')), '—'),
       case when (select count(*) from public.hk_work_item
                   where work_date = date '2026-08-14'
                     and property_code in ('4B3', '13A5', '14B1')
                     and amount_override = 1500) = 3
            then '✅ 三筆都是 1,500' else '❌ 不是三筆 1,500' end

union all
-- ★★ 這一列是重點:三筆合計要剛好 4,500（＝ 9,000 的一半）
select '3. 三筆合計（要 4,500）',
       coalesce((select sum(amount_override)::text from public.hk_work_item
                  where work_date = date '2026-08-14'
                    and property_code in ('4B3', '13A5', '14B1')), '—'),
       case when (select coalesce(sum(amount_override), 0) from public.hk_work_item
                   where work_date = date '2026-08-14'
                     and property_code in ('4B3', '13A5', '14B1')) = 4500
            then '✅ ＝ 9,000 × 0.5' else '❌ 對不上' end

union all
-- ★ 已產生的支出:0 筆（還沒產生）或 3 筆都是 1,500
select '4. 已產生的支出金額',
       coalesce((select string_agg(item_name || ' ' || amount::text, '、' order by item_name)
                   from public.expenses
                  where spent_on = date '2026-08-14' and hk_job_key is not null
                    and (item_name like '%4B3%' or item_name like '%13A5%'
                         or item_name like '%14B1%')), '（還沒產生）'),
       case when (select count(*) from public.expenses
                   where spent_on = date '2026-08-14' and hk_job_key is not null
                     and (item_name like '%4B3%' or item_name like '%13A5%'
                          or item_name like '%14B1%')
                     and amount <> 1500) = 0
            then '✅ 沒有金額不是 1,500 的'
            else '❌ 還有 1,530／1,440 沒改到' end

union all
-- ★ 名稱裡不該再有 ×N —— 留著會跟 1,500 對不起來
select '5. 項目名稱還有沒有「×0.17」',
       (select count(*)::text from public.expenses
         where spent_on = date '2026-08-14' and hk_job_key is not null
           and item_name ~ ' ×[0-9.]+$'
           and (item_name like '%4B3%' or item_name like '%13A5%'
                or item_name like '%14B1%')),
       case when (select count(*) from public.expenses
                   where spent_on = date '2026-08-14' and hk_job_key is not null
                     and item_name ~ ' ×[0-9.]+$'
                     and (item_name like '%4B3%' or item_name like '%13A5%'
                          or item_name like '%14B1%')) = 0
            then '✅ 已經拿掉' else '❌ 還有，會跟金額對不起來' end

union all
select '6. 這一支有沒有被記錄',
       coalesce((select max(name) from public.schema_migrations
                  where name = '215_work_amount_override'), '（沒記到）'),
       case when exists (select 1 from public.schema_migrations
                          where name = '215_work_amount_override')
            then '✅' else '❌ record_migration 沒寫進去' end;
