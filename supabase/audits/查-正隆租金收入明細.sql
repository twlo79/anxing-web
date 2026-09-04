-- ============================================================
-- 唯讀。正隆的租金收入 —— 每個月哪一間、收多少、收了沒。
--
-- ★ 單獨一支 —— SQL Editor 只顯示最後一個 select。
--
-- ============================================================
-- 【★★★ 依「應繳日」分月，不是依租的月份】
--
-- 安幸是預繳制:7 月的租金 6 月收。問「現金什麼時候進來」就要用應繳日。
-- 算法照 `src/lib/due-date.ts`:
--     第 i 期應繳日 =（該期第一個月 − 1 個月）的 pay_day 號
--
-- ★★ 季／半年／年繳是**整期一次收**。所以年繳那一戶會在某個月
--   出現一筆幾百萬，而後面十一個月完全沒有它 —— 那是對的。
--   「幾個月的租」那一欄就是在講這件事。
--
-- ★ 算不出應繳日的（契約沒 pay_day 也沒首繳日）會排在最後、
--   應繳月顯示「（算不出）」。**不會被丟掉** —— 那筆錢是真的，
--   只是時間不知道。
-- ============================================================

with lt as (
  select o.id, o.amount, o.checkin, o.paid, o.paid_at,
         o.property_raw, o.guest_name,
         coalesce(p.name, o.property_raw, '（沒對到房源）') as 房源,
         coalesce(c.display_name, c.tenant_name, o.guest_name, '（未命名）') as 房客,
         c.cadence, c.start_date, c.end_date,
         coalesce(
           case when c.pay_day between 1 and 31 then c.pay_day end,
           extract(day from c.first_payment_date)::int) as pay_day,
         case c.cadence when 'quarterly' then 3 when 'halfyear' then 6
                        when 'yearly' then 12 else 1 end as step
    from public.orders o
    join public.contracts c on c.id = o.contract_id
    left join public.properties p on p.id = o.property_id
    left join public.estates   es on es.id = coalesce(o.estate_id, c.estate_id, p.estate_id)
   where o.source in ('longterm','company','office')
     -- ★ 物業從三個地方退回。只看 o.estate_id 的話，
     --   早期沒寫物業的那些月租單會整批消失
     and es.name = '正隆'
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
select coalesce(to_char(due_date, 'YYYY/MM'), '（算不出）')  as 應繳月,
       min(due_date)                                      as 應繳日,
       房源,
       房客,
       case cadence when 'monthly' then '月繳' when 'quarterly' then '季繳'
                    when 'halfyear' then '半年繳' when 'yearly' then '年繳'
                    else cadence end                       as 繳別,
       count(*)                                            as 幾個月的租,
       sum(amount)                                         as 這期要收,
       sum(case when paid then amount else 0 end)          as 已收,
       sum(case when paid then 0 else amount end)          as 未收,
       case when bool_and(paid) then '✅ 收齊'
            when bool_or(paid)  then '⚠ 收一半'
            when min(due_date) < current_date then '❌ 過期未收 —— 要催'
            else '未來' end                                 as 狀態,
       max(end_date)                                       as 租期迄
  from lt4
 -- ★ 只看未來與最近的過去。太舊的已收款不是現金流問題
 where due_date is null
    or due_date >= date_trunc('month', current_date) - interval '3 months'
 group by coalesce(to_char(due_date, 'YYYY/MM'), '（算不出）'),
          房源, 房客, cadence
 order by 1, 7 desc;
