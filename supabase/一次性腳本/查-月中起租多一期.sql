-- 查：哪些契約被多產了一個月的月租單
--
-- 【問題】
-- gen_contract_orders 按「日曆月」產單，迴圈條件是
--
--     ms := date_trunc('month', start_date);   -- 起租月的 1 號
--     while ms < end_date loop ...
--
-- 租期 2026/6/6 ~ 2027/6/5 剛好 12 個月，但它碰到 13 個日曆月
-- （2026/6 一路到 2027/6），於是產了 13 張月租單。
--
-- 最後那張是「零頭」—— 2027/6/1~6/5 那 5 天，而那 5 天本來就含在
-- 前一期（2027/5/6~2027/6/5）裡面。
--
-- 【後果】
--   1. 多收一個月的租金
--   2. 營收多認列一個月
--   3. 年繳/季繳會多出一個只有一個月的「第 2 期」（使用者就是這樣發現的）
--
-- 【判斷式】
-- 只有「月中起租」會中 —— end_date 的日 < start_date 的日。
-- 1 號起租的契約（end_date 的日通常是月底）不受影響。
--
-- 這支只讀不寫。看完再決定要不要跑 migration_93。

select
  c.room                                   as 房源,
  c.tenant_name                            as 租戶,
  c.cadence                                as 繳別,
  c.start_date                             as 租期起,
  c.end_date                               as 租期迄,
  c.monthly_rent                           as 月租,
  count(o.id)                              as 已產月租單數,
  -- 應該要有幾期：起訖之間的月數
  ((extract(year from c.end_date)::int * 12 + extract(month from c.end_date)::int)
   - (extract(year from c.start_date)::int * 12 + extract(month from c.start_date)::int))
                                           as 應有期數,
  count(o.id) filter (where o.paid)        as 其中已收款,
  to_char(sum(o.amount), 'FM999,999,999')  as 月租單合計,
  to_char(c.monthly_rent *
    ((extract(year from c.end_date)::int * 12 + extract(month from c.end_date)::int)
     - (extract(year from c.start_date)::int * 12 + extract(month from c.start_date)::int)),
    'FM999,999,999')                       as 應收合計,
  -- 多出來的那張是哪個月、收款了沒
  (select to_char(x.checkin, 'YYYY/MM') || case when x.paid then '（已收款！）' else '（未收款）' end
     from public.orders x
    where x.contract_id = c.id and x.imported_via = 'contract'
    order by x.checkin desc limit 1)       as 最後一張
from public.contracts c
join public.orders o
  on o.contract_id = c.id and o.imported_via = 'contract'
where c.start_date is not null and c.end_date is not null
  -- 月中起租：迄日的「日」小於起日的「日」
  and extract(day from c.end_date) < extract(day from c.start_date)
group by c.id, c.room, c.tenant_name, c.cadence, c.start_date, c.end_date, c.monthly_rent
having count(o.id) >
  ((extract(year from c.end_date)::int * 12 + extract(month from c.end_date)::int)
   - (extract(year from c.start_date)::int * 12 + extract(month from c.start_date)::int))
order by count(o.id) filter (where o.paid) desc, c.start_date;


-- ── 一句話總結 ─────────────────────────────────────
select
  count(*)                                          as 受影響契約數,
  count(*) filter (where 最後一張已收款)              as 其中最後一張已收款,
  to_char(sum(月租), 'FM999,999,999')                as 多算的金額合計
from (
  select
    c.monthly_rent as 月租,
    (select x.paid from public.orders x
      where x.contract_id = c.id and x.imported_via = 'contract'
      order by x.checkin desc limit 1) as 最後一張已收款
  from public.contracts c
  join public.orders o on o.contract_id = c.id and o.imported_via = 'contract'
  where c.start_date is not null and c.end_date is not null
    and extract(day from c.end_date) < extract(day from c.start_date)
  group by c.id, c.monthly_rent
  having count(o.id) >
    ((extract(year from c.end_date)::int * 12 + extract(month from c.end_date)::int)
     - (extract(year from c.start_date)::int * 12 + extract(month from c.start_date)::int))
) t;
