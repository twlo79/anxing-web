/* ══════════════════════════════════════════════════════════════════════
 * migration_315：定期收費拿掉「結束月」，停掉改用「啟用中」—— 而且停用不刪任何月份           2026-10-06
 *
 * 【為什麼】David 選 B：「不用結束月」。要停就把「啟用中」取消。
 *
 * 【★★★ 查到一個坑，這支一起修】
 *   原本「停用」會**刪掉所有還沒標收款的月份**。洗衣機、烘衣機每月填的金額多半沒有標收款 ——
 *   照舊寫法，取消勾選的那一刻，2025-01 起填的一年多收入會從營收表整批消失。
 *   → 改成：停用＝只是不再產生新的月份，已產生的全部留著。
 *     （刪掉整筆設定的行為不變：未收款的月份跟著刪，畫面上刪除前有確認視窗講清楚。）
 *
 * 【做什麼】
 *   ① gen_recurring_orders()：停用時不刪任何列，只是不產生（其他照 314）
 *   ② 啟用中的設定，結束月一律清空 —— 不然洗衣機、烘衣機設的 2026-12 會讓明年 1 月起靜靜地不再產生
 *      （停用中的留著，不影響）
 *
 * ★★ 自檢在 commit 後面 —— 看不到那張表就是整支回滾了。
 * ══════════════════════════════════════════════════════════ */

create temp table if not exists _e (item text, end_ym text) on commit preserve rows;

begin;
delete from _e;

create or replace function public.gen_recurring_orders(rc public.recurring_charges)
 returns integer language plpgsql security definer as $fn$
declare
  ms date; last_ms date; me date; ymtxt text; n int := 0;
  v_pid uuid; v_praw text;
begin
  -- 停用 ＝ 從下個月起不再產生（migration_315）。
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
  last_ms := date_trunc('month', current_date)::date;
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


-- ② 啟用中的結束月清空（先記下來給自檢看）
insert into _e select e.name || '・' || rc.item_name, rc.end_ym
  from public.recurring_charges rc join public.estates e on e.id = rc.estate_id
 where rc.active and rc.end_ym is not null;
update public.recurring_charges set end_ym = null where active and end_ym is not null;

do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('315_recurring_no_end_month');
  end if;
end $do$;

commit;

-- ═══ 自檢（在 commit 後面 —— 看不到那張表就是整支回滾了） ═══════════
select 1 as 序, '停用不再刪月份（函式新版）' as 檢查,
       case when pg_get_functiondef('public.gen_recurring_orders(public.recurring_charges)'::regprocedure) like '%migration_315%'
            then '新版' else '★ 還是舊的' end as 結果,
       case when pg_get_functiondef('public.gen_recurring_orders(public.recurring_charges)'::regprocedure) like '%migration_315%'
            then '✅' else '❌' end as 判定
union all
select 2, '這次清掉結束月的設定',
       coalesce((select string_agg(item || '（原本到 ' || end_ym || '）', '；' order by item) from _e), '（沒有）'), 'ℹ'
union all
select 3, '啟用中還有結束月的（要 0）',
       (select count(*)::text from public.recurring_charges where active and end_ym is not null),
       case when not exists (select 1 from public.recurring_charges where active and end_ym is not null) then '✅' else '❌' end
order by 1;
