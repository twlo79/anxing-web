/* ══════════════════════════════════════════════════════════════════════
 * 補登兩筆短租訂單（Airbnb 同步沒抓到）                                                      2026-10-01
 *
 *   A11  2026-10-17 ～ 11-16  30 晚  $33,774.65   客人不詳
 *   A02  2026-08-06 ～ 09-04  29 晚  $25,437.79   Daniel Aryee（2 位）—— 照 Airbnb 後台截圖
 *
 * 【做什麼】
 *   · orders 各加一列：source airbnb、房源與物業跟著主檔走、imported_via manual、未收款
 *   · 營收認列由觸發器（orders_recognize）自動拆月，這裡不用寫
 *   · 訂單編號固定，跑第二次 on conflict 不會多一筆 —— A11 那張卡已經跑過的話，這支會直接跳過它
 *   · ★ 有 Airbnb 確認碼（HM 開頭）就填在下面 values 的第 3 欄，之後同步會認得這筆、不會再長一張；沒有留 null
 *
 * ★★ 自檢在 commit 後面 —— 看不到那張表就是整支回滾了。
 * ══════════════════════════════════════════════════════════ */

begin;

do $$
declare
  r record; v_pid uuid; v_eid uuid; n int;
begin
  for r in select * from (values
      --  房源,  客人,            確認碼（有就填 'HM…'）, 入住,              退房,              晚, 金額
      ('A11', null::text,     null::text, date '2026-10-17', date '2026-11-16', 30, 33774.65),
      ('A02', 'Daniel Aryee', null::text, date '2026-08-06', date '2026-09-04', 29, 25437.79)
    ) as t(room, guest, code, ci, co, nights, amount)
  loop
    select count(*) into n from public.properties where name = r.room and active;
    if n <> 1 then
      raise exception '在職房源「%」有 % 列（要剛好 1）—— 整支停下來，一筆都沒寫', r.room, n;
    end if;
    if r.co - r.ci <> r.nights then
      raise exception '% 的晚數對不上：% ～ % 是 % 晚，不是 %', r.room, r.ci, r.co, r.co - r.ci, r.nights;
    end if;
    select id, estate_id into v_pid, v_eid from public.properties where name = r.room and active;

    insert into public.orders
      (order_key, source, estate_id, property_id, property_raw, guest_name,
       checkin, checkout, nights, amount, deposit, paid, imported_via, purpose_type, book, note)
    values
      (coalesce(r.code, 'PV_' || r.ci || '_' || r.room || '_airbnb-missed_manual'),
       'airbnb', v_eid, v_pid, r.room, r.guest,
       r.ci, r.co, r.nights, r.amount, 0, false, 'manual', 'estate', 'anxing',
       '補登：Airbnb 同步沒抓到（2026-10-01 David 指定）')
    on conflict (order_key) do nothing;
  end loop;
end $$;

commit;

-- ═══ 自檢（在 commit 後面 —— 看不到那張表就是整支回滾了） ═══════════
with want(room, ci, co, amount) as (values ('A11', date '2026-10-17', date '2026-11-16', 33774.65),
                                           ('A02', date '2026-08-06', date '2026-09-04', 25437.79)),
o as (
  select w.room, w.amount as want_amt, x.*
    from want w
    join public.properties p on p.name = w.room and p.active
    left join public.orders x on x.property_id = p.id and x.checkin = w.ci and x.checkout = w.co and x.source = 'airbnb'
)
select 1 as 序, o.room || ' 這筆訂單' as 檢查,
       coalesce(string_agg(o.order_key || '・' || coalesce(o.guest_name, '客人不詳') || '・' || o.checkin || '～' || o.checkout || '・' || o.nights || ' 晚・$' || o.amount
                           || case when o.paid then '・已收' else '・未收' end, '；'), '❌ 沒寫進去') as 結果,
       case when count(o.id) = 1 then '✅' when count(o.id) = 0 then '❌ 沒寫進去' else '⚠ 有 ' || count(o.id) || ' 筆同房同期間，重複了' end as 判定
  from o group by o.room
union all
select 2, o.room || ' 營收認列（觸發器自動拆月）',
       (select string_agg(r.ym || '：' || r.month_nights || ' 晚 $' || round(r.month_amount, 2), '；' order by r.ym)
          from public.revenue_recognitions r where r.order_id = o.id),
       case when (select coalesce(sum(r.month_amount), 0) from public.revenue_recognitions r where r.order_id = o.id) between o.want_amt - 0.01 and o.want_amt + 0.01
            then '✅ 加起來等於訂單金額' else '❌ 認列加總 ≠ 訂單金額' end
  from o
union all
select 3, o.room || ' 同期間有沒有別的訂單（撞期）',
       coalesce((select string_agg(x.order_key || '・' || coalesce(x.guest_name, '') || '・' || x.checkin || '～' || x.checkout || '・' || x.source, '；')
                   from public.orders x
                  where x.property_id = o.property_id and x.id <> o.id
                    and x.checkin < o.checkout and x.checkout > o.checkin
                    and x.source not in ('oneoff', 'airbnb_cancelled')), '沒有'),
       case when exists (select 1 from public.orders x
                          where x.property_id = o.property_id and x.id <> o.id
                            and x.checkin < o.checkout and x.checkout > o.checkin
                            and x.source not in ('oneoff', 'airbnb_cancelled'))
            then '⚠ 撞期，要看 —— 可能這筆早就以別的樣子進來了' else '✅' end
  from o
order by 1, 2;
