/* ══════════════════════════════════════════════════════════════════════
 * migration_316：定期收費每月自動產生（不用再按「補產到本月」）                         2026-10-06
 *
 * 【為什麼】David：「每月結一次洗衣機等費用，會自動聯到營收」。
 *   原本新的月份只有在「改設定」或「按補產到本月」時才會長出來 —— 沒人按，營收表那個月就沒有。
 *
 * 【做什麼】
 *   ① 排程：每天台北 00:05 跑 rebuild_recurring_orders()（冪等：只補缺的月份，已填的金額不會被蓋）
 *      → 每月 1 號一過午夜，新月份就出現在定期收費與營收表，金額先是收入金額（變動的是 0，等月結再填）
 *      每天跑而不是每月 1 號跑一次：哪天排程沒跑到，隔天自己補上
 *   ② gen_recurring_orders() 的「本月」改看台北日期（資料庫是 UTC，不改的話 1 號早上 8 點前還長不出來）
 *
 * ★★ 自檢在 commit 後面 —— 看不到那張表就是整支回滾了。
 * ══════════════════════════════════════════════════════════ */

begin;

create or replace function public.gen_recurring_orders(rc public.recurring_charges)
 returns integer language plpgsql security definer as $fn$
declare
  ms date; last_ms date; me date; ymtxt text; n int := 0;
  v_pid uuid; v_praw text;
begin
  -- 停用 ＝ 從下個月起不再產生（migration_315；316 改看台北日期）。
  -- ★★ 已產生的月份**一筆都不刪** —— 洗衣機那些逐月填的金額多半沒標收款，
  --    舊寫法「停用就清掉沒收款的」會把一年多的實際收入整批刪掉。
  if not rc.active then
    return 0;
  end if;

  -- 房源：有指定就用指定的；整棟 → 找那個物業的「整棟」房源，找不到就空著（migration_314）
  if rc.property_id is not null then
    v_pid := rc.property_id; v_praw := rc.property_raw;
  else
    v_pid := public.recurring_whole_property(rc.estate_id);
    select name into v_praw from properties where id = v_pid;
  end if;

  ms := to_date(rc.start_ym || '01', 'YYYYMMDD');
  -- 只產到本月。end_ym 有設就取比較早的那個。
  -- ★ 台北的這個月（migration_316）。資料庫時鐘是 UTC：台北 11/1 00:05 時 UTC 還是 10/31，用 current_date 會晚 8 小時才長出新月份
  last_ms := date_trunc('month', (now() at time zone 'Asia/Taipei')::date)::date;
  if rc.end_ym is not null then
    last_ms := least(last_ms, to_date(rc.end_ym || '01', 'YYYYMMDD'));
  end if;

  -- 超出範圍、還沒收款的先清掉（改了起訖月會用到）。★ 看 order_key 的月份，不看日期（日期現在是月底）
  delete from orders
   where imported_via = 'recurring'
     and order_key like 'RC_' || rc.id || '_%'
     and paid = false
     and (right(order_key, 6) < to_char(ms, 'YYYYMM') or right(order_key, 6) > to_char(last_ms, 'YYYYMM'));

  while ms <= last_ms loop
    ymtxt := to_char(ms, 'YYYYMM');
    me := (ms + interval '1 month' - interval '1 day')::date;    -- 那個月最後一天
    insert into orders (order_key, source, estate_id, property_id, property_raw, guest_name,
      checkin, checkout, nights, amount, deposit, fee_type, item_name, note, imported_via, paid)
    values ('RC_' || rc.id || '_' || ymtxt, 'oneoff', rc.estate_id, v_pid, v_praw,
      rc.item_name, me, me, 0, rc.amount, 0, rc.fee_type, rc.item_name, rc.note, 'recurring', false)
    on conflict (order_key) do update
      set fee_type = excluded.fee_type,
          item_name = excluded.item_name,
          estate_id = excluded.estate_id,
          property_id = excluded.property_id,
          property_raw = excluded.property_raw,
          guest_name = excluded.guest_name,
          checkin = excluded.checkin,
          checkout = excluded.checkout
      -- **金額刻意不覆蓋。** 使用者改過的當月實際金額不能被設定的預設值蓋掉。
      -- 已關帳的月份不動（migration_314）。
      where orders.imported_via = 'recurring' and orders.paid = false
        and not public.is_period_locked(right(orders.order_key, 6));
    n := n + 1;
    ms := (ms + interval '1 month')::date;
  end loop;
  return n;
end $fn$;



-- ① 排程
do $$
begin
  perform cron.unschedule(jobid) from cron.job where jobname = 'recurring_orders_daily';
  perform cron.schedule(
    'recurring_orders_daily',
    '5 16 * * *',                      -- 16:05 UTC = 台北 00:05
    $cron$select public.rebuild_recurring_orders()$cron$
  );
end $$;

-- 現在先補一次
select public.rebuild_recurring_orders();

do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('316_recurring_orders_cron');
  end if;
end $do$;

commit;

-- ═══ 自檢（在 commit 後面 —— 看不到那張表就是整支回滾了） ═══════════
select 1 as 序, '排程在（每天台北 00:05）' as 檢查,
       coalesce((select jobname || '・' || schedule || '・' || case when active then '啟用' else '停用' end
                   from cron.job where jobname = 'recurring_orders_daily'), '★ 沒有') as 結果,
       case when exists (select 1 from cron.job where jobname = 'recurring_orders_daily' and active) then '✅' else '❌' end as 判定
union all
select 2, '「本月」看台北日期（函式新版）',
       case when pg_get_functiondef('public.gen_recurring_orders(public.recurring_charges)'::regprocedure) like '%Asia/Taipei%'
            then '新版' else '★ 還是舊的' end,
       case when pg_get_functiondef('public.gen_recurring_orders(public.recurring_charges)'::regprocedure) like '%Asia/Taipei%'
            then '✅' else '❌' end
union all
select 3, '每個啟用中的設定，這個月都有一筆（要 0 筆缺）',
       coalesce((select string_agg(e.name || '・' || rc.item_name, '；')
                   from public.recurring_charges rc join public.estates e on e.id = rc.estate_id
                  where rc.active and rc.start_ym <= to_char((now() at time zone 'Asia/Taipei')::date, 'YYYYMM')
                    and not exists (select 1 from public.orders o
                                     where o.order_key = 'RC_' || rc.id || '_' || to_char((now() at time zone 'Asia/Taipei')::date, 'YYYYMM'))),
                '都有'),
       case when exists (select 1 from public.recurring_charges rc
                          where rc.active and rc.start_ym <= to_char((now() at time zone 'Asia/Taipei')::date, 'YYYYMM')
                            and not exists (select 1 from public.orders o
                                             where o.order_key = 'RC_' || rc.id || '_' || to_char((now() at time zone 'Asia/Taipei')::date, 'YYYYMM')))
            then '❌' else '✅' end
order by 1;
