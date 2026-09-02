-- 查：契約月租單對帳（兩支，只讀不寫）
--
-- ============================================================
-- 【為什麼要重寫驗收公式】（2026-08-16）
--
-- migration_136 的自檢用的是
--
--     應收 = 月租 × (迄月 − 起月)
--
-- 那個公式假設**每一期都是整月**。契約週期模式下不成立:
--
--     2F-3  租期 2024-09-15 ~ 2026-03-31
--           週期 09-15、10-15 ⋯ 2026-03-15，最後一期 03-15~04-01 只有 17 天
--           → 18 期整月 ＋ 1 期零頭，公式少算了那個零頭
--
-- 於是 136 報「合計對不上 42 份」—— 而其中大部分是公式錯，不是資料錯。
--
-- 下面第一支改用**跟 gen_contract_orders 一模一樣的算法**算應收，
-- 那才是真正的驗收。


-- ============================================================
-- ① 每份契約：已開 vs 應收（用契約週期算）
-- ============================================================
with c as (
  select id, room, tenant_name, start_date, end_date, monthly_rent,
         (end_date + 1)::date as lease_end
    from public.contracts
   where active
     and room is not null and btrim(room) <> ''
     and start_date is not null and end_date is not null
     and monthly_rent is not null and monthly_rent > 0
), per as (
  -- 契約週期:起日每加一個月一期。最後一期可能被 lease_end 切短
  select c.id, c.room, c.tenant_name, c.start_date, c.end_date, c.monthly_rent,
         gs::date                                            as p_start,
         (gs + interval '1 month')::date                     as full_end,
         least((gs + interval '1 month')::date, c.lease_end) as p_end
    from c, generate_series(c.start_date, c.end_date, '1 month') gs
), calc as (
  select id, room, tenant_name, start_date, end_date, monthly_rent,
         count(*) as want_periods,
         -- 足月整額,不足月按天數比例（跟 gen_contract_orders 同一套）
         round(sum(monthly_rent::numeric * (p_end - p_start) / (full_end - p_start)))
           as want_total
    from per
   where p_end > p_start
   group by 1,2,3,4,5,6
), got as (
  select contract_id, count(*) as cnt, sum(amount) as issued
    from public.orders
   where imported_via = 'contract'
   group by contract_id
)
select
  k.room                                              as "房源",
  k.tenant_name                                       as "租戶",
  k.start_date                                        as "租期起",
  k.end_date                                          as "租期迄",
  to_char(k.monthly_rent, 'FM999,999,999')            as "月租",
  coalesce(g.cnt, 0)                                  as "已開期數",
  k.want_periods                                      as "應有期數",
  to_char(coalesce(g.issued, 0), 'FM999,999,999')     as "已開合計",
  to_char(k.want_total, 'FM999,999,999')              as "應收合計",
  to_char(coalesce(g.issued, 0) - k.want_total,
          'FM+999,999,999;-999,999,999')              as "差額",
  case
    when coalesce(g.cnt, 0) < k.want_periods then '❌ 少開 ' || (k.want_periods - coalesce(g.cnt,0)) || ' 期'
    when coalesce(g.cnt, 0) > k.want_periods then '⚠ 多開 ' || (coalesce(g.cnt,0) - k.want_periods) || ' 期'
    else '⚠ 期數對但金額不符'
  end                                                 as "研判"
from calc k
left join got g on g.contract_id = k.id
-- 對得上的不列。容許 1 元誤差（分攤捨去）
where abs(coalesce(g.issued, 0) - k.want_total) > 1
   or coalesce(g.cnt, 0) <> k.want_periods
order by abs(coalesce(g.issued, 0) - k.want_total) desc, k.room;


-- ============================================================
-- ② 不屬於任何契約期間的月租單（7B1 那種「多開」）
--
-- 這一支抓的是「有單，但契約週期裡沒有這一期」——
-- 契約改短、房客提前退租、或當初手動加的單。
--
-- **不含 active 篩選** —— 已停用契約的舊單是正常的歷史資料，
-- 但如果它的 checkin 對不上任何一期，那還是要看一眼。
-- ============================================================
with c as (
  select id, start_date, end_date
    from public.contracts
   where start_date is not null and end_date is not null
), starts as (
  select c.id, gs::date as p_start
    from c, generate_series(c.start_date, c.end_date, '1 month') gs
)
select
  o.property_raw                        as "房源",
  ct.tenant_name                        as "租戶",
  o.order_key                           as "訂單編號",
  o.checkin                             as "起",
  o.checkout                            as "迄",
  to_char(o.amount, 'FM999,999,999')    as "金額",
  case when o.paid then '⚠ 已收款' else '未收款' end as "收款",
  ct.start_date                         as "租期起",
  ct.end_date                           as "租期迄",
  ct.active                             as "契約生效中"
from public.orders o
join public.contracts ct on ct.id = o.contract_id
where o.imported_via = 'contract'
  and not exists (
    select 1 from starts s
     where s.id = o.contract_id and s.p_start = o.checkin
  )
order by o.paid desc, o.property_raw, o.checkin;
