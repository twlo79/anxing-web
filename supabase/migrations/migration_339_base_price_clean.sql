/*
 * migration_339_base_price_clean.sql　2026-10-22
 * 基本定價多一個「清潔費」：每個物業一個數字，一筆訂單收一次（不是每晚）
 *
 * 【David】「找房的時兆多做一個清潔費，一次性的 1000。可以再調整；房價 + 1000 清潔費」
 *   對過 Airbnb：A07 Nikolaos 45 晚，房費 76,200 ＋ 清潔費 1,000（一次）—— 跟 PMS 每晚加總一致
 *
 * 【這一支做的事】
 *   ① estates.price_clean：整數、> 0、可空（空＝不收清潔費）
 *   ② 時兆帶入 1,000（只填空的，跑第二次不會蓋掉設定頁改過的數字）
 *
 * 【怎麼跑】整份貼進 Supabase SQL Editor。★★ 自檢在 commit 後面 —— 看不到那張表就是整支回滾了。
 *   先跑這支，再推程式。
 * ══════════════════════════════════════════════════════════
 */

begin;

do $do$
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'estates' and column_name = 'price_dow') then
    raise exception '找不到 estates.price_dow —— 先跑 migration_336（基本定價）';
  end if;
end $do$;

alter table public.estates add column if not exists price_clean integer;
do $do$ begin
  if not exists (select 1 from pg_constraint where conname = 'estates_price_clean_chk') then
    alter table public.estates add constraint estates_price_clean_chk check (price_clean is null or price_clean > 0);
  end if;
end $do$;
comment on column public.estates.price_clean is
  '基本定價・清潔費：一筆訂單收一次（不是每晚）。空＝不收。找房報價＝每晚加總＋這個（migration_339）';

update public.estates set price_clean = 1000 where btrim(name) = '時兆' and price_clean is null;

do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('339_base_price_clean');
  end if;
end $do$;

commit;

-- ══════ 自檢（看不到這張表就是整支回滾了）══════
select 1 as 序, '欄位 estates.price_clean' as 檢查,
       case when exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'estates' and column_name = 'price_clean') then '有' else '沒有' end as 結果,
       case when exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'estates' and column_name = 'price_clean') then '✅' else '❌' end as 判定
union all
select 2, '時兆的清潔費',
       coalesce((select to_char(price_clean, 'FM999,990') from public.estates where btrim(name) = '時兆'), '（沒有時兆）'),
       case when (select price_clean from public.estates where btrim(name) = '時兆') = 1000 then '✅' else 'ℹ 對一下' end
order by 1;
