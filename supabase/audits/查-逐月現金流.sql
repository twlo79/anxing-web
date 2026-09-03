-- ============================================================
-- 唯讀。未來 12 個月逐月現金流：收多少、退多少、淨多少、累計多少。
--
-- ★ 單獨一支 —— SQL Editor 只顯示**最後一個 select**，
--   一個檔案裡放好幾張表的話前面幾張會被蓋掉（2026-09-03 踩過）。
--
-- 【五條線】
--   長租租金    orders (longterm/company/office)、未收 → 歸到**應繳日**那個月
--   短租住宿    orders (airbnb/agoda/private/partner)、未收 → 歸到 checkin
--   一次性加費  orders (oneoff/airbnb_cancelled)、未收 → 歸到 checkin
--   押金收取    deposits 還沒收的 → 歸到契約起租日／入住日
--   押金退還    deposits 收了沒退的 → 歸到排定或推算的退款日（**流出**）
--
-- ★★★ 收款的月份不是租的月份 —— 安幸是預繳制，7 月的租金 6 月收。
--   算法照 src/lib/due-date.ts：第 i 期應繳日 =（該期第一個月 − 1 個月）的 pay_day 號。
--   季／半年／年繳是整期一次收，所以那個月會一大筆、後面幾個月 0 —— 那是對的。
--
-- ★★ 這不是預測，是「已經在系統裡的」。
--   會少算：還沒訂的短租、還沒簽的新約、續約之後的月份
--   會多算：會退租的、收不到的
--   短租那一欄**離現在越遠越低**，那是資料的形狀不是生意變差。
-- ============================================================

with
mon as (
  select generate_series(
           date_trunc('month', current_date),
           date_trunc('month', current_date) + interval '11 months',
           interval '1 month')::date as m
),
lt as (
  select o.amount, o.checkin, c.start_date,
         coalesce(
           case when c.pay_day between 1 and 31 then c.pay_day end,
           extract(day from c.first_payment_date)::int) as pay_day,
         case c.cadence when 'quarterly' then 3 when 'halfyear' then 6
                        when 'yearly' then 12 else 1 end as step
    from public.orders o
    join public.contracts c on c.id = o.contract_id
   where o.source in ('longterm','company','office') and not o.paid
),
lt2 as (
  select lt.*, floor((
           (extract(year from lt.checkin)::int * 12 + extract(month from lt.checkin)::int)
         - (extract(year from lt.start_date)::int * 12 + extract(month from lt.start_date)::int)
         )::numeric / lt.step)::int as idx
    from lt
),
lt3 as (
  select lt2.*,
         (date_trunc('month', lt2.start_date)
          + (lt2.idx * lt2.step - 1) * interval '1 month')::date as due_month
    from lt2 where lt2.idx >= 0
),
lt4 as (
  select lt3.amount,
         case when lt3.pay_day is null then null else
           (lt3.due_month + (least(lt3.pay_day,
              extract(day from (lt3.due_month + interval '1 month - 1 day'))::int
            ) - 1) * interval '1 day')::date end as due_date
    from lt3
),
rent as (
  select date_trunc('month', due_date)::date as m, sum(amount) as amt
    from lt4 where due_date >= date_trunc('month', current_date) group by 1
),
st as (
  select date_trunc('month', checkin)::date as m,
         sum(case when source in ('airbnb','agoda','private','partner') then amount else 0 end) as s,
         sum(case when source in ('oneoff','airbnb_cancelled') then amount else 0 end) as f
    from public.orders
   where not paid
     and source in ('airbnb','agoda','private','partner','oneoff','airbnb_cancelled')
     and checkin >= date_trunc('month', current_date)
   group by 1
),
dep_in as (
  select date_trunc('month', coalesce(c.start_date, o.checkin, d.created_at::date))::date as m,
         sum(d.amount) as amt
    from public.deposits d
    left join public.contracts c on c.id = d.contract_id
    left join public.orders    o on o.id = d.order_id
   where d.received_on is null and not d.orphaned
     and coalesce(c.start_date, o.checkin, d.created_at::date) >= date_trunc('month', current_date)
   group by 1
),
dep_out as (
  select date_trunc('month', coalesce(d.planned_refund_on, c.end_date, o.checkout))::date as m,
         sum(d.amount) as amt
    from public.deposits d
    left join public.contracts c on c.id = d.contract_id
    left join public.orders    o on o.id = d.order_id
   where d.received_on is not null and d.returned_on is null and not d.orphaned
     and coalesce(d.planned_refund_on, c.end_date, o.checkout) >= date_trunc('month', current_date)
   group by 1
),
j as (
  select mon.m,
         coalesce(rent.amt, 0)    as a,
         coalesce(st.s, 0)        as b,
         coalesce(st.f, 0)        as c,
         coalesce(dep_in.amt, 0)  as d,
         coalesce(dep_out.amt, 0) as e
    from mon
    left join rent    on rent.m    = mon.m
    left join st      on st.m      = mon.m
    left join dep_in  on dep_in.m  = mon.m
    left join dep_out on dep_out.m = mon.m
)
select to_char(m, 'YYYY/MM')            as 月份,
       a                                as 長租租金,
       b                                as 短租住宿,
       c                                as 一次性加費,
       d                                as 押金收取,
       (0 - e)                          as 押金退還,
       (a + b + c + d - e)              as 淨現金,
       sum(a + b + c + d - e) over (order by m) as 累計
  from j
 order by m;
