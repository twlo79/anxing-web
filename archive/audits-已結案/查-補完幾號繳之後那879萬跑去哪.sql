-- ============================================================
-- 唯讀。補完「幾號繳」之後，7B2 與 17B5 那 879 萬排到哪幾個月。
--
-- ★ 補之前那兩張契約算不出應繳日 —— 57 個月與 24 個月的租
--   全部擠在一格，完全不在現金流表裡。
--   補完之後應該散開成一期一列。
--
-- ★★ 第一張表是**判定**:那兩張現在算不算得出應繳日。
--   算不出的話下面那張會是空的，而空表跟「都排好了」長得一樣。
-- ============================================================

-- ── ① 判定：現在算不算得出應繳日 ────────────────────────────
select ct.room                                   as 房源,
       coalesce(ct.tenant_name, '—')             as 房客,
       ct.cadence                                as 繳別,
       ct.pay_day                                as 幾號繳,
       ct.first_payment_date                     as 首繳日,
       coalesce(
         case when ct.pay_day between 1 and 31 then ct.pay_day end,
         extract(day from ct.first_payment_date)::int)  as 實際採用的日,
       case when coalesce(
              case when ct.pay_day between 1 and 31 then ct.pay_day end,
              extract(day from ct.first_payment_date)::int) is null
            then '❌ 還是算不出來 —— 下面那張表會是空的'
            else '✅ 算得出來了' end               as 判定
  from public.contracts ct
 where ct.room in ('7B2','17B5')
   and ct.active
 order by ct.room;


-- ── ② 那 879 萬散到哪幾個月 ─────────────────────────────────
with lt as (
  select o.amount, o.checkin, o.paid, c.room, c.cadence, c.start_date,
         coalesce(c.tenant_name, '—') as tenant,
         coalesce(
           case when c.pay_day between 1 and 31 then c.pay_day end,
           extract(day from c.first_payment_date)::int) as pay_day,
         case c.cadence when 'quarterly' then 3 when 'halfyear' then 6
                        when 'yearly' then 12 else 1 end as step
    from public.orders o
    join public.contracts c on c.id = o.contract_id
   where o.source in ('longterm','company','office')
     and c.room in ('7B2','17B5')
     and c.active
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
  select lt3.*,
         case when lt3.pay_day is null then null else
           (lt3.due_month + (least(lt3.pay_day,
              extract(day from (lt3.due_month + interval '1 month - 1 day'))::int
            ) - 1) * interval '1 day')::date end as due_date
    from lt3
)
select coalesce(to_char(due_date, 'YYYY/MM'), '（還是算不出）') as 應繳月,
       min(due_date)                                        as 應繳日,
       room                                                 as 房源,
       tenant                                               as 房客,
       case cadence when 'monthly' then '月繳' when 'yearly' then '年繳'
                    when 'quarterly' then '季繳' when 'halfyear' then '半年繳'
                    else cadence end                        as 繳別,
       count(*)                                             as 幾個月的租,
       sum(amount)                                          as 這期要收,
       sum(case when paid then 0 else amount end)           as 其中未收
  from lt4
 -- ★ 只看未來 12 個月 ＋ 最近三個月。過去太久的不是現金流問題
 where due_date is null
    or (due_date >= date_trunc('month', current_date) - interval '3 months'
        and due_date <  date_trunc('month', current_date) + interval '12 months')
 group by coalesce(to_char(due_date, 'YYYY/MM'), '（還是算不出）'), room, tenant, cadence
 order by 1, 7 desc;
