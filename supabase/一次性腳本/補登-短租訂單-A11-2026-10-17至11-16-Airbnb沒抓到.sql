/* ══════════════════════════════════════════════════════════════════════
 * 補登一筆短租訂單：A11、2026-10-17 ～ 11-16（30 晚）、Airbnb、$33,774.65 —— 同步沒抓到     2026-10-01
 *
 * 【為什麼】David：「訂單 Airbnb 沒抓到，A11 10/17-11/16 金額 33774.65，直接寫資料庫」。
 *
 * 【做什麼】
 *   · orders 加一列：source airbnb、房源 A11（物業跟著 A11 走）、imported_via manual、未收款
 *   · 營收認列由資料庫觸發器（orders_recognize）自動拆成 10 月／11 月，這裡不用寫
 *   · 訂單編號固定（不是時間戳），跑第二次 on conflict 不會多一筆
 *   · ★ 有 Airbnb 確認碼（HM 開頭那串）的話填進下面 v_code —— 之後同步會認得這一筆、不會再長一張。
 *     沒有就留 null，用手動編號。
 *
 * ★★ 自檢在 commit 後面 —— 看不到那張表就是整支回滾了。
 * ══════════════════════════════════════════════════════════ */

begin;

do $$
declare
  v_code text := null;                        -- ← 有 Airbnb 確認碼就填這裡，例如 'HMABCDEFGH'
  v_key  text;
  v_pid  uuid; v_eid uuid; n int;
begin
  select count(*) into n from public.properties where name = 'A11' and active;
  if n <> 1 then
    raise exception '在職房源「A11」有 % 列（要剛好 1）—— 整支停下來，一筆都沒寫', n;
  end if;
  select id, estate_id into v_pid, v_eid from public.properties where name = 'A11' and active;

  v_key := coalesce(v_code, 'PV_2026-10-17_A11_airbnb-missed_manual');

  insert into public.orders
    (order_key, source, estate_id, property_id, property_raw, guest_name,
     checkin, checkout, nights, amount, deposit, paid, imported_via, purpose_type, book, note)
  values
    (v_key, 'airbnb', v_eid, v_pid, 'A11', null,
     date '2026-10-17', date '2026-11-16', 30, 33774.65, 0, false, 'manual', 'estate', 'anxing',
     '補登：Airbnb 同步沒抓到（2026-10-01 David 指定）')
  on conflict (order_key) do nothing;
end $$;

commit;

-- ═══ 自檢（在 commit 後面 —— 看不到這張表就是整支回滾了） ═══════════
with o as (
  select * from public.orders
   where property_id = (select id from public.properties where name = 'A11' and active)
     and checkin = date '2026-10-17' and checkout = date '2026-11-16' and source = 'airbnb'
)
select 1 as 序, '這筆訂單' as 檢查,
       (select string_agg(order_key || '・' || property_raw || '・' || checkin || '～' || checkout || '・' || nights || ' 晚・$' || amount
                          || case when paid then '・已收' else '・未收' end, '；') from o) as 結果,
       case when (select count(*) from o) = 1 then '✅' when (select count(*) from o) = 0 then '❌ 沒寫進去' else '⚠ 有 ' || (select count(*) from o) || ' 筆同房同期間，重複了' end as 判定
union all
select 2, '營收認列（觸發器自動拆月）',
       (select string_agg(r.ym || '：' || r.month_nights || ' 晚 $' || round(r.month_amount, 2), '；' order by r.ym)
          from public.revenue_recognitions r where r.order_id in (select id from o)),
       case when (select coalesce(sum(r.month_amount), 0) from public.revenue_recognitions r where r.order_id in (select id from o)) between 33774.64 and 33774.66
            then '✅ 加起來等於訂單金額' else '❌ 認列加總 ≠ 33774.65' end
union all
select 3, 'A11 同期間還有沒有別的訂單（撞期）',
       coalesce((select string_agg(x.order_key || '・' || x.checkin || '～' || x.checkout || '・' || x.source, '；')
                   from public.orders x
                  where x.property_id = (select id from public.properties where name = 'A11' and active)
                    and x.id not in (select id from o)
                    and x.checkin < date '2026-11-16' and x.checkout > date '2026-10-17'
                    and x.source not in ('oneoff', 'airbnb_cancelled')), '沒有'),
       case when exists (select 1 from public.orders x
                          where x.property_id = (select id from public.properties where name = 'A11' and active)
                            and x.id not in (select id from o)
                            and x.checkin < date '2026-11-16' and x.checkout > date '2026-10-17'
                            and x.source not in ('oneoff', 'airbnb_cancelled'))
            then '⚠ 撞期，要看' else '✅' end
order by 1;
