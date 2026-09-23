-- 只讀。migration_298 自檢第 3 列說有 10 張非月繳契約「未收張數不是每期月數的整數倍」——
-- 這支列出是哪 10 張、租期幾個月、已收幾張、未收幾張、未收合計，看它們是哪一種：
--   A. 租期本來就不是整期（例如季繳但租 14 個月）→ 最後一期本來就不足，正常
--   B. 一期裡收了一部分（例如年繳只收了 3 個月）→ 收款流程的事，不是這支的事
--   C. 其他 → 貼給我
with s as (
  select c.id, c.room, c.tenant_name, c.cadence, c.amount_per_period, c.start_date, c.end_date,
         case c.cadence when 'quarterly' then 3 when 'halfyear' then 6 when 'yearly' then 12 else 1 end as step
    from public.contracts c
   where c.active and c.amount_per_period is not null and c.cadence <> 'monthly'
     and c.room is not null and btrim(c.room) <> ''
),
o as (
  select contract_id,
         count(*) filter (where paid)     as paid_n,
         count(*) filter (where not paid) as unpaid_n,
         coalesce(sum(amount) filter (where not paid), 0) as unpaid_sum,
         count(*) as all_n
    from public.orders where imported_via = 'contract' group by contract_id
)
select s.room, s.tenant_name as 房客, s.cadence as 週期, s.step as 每期月數,
       s.start_date as 起, s.end_date as 迄,
       o.all_n as 月租單張數, o.paid_n as 已收張, o.unpaid_n as 未收張,
       o.unpaid_n % s.step as 未收零頭月數,
       s.amount_per_period as 每期金額, o.unpaid_sum as 未收合計,
       case when o.all_n % s.step <> 0 then 'A 租期不是整期'
            when o.paid_n % s.step <> 0 then 'B 一期只收了一部分'
            else 'C 貼給我' end as 類型
  from s join o on o.contract_id = s.id
 where o.unpaid_n % s.step <> 0
 order by 類型, s.room;
