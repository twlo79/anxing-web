/* ══════════════════════════════════════════════════════════════════════
 * migration_306：固定加費一個月一張，不再跟主約的繳別；月份照契約起租日切（跟月租單同一條線）    2026-10-01
 *
 * 【為什麼】David：「固定加費一期是一個月，不要讀到主約的期別」。
 *   線上一張年繳契約（2026-08-17 ～ 2027-08-16）底下：
 *     管理費 7,953 → 13 張、一個月一張（2026-08 … 2027-08）
 *     管理費 1,000 → 2 張（2026-08、2027-08）—— 106 讓加費跟主約繳別走，年繳一年一張
 *   同一張契約、同一種費用、兩種節奏。而且兩邊都多了 2027-08：租期 8/17～8/16 剛好 12 個月，
 *   用「碰到的自然月」去數會數成 13（8 月碰到兩次），年繳再把第 13 個月當成第 2 期。
 *
 * 【改成什麼】重寫 gen_contract_fee_orders()：
 *   · 一個月一張，不看 cadence
 *   · 月份照契約起租日切：8/17 起租 → 8/17、9/17、…、隔年 7/17，到 end_date 為止（跟 migration_298 月租單一樣）
 *     → 12 個月的約就是 12 張，費用日 ＝ 那個月的起日，收款頁「第 N 期」用日期算就會剛好包進去
 *   · 訂單編號還是 CRC_<設定id>_<YYYYMM>（YYYYMM ＝ 那個月起日的年月），既有的對得上
 *   · 設定的 start_ym／end_ym 照 YYYYMM 比對（包含）
 *   · 不在新清單裡的**未收**費用單刪掉（2027-08 那種）；已收的一律不動（錢收了是既成事實）
 *   · 既有的（含已收）只把費用日對齊到起日（同一個月，營收認列的月份不變）；金額只改未收的
 *   然後把所有設定重跑一次。
 *
 * 【風險，講在前面】106 的設計是「年繳契約填 3,000 ＝ 一年收 3,000」。改回每月之後，
 *   那種契約會變成一年 12 張 × 3,000。自檢第 3 列把非月繳契約的加費全部列出來 —— 金額要是「每月」的數字，
 *   不是的話到契約裡把每月金額改掉（未收的會跟著重算）。
 *
 * ★★ 自檢在 commit 後面 —— 看不到那張表就是整支回滾了。
 * ══════════════════════════════════════════════════════════ */

begin;

create or replace function public.gen_contract_fee_orders(rc public.contract_recurring_charges)
returns integer
language plpgsql security definer set search_path = public as $fn$
declare
  ct        public.contracts;
  lease_end date;                  -- 排他：end_date 是含當日，跟月租單（298）同一個定義
  p_start   date;                  -- 這個月的起日（8/17、9/17 …）
  ymtxt     text;
  keys      text[] := '{}';
  n         int := 0;
begin
  select * into ct from contracts where id = rc.contract_id;

  -- 契約沒了、沒租期、設定停用 → 未收款的清掉、已收的留著（跟 86／106 一樣）
  if not found or ct.start_date is null or ct.end_date is null or not rc.active then
    delete from orders
     where imported_via = 'contract_fee'
       and left(order_key, length('CRC_' || rc.id || '_')) = 'CRC_' || rc.id || '_'
       and paid = false;
    return 0;
  end if;

  /*
   * ★ 固定加費一個月一張，不看 ct.cadence（2026-10-01 David 指定；取代 106 的「跟著繳別」）。
   *   月份照起租日切，不是自然月 —— 8/17～8/16 的約是 12 個月，不是 13。
   */
  lease_end := (ct.end_date + 1)::date;
  p_start   := ct.start_date;
  while p_start < lease_end loop
    ymtxt := to_char(p_start, 'YYYYMM');
    if (ymtxt >= rc.start_ym) and (rc.end_ym is null or ymtxt <= rc.end_ym) then
      keys := keys || ('CRC_' || rc.id || '_' || ymtxt);
      insert into orders (order_key, source, estate_id, property_raw, guest_name,
        checkin, checkout, nights, amount, deposit, fee_type, item_name, note,
        imported_via, contract_id, paid)
      values ('CRC_' || rc.id || '_' || ymtxt, 'oneoff', ct.estate_id, ct.room, ct.tenant_name,
        p_start, p_start, 0, rc.amount, 0, rc.fee_type, rc.item_name, coalesce(rc.note, '契約固定加費'),
        'contract_fee', ct.id, false)
      on conflict (order_key) do update
        set fee_type     = excluded.fee_type,
            item_name    = excluded.item_name,
            estate_id    = excluded.estate_id,
            property_raw = excluded.property_raw,
            guest_name   = excluded.guest_name,
            -- 費用日對齊到起日：同一個月，認列月份不變；已收的也對齊（只是日期）
            checkin      = excluded.checkin,
            checkout     = excluded.checkout,
            -- 金額只改未收款的 —— 錢收了之後金額是既成事實
            amount       = case when orders.paid then orders.amount else excluded.amount end
        where orders.imported_via = 'contract_fee';
      n := n + 1;
    end if;
    p_start := (p_start + interval '1 month')::date;
  end loop;

  -- 不在清單裡的未收款費用單清掉（改了起訖、13 個月那種、106 留下的期中月份）。已收的留著。
  delete from orders o
   where o.imported_via = 'contract_fee'
     and left(o.order_key, length('CRC_' || rc.id || '_')) = 'CRC_' || rc.id || '_'
     and o.paid = false
     and not (o.order_key = any(keys));
  return n;
end $fn$;

comment on function public.gen_contract_fee_orders is
  '固定加費一個月一張，不看契約繳別；月份照起租日切（8/17 起租 → 每月 17 日），到 end_date 為止。'
  'migration_306（2026-10-01）取代 106 的「跟著繳別一期一張」。已收款的費用單一律不動。';

-- 全量重跑：觸發器只在設定或契約變動時跑，既有的要主動重產
do $$
declare r public.contract_recurring_charges; n int := 0;
begin
  for r in select rc.* from public.contract_recurring_charges rc
            join public.contracts c on c.id = rc.contract_id
           where c.active loop
    perform public.gen_contract_fee_orders(r);
    n := n + 1;
  end loop;
  raise notice '已重產 % 筆固定加費設定', n;
end $$;

do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('306_contract_fee_monthly');
  end if;
end $do$;

commit;

-- ═══ 自檢（在 commit 後面 —— 看不到這張表就是整支回滾了） ═══════════
with rc as (
  select rc.id, rc.amount, rc.fee_type, rc.start_ym, rc.end_ym, c.room, c.tenant_name, c.start_date, c.end_date, c.cadence,
         -- 這份設定該有幾個月：起租日逐月走到 end_date，再套 start_ym/end_ym
         (select count(*) from generate_series(c.start_date, c.end_date, interval '1 month') g
           where to_char(g, 'YYYYMM') >= rc.start_ym and (rc.end_ym is null or to_char(g, 'YYYYMM') <= rc.end_ym)) as want_n,
         (select count(*) from public.orders o where o.imported_via = 'contract_fee'
            and left(o.order_key, length('CRC_' || rc.id || '_')) = 'CRC_' || rc.id || '_') as have_n,
         (select count(*) from public.orders o where o.imported_via = 'contract_fee'
            and left(o.order_key, length('CRC_' || rc.id || '_')) = 'CRC_' || rc.id || '_' and o.paid) as paid_n
    from public.contract_recurring_charges rc join public.contracts c on c.id = rc.contract_id
   where c.active and rc.active
)
select 1 as 序, '母體：啟用中的固定加費設定' as 檢查, (select count(*)::text from rc) as 結果,
       case when (select count(*) from rc) = 0 then '⚠ 沒有東西可檢查，下面全部不算數' else 'ℹ' end as 判定
union all
select 2, '每份設定的費用單張數 ＝ 該收的月數（差的列出來）',
       coalesce((select string_agg(room || ' ' || fee_type || ' $' || amount || '：有 ' || have_n || '／該 ' || want_n || '（已收 ' || paid_n || '）', '；')
                   from rc where have_n <> want_n), '全部一致'),
       case when exists (select 1 from rc where have_n <> want_n)
            then '⚠ 多的那幾張是已收的（刪不得）——看一下' else '✅' end
union all
select 3, '非月繳契約的加費（金額要是「每月」的數字）',
       coalesce((select string_agg(room || '・' || tenant_name || '・' || cadence || '・' || fee_type || ' $' || amount || '／月', '；' order by room)
                   from rc where cadence <> 'monthly'), '沒有'),
       'ℹ 不是每月的數字就去契約裡改'
union all
select 4, '8/17 起租那張（7,953 與 1,000）現在各幾張',
       coalesce((select string_agg(fee_type || ' $' || amount || '：' || have_n || ' 張（已收 ' || paid_n || '）', '；')
                   from rc where start_date = date '2026-08-17' and amount in (7953, 1000)), '（找不到那張契約）'),
       case when (select count(*) from rc where start_date = date '2026-08-17' and amount in (7953, 1000) and have_n = 12) = 2
            then '✅ 都是 12' else 'ℹ 看結果' end
union all
select 5, '函式換成 306 的版本了',
       case when position('不看 ct.cadence' in pg_get_functiondef('public.gen_contract_fee_orders(public.contract_recurring_charges)'::regprocedure)) > 0
            then '是' else '否' end,
       case when position('不看 ct.cadence' in pg_get_functiondef('public.gen_contract_fee_orders(public.contract_recurring_charges)'::regprocedure)) > 0
            then '✅' else '❌' end
union all
select 6, '這支跑過了沒（schema_migrations）',
       coalesce((select name from public.schema_migrations where name = '306_contract_fee_monthly'), '（沒記到）'),
       case when exists (select 1 from public.schema_migrations where name = '306_contract_fee_monthly') then '✅' else '❌' end
order by 1;
