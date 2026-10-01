/* ══════════════════════════════════════════════════════════════════════
 * 補登一筆短租訂單（Airbnb 沒抓到）：A02、Ryan Hansen、2026-11-09 ～ 12-08、29 晚、$41,019.68     2026-10-01
 *
 * 【為什麼】David 給 Airbnb 後台截圖：Confirmed・1 guest・29 nights・Total Payout $41,019.68 TWD。
 *
 * 【做什麼】
 *   · ★ 先查再補：A02 同一段期間已經有 Airbnb 訂單（同步其實有抓到）就**不寫**，自檢會列出那筆
 *     —— 上次 A02 那筆就是這樣補出一張重複的。
 *   · 沒有才寫一列：source airbnb、未收款、imported_via manual；營收認列由觸發器自動拆 11 月／12 月
 *   · 訂單編號固定，跑第二次不會多一筆
 *   · 有 Airbnb 確認碼（HM 開頭）就填下面 v_code，之後同步會認得這筆
 *
 * ★★ 自檢在 commit 後面 —— 看不到那張表就是整支回滾了。
 * ══════════════════════════════════════════════════════════ */

begin;

do $$
declare
  v_code text := null;                                   -- ← 有確認碼填這裡，例如 'HMABCDEFGH'
  v_room text := 'A02'; v_guest text := 'Ryan Hansen';
  v_ci date := date '2026-11-09'; v_co date := date '2026-12-08'; v_nights int := 29; v_amt numeric := 41019.68;
  v_pid uuid; v_eid uuid; n int;
begin
  select count(*) into n from public.properties where name = v_room and active;
  if n <> 1 then raise exception '在職房源「%」有 % 列（要剛好 1）—— 整支停下來', v_room, n; end if;
  if v_co - v_ci <> v_nights then raise exception '晚數對不上：% ～ % 是 % 晚，不是 %', v_ci, v_co, v_co - v_ci, v_nights; end if;
  select id, estate_id into v_pid, v_eid from public.properties where name = v_room and active;

  -- ★ 同房、期間重疊、Airbnb 來源的已經有 → 不寫（看自檢第 2 列）
  if exists (select 1 from public.orders o
              where o.property_id = v_pid and o.source = 'airbnb'
                and o.checkin < v_co and o.checkout > v_ci) then
    raise notice '已有重疊的 Airbnb 訂單，不補';
    return;
  end if;

  insert into public.orders
    (order_key, source, estate_id, property_id, property_raw, guest_name,
     checkin, checkout, nights, amount, deposit, paid, imported_via, purpose_type, book, note)
  values
    (coalesce(v_code, 'PV_' || v_ci || '_' || v_room || '_airbnb-missed_manual'),
     'airbnb', v_eid, v_pid, v_room, v_guest,
     v_ci, v_co, v_nights, v_amt, 0, false, 'manual', 'estate', 'anxing',
     '補登：Airbnb 同步沒抓到（2026-10-01 David 指定）')
  on conflict (order_key) do nothing;
end $$;

commit;

-- ═══ 自檢（在 commit 後面 —— 看不到這張表就是整支回滾了） ═══════════
with p as (select id from public.properties where name = 'A02' and active),
o as (select * from public.orders where property_id = (select id from p) and source = 'airbnb'
        and checkin < date '2026-12-08' and checkout > date '2026-11-09')
select 1 as 序, 'A02 11/9～12/8 這段期間的 Airbnb 訂單' as 檢查,
       coalesce((select string_agg(order_key || '・' || coalesce(guest_name, '?') || '・' || checkin || '～' || checkout || '・' || nights || ' 晚・$' || amount
                                   || case when paid then '・已收' else '・未收' end, '；') from o), '❌ 一筆都沒有') as 結果,
       case when (select count(*) from o) = 1 then '✅ 剛好一筆'
            when (select count(*) from o) = 0 then '❌ 沒寫進去'
            else '⚠ ' || (select count(*) from o) || ' 筆重疊，要看' end as 判定
union all
select 2, '這筆是補的還是同步早就有的',
       (select string_agg(case when imported_via = 'manual' then '補登（這支寫的）' else '同步進來的（' || imported_via || '）—— 同步其實有抓到' end, '；') from o),
       'ℹ'
union all
select 3, '營收認列（觸發器自動拆月）',
       (select string_agg(r.ym || '：' || r.month_nights || ' 晚 $' || round(r.month_amount, 2), '；' order by r.ym)
          from public.revenue_recognitions r where r.order_id in (select id from o)),
       case when (select count(*) from o) = 1
             and (select coalesce(sum(r.month_amount), 0) from public.revenue_recognitions r where r.order_id in (select id from o))
                 between (select min(amount) from o) - 0.01 and (select min(amount) from o) + 0.01
            then '✅ 加起來等於訂單金額' else 'ℹ 第 1 列不是剛好一筆時不判' end
order by 1;
