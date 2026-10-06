/* ══════════════════════════════════════════════════════════════════════
 * migration_314：定期收費（洗衣機、烘衣機、垃圾代收⋯）進營收表的樣子                  2026-10-06
 *
 * 【為什麼】David：「這些都要進營收表 ——
 *   ① 日期：每月最後一天　② 客戶：洗衣機｜烘衣機｜楊特助清潔費｜垃圾代收
 *   ③ 其他收入・清潔費　④ 物業：時兆　⑤ 房源：整棟，若沒整棟就不要寫」
 *
 * 【查到的現況】定期收費本來就每月產一張一次性收入訂單（source=oneoff、imported_via=recurring），
 *   營收表也吃得到 —— 但長這樣：日期＝每月 1 號、客戶空白、房源空白。
 *   ③④ 本來就對（科目＝設定的「清潔費」、物業＝設定的物業），這支不動。
 *
 * 【做什麼】
 *   ① gen_recurring_orders() 改：
 *      · 入住／退房日 ＝ 那個月最後一天
 *      · 客戶（guest_name）＝ 項目名稱（洗衣機、垃圾代收⋯）
 *      · 房源：設定是「整棟」（沒指定房源）→ 去那個物業找名字有「整棟」的房源，**剛好一筆**才掛上；
 *              找不到（或不只一筆）→ 空著。設定有指定房源的照舊。
 *      · 「超出起訖月就清掉」改看 order_key 的月份（日期改成月底之後，用日期比會把當月誤刪）
 *   ② 已經產生的那些（含已收款的）一次補成新樣子。**已關帳的月份不動**，自檢列出幾筆。
 *   金額一律不碰 —— 逐月填的實際金額是這個機制最重要的一條。
 *
 * ★★ 自檢在 commit 後面 —— 看不到那張表就是整支回滾了。
 * ══════════════════════════════════════════════════════════ */

begin;

-- 共用：設定是整棟時，這個物業的「整棟」房源（剛好一筆才算）
create or replace function public.recurring_whole_property(p_estate uuid)
returns uuid language sql stable as $fn$
  select case when count(*) = 1 then min(p.id::text)::uuid end
    from public.properties p
   where p.estate_id = p_estate and p.name like '%整棟%' and coalesce(p.active, true);
$fn$;
comment on function public.recurring_whole_property(uuid) is
  '定期收費「整棟」要掛的房源：該物業名字含「整棟」的房源剛好一筆就回它，否則 null（房源留空）。migration_314。';

create or replace function public.gen_recurring_orders(rc public.recurring_charges)
 returns integer language plpgsql security definer as $fn$
declare
  ms date; last_ms date; me date; ymtxt text; n int := 0;
  v_pid uuid; v_praw text;
begin
  -- 停用或已刪的設定:把還沒收款的列清掉,已收款的留著(那是既成事實)
  if not rc.active then
    delete from orders
     where imported_via = 'recurring'
       and order_key like 'RC_' || rc.id || '_%'
       and paid = false;
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

-- ② 已產生的補成新樣子（含已收款的；已關帳月份跳過）
create temp table _fix on commit drop as
select o.id,
       (to_date(right(o.order_key, 6) || '01', 'YYYYMMDD') + interval '1 month' - interval '1 day')::date as me,
       rc.item_name,
       case when rc.property_id is not null then rc.property_id else public.recurring_whole_property(rc.estate_id) end as pid,
       rc.property_id is not null as fixed_room, rc.property_raw
  from public.orders o
  join public.recurring_charges rc on o.order_key like 'RC_' || rc.id || '_%'
 where o.imported_via = 'recurring'
   and right(o.order_key, 6) ~ '^[0-9]{6}$'
   and not public.is_period_locked(right(o.order_key, 6));

update public.orders o
   set checkin = f.me, checkout = f.me,
       guest_name = f.item_name,
       property_id = f.pid,
       property_raw = case when f.fixed_room then f.property_raw else (select name from public.properties where id = f.pid) end
  from _fix f
 where o.id = f.id
   and (o.checkin is distinct from f.me or o.checkout is distinct from f.me
        or o.guest_name is distinct from f.item_name or o.property_id is distinct from f.pid);

create temp table _n (k text, v text) on commit preserve rows;
insert into _n select '補了', count(*)::text from _fix;

do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('314_recurring_orders_month_end');
  end if;
end $do$;

commit;

-- ═══ 自檢（在 commit 後面 —— 看不到那張表就是整支回滾了） ═══════════
select 1 as 序, '定期收費的單：日期都是月底了（已關帳的不算）' as 檢查,
       (select count(*) filter (where checkin = (date_trunc('month', checkin) + interval '1 month' - interval '1 day')::date)
               || ' / ' || count(*) from public.orders
         where imported_via = 'recurring' and not public.is_period_locked(right(order_key, 6))) as 結果,
       case when not exists (select 1 from public.orders where imported_via = 'recurring'
                              and not public.is_period_locked(right(order_key, 6))
                              and checkin <> (date_trunc('month', checkin) + interval '1 month' - interval '1 day')::date)
            then '✅' else '❌' end as 判定
union all
select 2, '客戶欄 ＝ 項目（已關帳的不算）',
       (select count(*) filter (where guest_name = item_name) || ' / ' || count(*) from public.orders
         where imported_via = 'recurring' and not public.is_period_locked(right(order_key, 6))),
       case when not exists (select 1 from public.orders where imported_via = 'recurring'
                              and not public.is_period_locked(right(order_key, 6))
                              and guest_name is distinct from item_name) then '✅' else '❌' end
union all
select 3, '每個定期收費的房源（整棟找不到就空著）',
       coalesce((select string_agg(e.name || '・' || rc.item_name || ' → '
                   || coalesce((select name from public.properties where id = coalesce(rc.property_id, public.recurring_whole_property(rc.estate_id))), '（空）'),
                   '；' order by e.name, rc.item_name)
                   from public.recurring_charges rc join public.estates e on e.id = rc.estate_id where rc.active), '（沒有設定）'),
       'ℹ'
union all
select 4, '已關帳、這次沒動的月份（參考）',
       (select count(*) || ' 筆' from public.orders where imported_via = 'recurring' and public.is_period_locked(right(order_key, 6))),
       'ℹ'
union all
select 5, '時兆本月（營收表上會看到的）',
       coalesce((select string_agg(o.checkin || '・' || o.guest_name || '・' || o.fee_type || '・' || coalesce(o.property_raw, '（房源空）') || '・$' || o.amount::int, '；' order by o.guest_name)
                   from public.orders o join public.estates e on e.id = o.estate_id
                  where o.imported_via = 'recurring' and e.name = '時兆' and right(o.order_key, 6) = to_char(current_date, 'YYYYMM')), '（沒有）'),
       'ℹ'
order by 1;
