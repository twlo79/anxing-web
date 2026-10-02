/* ══════════════════════════════════════════════════════════════════════
 * migration_311：調價軟體支出改成「每張 Airbnb 訂單一筆」，日期記入住日                    2026-10-02
 *
 * 【為什麼】David：「把之前說的調價費 1.5% 拿掉，改成每張訂單都有支出，支出日放住房日。
 *   之後有訂單進來 → 自動認列營收 and 產生調價支出 總訂單$ × 1.5%」
 *
 * 【跟 308 差在哪】
 *   308：每月 × 每物業一筆，金額 ＝ 那個月的營收認列 × 1.5%（照住宿天數拆），pg_cron 每天重算上個月
 *   311：每張 Airbnb 訂單一筆，金額 ＝ 訂單金額（實收＋搭檔）× 1.5%，日期 ＝ 入住日，
 *        訂單一寫進來就由觸發器產生／更新／刪除 —— 不用排程
 *
 * 【做什麼】
 *   ① 拿掉 308：刪 pricing:<物業>:<ym> 那 185 筆、停掉 pricing_fee_daily 排程、刪 gen_pricing_fee_expenses()
 *   ② 觸發器 trg_order_pricing_fee（orders 新增／改／刪）：
 *        Airbnb、金額 > 0、有入住日、有物業 → 一筆支出（auto_key = pricing:order:<訂單id>）
 *        不符合了（金額歸零＝作廢、改成別的來源、訂單刪了）→ 那筆支出拿掉
 *        入住日所在月份已關帳 → 不碰
 *   ③ 既有的 Airbnb 訂單一次補齊
 *   費率照舊讀 work_settings.pricing_fee_rate（308 加的，0.015）。
 *
 * ★ 會計科目 service 專業服務費、用途＝訂單的物業、房源＝訂單的房源（跟 308 同）。
 * ★ 訂單刪掉 → 支出直接刪（系統產生的，不進回收桶）；訂單從回收桶救回來 → 支出自動長回來。
 * ★★ 自檢在 commit 後面 —— 看不到那張表就是整支回滾了。
 * ══════════════════════════════════════════════════════════ */

begin;

-- ① 拿掉 308 那一套
create temp table _old as
  select count(*) as n, coalesce(sum(amount), 0) as amt
    from public.expenses where auto_key like 'pricing:%' and auto_key not like 'pricing:order:%';
delete from public.expenses where auto_key like 'pricing:%' and auto_key not like 'pricing:order:%';

do $$
begin
  perform cron.unschedule(jobid) from cron.job where jobname = 'pricing_fee_daily';
end $$;
drop function if exists public.gen_pricing_fee_expenses(text);

comment on column public.work_settings.pricing_fee_rate is
  '調價軟體費率：每張 Airbnb 訂單金額 × 這個數，記一筆支出（migration_311；308 是每月每物業，已拿掉）。';

-- ② 一張訂單 → 一筆支出
create or replace function public.order_pricing_fee()
returns trigger
language plpgsql security definer set search_path = public as $fn$
declare
  o      public.orders;
  v_key  text;
  v_rate numeric;
  v_amt  numeric;
begin
  -- 刪掉的那張：拿掉它的支出（入住月已關帳就不碰）
  if tg_op = 'DELETE' then
    if old.checkin is null or not public.is_period_locked(to_char(old.checkin, 'YYYYMM')) then
      delete from public.expenses where auto_key = 'pricing:order:' || old.id;
    end if;
    return old;
  end if;

  o := new;
  v_key := 'pricing:order:' || o.id;
  if o.checkin is not null and public.is_period_locked(to_char(o.checkin, 'YYYYMM')) then
    return new;
  end if;
  -- 改了入住日：舊的那個月關帳了也不動
  if tg_op = 'UPDATE' and old.checkin is not null and old.checkin is distinct from o.checkin
     and public.is_period_locked(to_char(old.checkin, 'YYYYMM')) then
    return new;
  end if;

  if o.source is distinct from 'airbnb' or coalesce(o.amount, 0) <= 0
     or o.checkin is null or o.estate_id is null then
    delete from public.expenses where auto_key = v_key;
    return new;
  end if;

  select coalesce(pricing_fee_rate, 0.015) into v_rate from public.work_settings where id = 1;
  v_rate := coalesce(v_rate, 0.015);
  v_amt  := round(o.amount * v_rate);
  if v_amt <= 0 then
    delete from public.expenses where auto_key = v_key;
    return new;
  end if;

  insert into public.expenses
    (spent_on, item_name, amount, account_code, purpose_type, estate_id, property_id, note, auto_key)
  values
    (o.checkin,
     '調價軟體 ' || coalesce(nullif(o.property_raw, ''), o.order_key),
     v_amt, 'service', 'estate', o.estate_id, o.property_id,
     'Airbnb ' || o.order_key || '・' || coalesce(nullif(o.guest_name, ''), '—') || '・'
       || to_char(o.checkin, 'YYYY-MM-DD') || '～' || coalesce(to_char(o.checkout, 'YYYY-MM-DD'), '?')
       || '・訂單 ' || to_char(round(o.amount), 'FM999,999,999') || ' × '
       || rtrim(rtrim((v_rate * 100)::text, '0'), '.') || '%・系統依訂單自動產生',
     v_key)
  on conflict (auto_key) do update
     set spent_on = excluded.spent_on, item_name = excluded.item_name, amount = excluded.amount,
         estate_id = excluded.estate_id, property_id = excluded.property_id, note = excluded.note
   where (public.expenses.spent_on, public.expenses.item_name, public.expenses.amount,
          public.expenses.estate_id, public.expenses.property_id, public.expenses.note)
         is distinct from
         (excluded.spent_on, excluded.item_name, excluded.amount,
          excluded.estate_id, excluded.property_id, excluded.note);
  return new;
end $fn$;

comment on function public.order_pricing_fee() is
  '調價軟體支出：每張 Airbnb 訂單（金額 > 0、有入住日、有物業）一筆，金額 × work_settings.pricing_fee_rate，日期＝入住日。'
  '不符合了就拿掉；入住月已關帳不碰。migration_311。';

drop trigger if exists trg_order_pricing_fee on public.orders;
create trigger trg_order_pricing_fee
  after insert or delete or update of amount, source, checkin, checkout, estate_id, property_id,
                                       property_raw, guest_name, order_key
  on public.orders
  for each row execute function public.order_pricing_fee();

-- ③ 既有的 Airbnb 訂單一次補齊
--   ★ 不用「update orders set amount = amount」讓觸發器去產生 —— 那會讓 orders 上**每一支**觸發器
--     對 1,700 張單各跑一次（房客姓名的大小寫整理、稽核紀錄、營收認列重算），而那些都不該動。
--     這裡直接照觸發器同一套規則 insert，訂單一個欄位都不碰。
insert into public.expenses
  (spent_on, item_name, amount, account_code, purpose_type, estate_id, property_id, note, auto_key)
select o.checkin,
       '調價軟體 ' || coalesce(nullif(o.property_raw, ''), o.order_key),
       round(o.amount * w.r), 'service', 'estate', o.estate_id, o.property_id,
       'Airbnb ' || o.order_key || '・' || coalesce(nullif(o.guest_name, ''), '—') || '・'
         || to_char(o.checkin, 'YYYY-MM-DD') || '～' || coalesce(to_char(o.checkout, 'YYYY-MM-DD'), '?')
         || '・訂單 ' || to_char(round(o.amount), 'FM999,999,999') || ' × '
         || rtrim(rtrim((w.r * 100)::text, '0'), '.') || '%・系統依訂單自動產生',
       'pricing:order:' || o.id
  from public.orders o
  cross join (select coalesce((select pricing_fee_rate from public.work_settings where id = 1), 0.015) as r) w
 where o.source = 'airbnb' and coalesce(o.amount, 0) > 0 and o.checkin is not null and o.estate_id is not null
   and not public.is_period_locked(to_char(o.checkin, 'YYYYMM'))
   and round(o.amount * w.r) > 0
on conflict (auto_key) do nothing;

do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('311_pricing_fee_per_order');
  end if;
end $do$;

commit;

-- ═══ 自檢（在 commit 後面 —— 看不到那張表就是整支回滾了） ═══════════
with pf as (select * from public.expenses where auto_key like 'pricing:order:%'),
     ab as (select o.* from public.orders o
             where o.source = 'airbnb' and coalesce(o.amount, 0) > 0 and o.checkin is not null and o.estate_id is not null
               and not public.is_period_locked(to_char(o.checkin, 'YYYYMM'))),
     rate as (select coalesce(pricing_fee_rate, 0.015) r from public.work_settings where id = 1)
select 1 as 序, '母體：該有調價支出的 Airbnb 訂單' as 檢查,
       (select count(*)::text from ab) || ' 張' as 結果,
       case when (select count(*) from ab) = 0 then '⚠ 一張都沒有，下面全部不算數' else 'ℹ' end as 判定
union all
select 2, '308 那種「每月每物業」的已拿掉',
       '這次刪了 ' || (select n from _old) || ' 筆（$' || to_char((select amt from _old), 'FM999,999,999') || '）・現在剩 '
         || (select count(*) from public.expenses where auto_key like 'pricing:%' and auto_key not like 'pricing:order:%') || ' 筆',
       case when (select count(*) from public.expenses where auto_key like 'pricing:%' and auto_key not like 'pricing:order:%') = 0
                 and not exists (select 1 from cron.job where jobname = 'pricing_fee_daily')
                 and to_regprocedure('public.gen_pricing_fee_expenses(text)') is null
            then '✅ 支出、排程、函式都拿掉了' else '❌' end
union all
select 3, '每張訂單一筆（缺的，要 0）',
       (select count(*)::text from ab where not exists (select 1 from pf where pf.auto_key = 'pricing:order:' || ab.id)),
       case when (select count(*) from ab where not exists (select 1 from pf where pf.auto_key = 'pricing:order:' || ab.id)) = 0
            then '✅' else '❌' end
union all
select 4, '多出來的（訂單不在或不符合了，要 0）',
       (select count(*)::text from pf where not exists (select 1 from ab where pf.auto_key = 'pricing:order:' || ab.id)),
       case when (select count(*) from pf where not exists (select 1 from ab where pf.auto_key = 'pricing:order:' || ab.id)) = 0
            then '✅' else '❌' end
union all
select 5, '金額＝訂單 × 費率、日期＝入住日（對不上的，要 0）',
       (select count(*)::text from ab join pf on pf.auto_key = 'pricing:order:' || ab.id
         where abs(pf.amount - round(ab.amount * (select r from rate))) > 1 or pf.spent_on <> ab.checkin),
       case when (select count(*) from ab join pf on pf.auto_key = 'pricing:order:' || ab.id
         where abs(pf.amount - round(ab.amount * (select r from rate))) > 1 or pf.spent_on <> ab.checkin) = 0
            then '✅' else '❌' end
union all
select 6, '合計（對照 308 的 $593,553）',
       (select count(*) || ' 筆・$' || to_char(coalesce(sum(amount), 0), 'FM999,999,999') from pf),
       'ℹ 差一點是正常的：308 照住宿天數拆月，這次整張記入住月'
union all
select 7, '2026/09 入住的各物業（參考）',
       coalesce((select string_agg(x, '・' order by x) from (
                  select e.name || ' $' || to_char(sum(pf.amount), 'FM999,999') as x
                    from pf join public.estates e on e.id = pf.estate_id
                   where pf.spent_on >= '2026-09-01' and pf.spent_on < '2026-10-01' group by e.name) t), '（沒有）'),
       'ℹ'
union all
select 8, '沒掛物業的 Airbnb 訂單（不會長支出）',
       (select count(*)::text from public.orders where source = 'airbnb' and coalesce(amount, 0) > 0 and estate_id is null),
       'ℹ 不是 0 的話，補上物業就會自動長出來'
union all
select 9, '觸發器在不在',
       (select string_agg(tgname, ',') from pg_trigger where tgrelid = 'public.orders'::regclass and tgname = 'trg_order_pricing_fee'),
       case when exists (select 1 from pg_trigger where tgrelid = 'public.orders'::regclass and tgname = 'trg_order_pricing_fee')
            then '✅' else '❌' end
union all
select 10, '這支跑過了沒（schema_migrations）',
       coalesce((select name from public.schema_migrations where name = '311_pricing_fee_per_order'), '（沒記到）'),
       case when exists (select 1 from public.schema_migrations where name = '311_pricing_fee_per_order') then '✅' else '❌' end
order by 1;
