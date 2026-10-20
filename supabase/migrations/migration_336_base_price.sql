/*
 * migration_336_base_price.sql　2026-10-20
 * 基本定價：每間房 平日／假日／旺日 三個價 ＋ 每個物業「星期幾算哪一種」
 *
 * 【David】「幫我放進去時兆，之後可以直接查完價格然後報價 有無空房與房價」
 *
 * 【這一支做的事】
 *   ① estates.price_dow：7 個字母，日→六。w＝平日、h＝假日、p＝旺日
 *      預設 'wwwwwhp' ＝ 日～四平日、五假日、六旺日（算的是住哪一晚）
 *   ② properties.price_weekday（平日）、price_holiday（假日）、price_peak（旺日）：整數、> 0、可空
 *      空＝沒有定價 → 找房時那一間不報價（不是報 0）
 *   ③ 帶入時兆 24 間（A12 沒有定價，不動）
 *      ★ 只填還是空的 —— 跑第二次不會蓋掉你在設定頁改過的價
 *
 * 【怎麼跑】整份貼進 Supabase SQL Editor。★★ 自檢在 commit 後面 —— 看不到那張表就是整支回滾了。
 *   ★ 先跑這支，再推程式。
 * ══════════════════════════════════════════════════════════
 */

begin;

-- ══════ ⓪ 閘門 ══════
do $do$
begin
  if to_regclass('public.estates') is null or to_regclass('public.properties') is null then
    raise exception 'estates／properties 有一張不在 —— 整支停下來';
  end if;
end $do$;

-- ══════ ① 星期幾算哪一種 ══════
alter table public.estates add column if not exists price_dow text not null default 'wwwwwhp';
do $do$ begin
  if not exists (select 1 from pg_constraint where conname = 'estates_price_dow_chk') then
    alter table public.estates add constraint estates_price_dow_chk check (price_dow ~ '^[whp]{7}$');
  end if;
end $do$;
comment on column public.estates.price_dow is
  '基本定價：日→六每一晚算哪一種。w 平日、h 假日、p 旺日（migration_336）';

-- ══════ ② 三個價 ══════
alter table public.properties add column if not exists price_weekday integer;
alter table public.properties add column if not exists price_holiday integer;
alter table public.properties add column if not exists price_peak    integer;
do $do$ begin
  if not exists (select 1 from pg_constraint where conname = 'properties_base_price_chk') then
    alter table public.properties add constraint properties_base_price_chk check (
      (price_weekday is null or price_weekday > 0) and
      (price_holiday is null or price_holiday > 0) and
      (price_peak    is null or price_peak    > 0));
  end if;
end $do$;
comment on column public.properties.price_weekday is '基本定價・平日一晚（migration_336）。空＝沒有定價，找房不報價';
comment on column public.properties.price_holiday is '基本定價・假日一晚（migration_336）';
comment on column public.properties.price_peak    is '基本定價・旺日一晚（migration_336）';

-- ══════ ③ 帶入時兆（只填空的）══════
do $do$
declare
  n_est int;
  v_est uuid;
begin
  select count(*), min(id::text)::uuid into n_est, v_est from public.estates where btrim(name) = '時兆';
  if n_est <> 1 then
    raise notice '找不到唯一一個叫「時兆」的物業（找到 % 個）—— 價格沒帶入，欄位照樣加好了，可以到設定頁自己填', n_est;
    return;
  end if;
  update public.properties p
     set price_weekday = coalesce(p.price_weekday, v.w),
         price_peak    = coalesce(p.price_peak,    v.pk),
         price_holiday = coalesce(p.price_holiday, v.h)
    from (values
      ('A01',1350,1800,1700),('A02',1350,1800,1800),('A03',1450,2300,1950),('A04',1400,1900,2250),
      ('A05',1500,2300,2100),('A06',1300,2100,1750),('A07',1500,2400,2050),('A08',1400,2300,1900),
      ('A09',1750,2300,2100),('A11',1300,2100,1750),('A13',1300,2100,1750),('A14',1450,2300,1950),
      ('A15',1450,1800,1800),('A16',1450,2300,1950),('A17',1450,1950,2300),('A18',1500,2300,2000),
      ('B01',1450,2300,1950),('B02',1350,2150,1800),('B03',1450,2300,1950),('B04',1300,2050,1800),
      ('B05',1500,2300,2000),('B06',1500,2000,1900),('B07',1500,2300,2000),('B08',1300,1950,1800)
    ) as v(room, w, pk, h)          -- 照你的表：平日、旺日、假日
   where p.estate_id = v_est and btrim(p.name) = v.room;
end $do$;

do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('336_base_price');
  end if;
end $do$;

commit;

-- ══════ 自檢（看不到這張表就是整支回滾了）══════
with e as (select id from public.estates where btrim(name) = '時兆'),
     p as (select * from public.properties where estate_id in (select id from e) and active)
select 1 as 序, '物業「星期幾算哪一種」欄位' as 檢查,
       coalesce((select string_agg(name || '＝' || price_dow, '、') from public.estates where id in (select id from e)), '沒有時兆') as 結果,
       case when exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'estates' and column_name = 'price_dow') then '✅' else '❌' end as 判定
union all
select 2, '時兆有定價的房（應該 24）',
       (select count(*) from p where price_weekday is not null)::text || ' 間',
       case when (select count(*) from p where price_weekday is not null) = 24 then '✅' else '⚠ 對一下房名' end
union all
select 3, '時兆沒有定價的房',
       coalesce((select string_agg(name, '、' order by name) from p where price_weekday is null), '（沒有）'),
       'ℹ A12 在這裡是對的'
union all
select 4, '假日比旺日貴（提醒，不擋）',
       coalesce((select string_agg(name, '、' order by name) from p where price_holiday > price_peak), '（沒有）'),
       'ℹ'
order by 1;
