/* ══════════════════════════════════════════════════════════════════════
 * migration_308：調價軟體支出 —— 每月 × 每物業，Airbnb 訂單營收 × 1.5%                       2026-10-02
 *
 * 【為什麼】David：「每月底出一個支出，以物業做計算；住房日當作當月算法；物業下所有 Airbnb 訂單 × 1.5%
 *   變成調價軟體的支出」。決定（同日）：
 *     · 乘的是訂單金額（實收＋搭檔）
 *     · 從有 Airbnb 訂單的第一個月開始補
 *     · 會計科目 service 專業服務費
 *
 * 【怎麼算】那個月、那個物業，所有 Airbnb 訂單的「營收認列」加總 × 1.5%。
 *   營收認列本來就照住宿天數把一張訂單拆到各月（8/28～9/30 的單：8 月 4 晚、9 月 30 晚），
 *   所以「住房日算進當月」不用另外算。取消收入（source = oneoff）不算。
 *
 * 【做什麼】
 *   ① expenses 加 auto_key（系統產生的支出用它認自己；唯一索引，**不是** partial —— 221 那條坑）
 *   ② work_settings 加 pricing_fee_rate（預設 0.015）—— 費率改了不用再寫 migration
 *   ③ gen_pricing_fee_expenses(ym)：一個月重算一次，一個物業一筆，日期記月底；
 *      金額變了就更新、那個月沒營收了就刪；那個月已關帳就一筆都不碰
 *   ④ 從第一個有 Airbnb 營收的月份補到上個月
 *   ⑤ 每天台北 00:10 重算「上個月」—— 月初產生，月中有人改訂單也會跟著改，直到那個月關帳
 *
 * ★★ 自檢在 commit 後面 —— 看不到那張表就是整支回滾了。
 * ══════════════════════════════════════════════════════════ */

begin;

-- ① 系統產生的支出用 auto_key 認自己
alter table public.expenses add column if not exists auto_key text;
comment on column public.expenses.auto_key is
  '系統自動產生的支出的鍵（例 pricing:<物業id>:<ym>）。人手 key 的是 null。唯一索引不是 partial —— PostgREST 的 upsert 對不到 partial（migration_221）。';
create unique index if not exists expenses_auto_key_uniq on public.expenses (auto_key);

-- ② 費率
alter table public.work_settings add column if not exists pricing_fee_rate numeric not null default 0.015;
comment on column public.work_settings.pricing_fee_rate is '調價軟體費率：物業 Airbnb 營收 × 這個數（migration_308）。';

-- ③ 一個月重算一次
create or replace function public.gen_pricing_fee_expenses(p_ym text)
returns integer
language plpgsql security definer set search_path = public as $fn$
declare
  v_rate numeric;
  v_end  date;
  n int := 0;
  k int;
begin
  if p_ym !~ '^[0-9]{6}$' then raise exception 'ym 要六碼，收到 %', p_ym; end if;
  -- 關帳的月份一筆都不碰（跟訂單的關帳守衛同一個判斷）
  if public.is_period_locked(p_ym) then return 0; end if;

  select coalesce(pricing_fee_rate, 0.015) into v_rate from public.work_settings where id = 1;
  v_rate := coalesce(v_rate, 0.015);
  v_end  := (to_date(p_ym || '01', 'YYYYMMDD') + interval '1 month' - interval '1 day')::date;

  create temp table if not exists _pf (estate_id uuid, rev numeric, n_orders int, amt numeric) on commit drop;
  delete from _pf;
  insert into _pf
  select r.estate_id, sum(r.month_amount), count(distinct r.order_id), round(sum(r.month_amount) * v_rate)
    from public.revenue_recognitions r
   where r.source = 'airbnb' and r.ym = p_ym and r.estate_id is not null
   group by r.estate_id
  having round(sum(r.month_amount) * v_rate) > 0;

  insert into public.expenses
    (spent_on, item_name, amount, account_code, purpose_type, estate_id, note, auto_key)
  select v_end,
         '調價軟體 ' || substr(p_ym, 1, 4) || '/' || substr(p_ym, 5, 2),
         f.amt, 'service', 'estate', f.estate_id,
         'Airbnb 營收 ' || to_char(round(f.rev), 'FM999,999,999') || ' × ' || rtrim(rtrim((v_rate * 100)::text, '0'), '.') || '%（' || f.n_orders || ' 張訂單，照住宿天數算進當月）・系統每天重算到關帳',
         'pricing:' || f.estate_id || ':' || p_ym
    from _pf f
  on conflict (auto_key) do update
     set amount = excluded.amount, note = excluded.note, spent_on = excluded.spent_on
   where public.expenses.amount is distinct from excluded.amount
      or public.expenses.note   is distinct from excluded.note;
  get diagnostics k = row_count; n := n + k;

  -- 那個月某物業已經沒有 Airbnb 營收了（訂單刪了／搬走了）→ 那筆系統支出拿掉
  delete from public.expenses e
   where e.auto_key like 'pricing:%:' || p_ym
     and not exists (select 1 from _pf f where e.auto_key = 'pricing:' || f.estate_id || ':' || p_ym);
  get diagnostics k = row_count; n := n + k;
  return n;
end $fn$;

comment on function public.gen_pricing_fee_expenses(text) is
  '調價軟體支出：那個月每個物業 Airbnb 營收認列 × work_settings.pricing_fee_rate，一個物業一筆、日期記月底。'
  '冪等；關帳月份不碰。每天 pg_cron 重算上個月（migration_308）。';

-- ④ 從第一個有 Airbnb 營收的月份補到上個月
create temp table _bf (ym text, changed int) on commit preserve rows;
do $$
declare
  v_from text; v_to text; y text; c int;
begin
  select min(ym) into v_from from public.revenue_recognitions where source = 'airbnb';
  v_to := to_char((now() at time zone 'Asia/Taipei')::date - interval '1 month', 'YYYYMM');
  if v_from is null then return; end if;
  y := v_from;
  while y <= v_to loop
    c := public.gen_pricing_fee_expenses(y);
    insert into _bf values (y, c);
    y := to_char(to_date(y || '01', 'YYYYMMDD') + interval '1 month', 'YYYYMM');
  end loop;
end $$;

-- ⑤ 每天台北 00:10 重算上個月
do $$
begin
  perform cron.unschedule(jobid) from cron.job where jobname = 'pricing_fee_daily';
  perform cron.schedule(
    'pricing_fee_daily',
    '10 16 * * *',                     -- 16:10 UTC = 台北 00:10
    $cron$select public.gen_pricing_fee_expenses(to_char((now() at time zone 'Asia/Taipei')::date - interval '1 month', 'YYYYMM'))$cron$
  );
end $$;

do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('308_pricing_fee_expenses');
  end if;
end $do$;

commit;

-- ═══ 自檢（在 commit 後面 —— 看不到那張表就是整支回滾了） ═══════════
with pf as (select * from public.expenses where auto_key like 'pricing:%')
select 1 as 序, '母體：有 Airbnb 營收的月份' as 檢查,
       (select count(*)::text from _bf) || ' 個月（' || coalesce((select min(ym) || '～' || max(ym) from _bf), '—') || '）' as 結果,
       case when (select count(*) from _bf) = 0 then '⚠ 一個月都沒有，下面全部不算數' else 'ℹ' end as 判定
union all
select 2, '產生的調價軟體支出',
       (select count(*) || ' 筆・合計 $' || to_char(coalesce(sum(amount), 0), 'FM999,999,999') from pf),
       case when (select count(*) from pf) > 0 then '✅' else '❌' end
union all
select 3, '每一筆 ＝ 那個月那個物業 Airbnb 營收 × 費率（差超過 1 元的筆數，要 0）',
       (select count(*)::text from pf p
         where abs(p.amount - round((select coalesce(sum(r.month_amount), 0) from public.revenue_recognitions r
                                      where r.source = 'airbnb' and r.estate_id = p.estate_id
                                        and r.ym = split_part(p.auto_key, ':', 3))
                                    * (select pricing_fee_rate from public.work_settings where id = 1))) > 1),
       case when (select count(*) from pf p
         where abs(p.amount - round((select coalesce(sum(r.month_amount), 0) from public.revenue_recognitions r
                                      where r.source = 'airbnb' and r.estate_id = p.estate_id
                                        and r.ym = split_part(p.auto_key, ':', 3))
                                    * (select pricing_fee_rate from public.work_settings where id = 1))) > 1) = 0 then '✅' else '❌' end
union all
select 4, '2026/09 各物業（對照查詢第 ④ 段）',
       coalesce((select string_agg(e.name || ' $' || to_char(p.amount, 'FM999,999'), '・' order by e.name)
                   from pf p join public.estates e on e.id = p.estate_id where p.auto_key like '%:202609'), '（沒有）'),
       'ℹ'
union all
select 5, '關帳月份沒補的',
       coalesce((select string_agg(ym, '、' order by ym) from _bf where public.is_period_locked(ym)), '沒有'),
       'ℹ 關帳的不碰；要補請會計開鎖後再跑 gen_pricing_fee_expenses(''YYYYMM'')'
union all
select 6, '沒掛物業的 Airbnb 營收（不會長支出）',
       coalesce((select count(distinct order_id) || ' 張訂單・$' || to_char(round(sum(month_amount)), 'FM999,999,999')
                   from public.revenue_recognitions where source = 'airbnb' and estate_id is null), '0'),
       'ℹ'
union all
select 7, '每天重算的排程',
       coalesce((select schedule || '・' || command from cron.job where jobname = 'pricing_fee_daily'), '（沒有）'),
       case when exists (select 1 from cron.job where jobname = 'pricing_fee_daily') then '✅' else '❌' end
union all
select 8, '再跑一次上個月，應該 0 筆變動（冪等）',
       public.gen_pricing_fee_expenses(to_char((now() at time zone 'Asia/Taipei')::date - interval '1 month', 'YYYYMM'))::text,
       'ℹ 是 0 就對'
union all
select 9, '這支跑過了沒（schema_migrations）',
       coalesce((select name from public.schema_migrations where name = '308_pricing_fee_expenses'), '（沒記到）'),
       case when exists (select 1 from public.schema_migrations where name = '308_pricing_fee_expenses') then '✅' else '❌' end
order by 1;
