-- ============================================================
-- migration_212：暫付加「零用金」類別，用途可以選安幸辦公室
--
-- 【使用者要的】（2026-09-03）
--   1. 類別多一個「零用金」
--   2. 「物業（選填）」改叫「用途」，而且選得到「安幸辦公室」
--
-- 【為什麼要動資料庫】
-- 安幸辦公室**不是一個物業** —— `estates` 裡沒有它，
-- 所以 `estate_id` 塞不進去。支出那邊早就有這個問題，
-- 解法是 `expenses.purpose_type`（'estate' / 'office'，migration_186）。
-- 暫付照抄同一套，兩頁的「用途」才是同一個意思。
--
-- ★★★ **不要在 `estates` 裡建一筆「安幸辦公室」來繞過**。
--   那會讓辦公室出現在每一個物業下拉、每一張物業損益、
--   每一份營收報表裡 —— 而它不是拿來出租的。
--   支出那邊當初就是這樣決定的，這裡跟上。
--
-- 【零用金為什麼是暫付不是支出】
-- 錢交給人的當下還沒花掉，那是**放在別人那裡的資產**。
-- 他拿去買東西才是費用。跟押金、保證金同一種性質。
--
-- 【怎麼跑】整份貼進 Supabase SQL Editor，看最後那張表。
-- ============================================================

begin;

-- ── 1. 類別多「零用金」 ──────────────────────────────────────
-- ★ 用 drop + add 不用 alter —— check 約束不能就地改。
--   先 drop 再 add 中間如果有人插一筆不合法的值⋯ 不會，
--   整份在同一個交易裡（SQL Editor 本來就這樣包）。
do $do$ begin
  if exists (select 1 from pg_constraint
              where conrelid = 'public.advance_payments'::regclass
                and conname = 'ap_category_chk') then
    alter table public.advance_payments drop constraint ap_category_chk;
  end if;
  alter table public.advance_payments
    add constraint ap_category_chk
    check (category in ('押金', '保證金', '零用金', '其他'));
end $do$;

-- ★★ 請款單那邊的勾選也要同步，不然從請款單走「暫支款」時選不到零用金
--   —— 而畫面上只是下拉少一個選項，沒有人會覺得那是錯的
do $do$ begin
  if exists (select 1 from pg_constraint
              where conrelid = 'public.purchase_requests'::regclass
                and conname = 'pr_advance_category_chk') then
    alter table public.purchase_requests drop constraint pr_advance_category_chk;
  end if;
  alter table public.purchase_requests
    add constraint pr_advance_category_chk
    check (advance_category is null
        or advance_category in ('押金', '保證金', '零用金', '其他'));
end $do$;


-- ── 2. 用途:物業 or 安幸辦公室 ───────────────────────────────
alter table public.advance_payments
  add column if not exists purpose_type text not null default 'estate';

comment on column public.advance_payments.purpose_type is
  '用途的種類（migration_212）:estate = 某個物業、office = 安幸辦公室。'
  '★ 跟 expenses.purpose_type 同一套語意 —— 兩頁的「用途」要是同一個意思。'
  '★★ office 時 estate_id 必須是 null，靠 ap_purpose_chk 擋住。';

do $do$ begin
  alter table public.advance_payments
    add constraint ap_purpose_type_chk check (purpose_type in ('estate', 'office'));
exception when duplicate_object then null; end $do$;

/*
 * ★★★ 辦公室不能同時掛物業。
 *
 *   兩個欄位一起才構成「用途」，而它們可以互相矛盾 ——
 *   `purpose_type='office'` 配一個 `estate_id`，畫面上只顯示其中一個，
 *   報表讀另一個。這正是 migration_210 那次踩到的形狀
 *   （purpose_type 寫了 estate 卻沒有 estate）。
 *
 * ★ estate 這邊**不強制**要有 estate_id —— 原本就允許留空
 *   （「還沒決定算哪一棟」是合法狀態）。只擋矛盾，不擋未填。
 */
do $do$ begin
  alter table public.advance_payments
    add constraint ap_purpose_chk
    check (purpose_type <> 'office' or estate_id is null);
exception when duplicate_object then null; end $do$;

do $$
begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('212_advance_purpose');
  end if;
end $$;

commit;

-- ============================================================
-- 自檢
-- ★ 這一支加的是**約束與欄位**，母體是「它們在不在」——
--   所以每一列問的都是結構，不是列數（09-03 踩過「母體 0 全綠」）。
-- ============================================================
select '1. 類別收得下「零用金」了嗎' as 檢查,
       coalesce((select pg_get_constraintdef(oid) from pg_constraint
                  where conrelid = 'public.advance_payments'::regclass
                    and conname = 'ap_category_chk'), '（沒有這個約束）') as 結果,
       case when exists (
              select 1 from pg_constraint
               where conrelid = 'public.advance_payments'::regclass
                 and conname = 'ap_category_chk'
                 and pg_get_constraintdef(oid) like '%零用金%')
            then '✅' else '❌ 還是選不到零用金' end as 判定

union all
select '2. 請款單那邊也同步了嗎',
       coalesce((select pg_get_constraintdef(oid) from pg_constraint
                  where conrelid = 'public.purchase_requests'::regclass
                    and conname = 'pr_advance_category_chk'), '（沒有這個約束）'),
       case when exists (
              select 1 from pg_constraint
               where conrelid = 'public.purchase_requests'::regclass
                 and conname = 'pr_advance_category_chk'
                 and pg_get_constraintdef(oid) like '%零用金%')
            then '✅' else '❌ 從請款單走暫支時選不到零用金' end

union all
select '3. purpose_type 欄位在不在',
       coalesce((select data_type || ' default ' || coalesce(column_default, '（無）')
                   from information_schema.columns
                  where table_schema = 'public' and table_name = 'advance_payments'
                    and column_name = 'purpose_type'), '（不存在）'),
       case when exists (select 1 from information_schema.columns
                          where table_schema = 'public' and table_name = 'advance_payments'
                            and column_name = 'purpose_type')
            then '✅' else '❌ 沒加成功' end

union all
-- ★★ 既有的列全部要是 estate（有 default，所以應該自動填好）
select '4. 既有暫付的 purpose_type',
       (select count(*) filter (where purpose_type = 'estate')::text || ' / '
             || count(*)::text from public.advance_payments),
       case when (select count(*) from public.advance_payments
                   where purpose_type is distinct from 'estate') = 0
            then '✅ 既有的都是 estate（行為沒變）'
            else '❌ 有列不是 estate —— 這支不該產生那種列' end

union all
-- ★ 矛盾的列:office 卻掛著物業。約束擋住了就不可能有，但問一次
select '5. 有沒有 office 卻掛物業的',
       (select count(*)::text from public.advance_payments
         where purpose_type = 'office' and estate_id is not null),
       case when (select count(*) from public.advance_payments
                   where purpose_type = 'office' and estate_id is not null) = 0
            then '✅ 沒有矛盾' else '❌ 約束沒生效' end

union all
select '6. 這一支有沒有被記錄',
       coalesce((select max(name) from public.schema_migrations
                  where name = '212_advance_purpose'), '（沒記到）'),
       case when exists (select 1 from public.schema_migrations
                          where name = '212_advance_purpose')
            then '✅' else '❌ record_migration 沒寫進去' end;
