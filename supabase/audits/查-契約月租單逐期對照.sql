-- 查：契約應該有哪幾期、實際有哪幾張、對不對得上
--
-- 【這支只讀不寫。】
--
-- migration_135 的自檢只給每份契約的「合計」——
-- 合計對得上不代表每一期都對（多開一期 ＋ 少開一期 = 合計剛好）。
-- 這支逐期攤開，才看得出是哪一期出事。
--
-- 【怎麼讀】
--   狀態 = 多開      系統開了單，但那一期不在租期內
--   狀態 = 少開      租期內有這一期，但沒有單
--   狀態 = 期間不符   有單，但起訖跟「日曆月 ∩ 租期」對不上
--   狀態 = 金額不符   期間對，金額不對
--   （對得上的不列 —— 一份 48 期的契約全印出來沒有人看得完）

with c as (
  select id, room, tenant_name, start_date, end_date, monthly_rent,
         (end_date + 1)::date as lease_end
    from public.contracts
   where start_date is not null and end_date is not null
     and monthly_rent is not null and monthly_rent > 0
), months as (
  -- 這份契約碰到的每一個日曆月
  select c.*, gs::date as ms, (gs + interval '1 month')::date as me
    from c, generate_series(date_trunc('month', c.start_date), c.lease_end, '1 month') gs
   where gs::date < c.lease_end
), want as (
  -- 每一期「應該」是什麼樣子
  select id, room, tenant_name, start_date, end_date, monthly_rent, ms,
         greatest(ms, start_date)              as p_start,
         least(me, lease_end)                  as p_end,
         (least(me, lease_end) - greatest(ms, start_date)) as n,
         (me - ms)                             as dim
    from months
   where least(me, lease_end) > greatest(ms, start_date)
), want2 as (
  -- 分攤：除最後一期外無條件捨去，餘數全給最後一期
  select w.*,
         round(sum(w.monthly_rent::numeric * w.n / w.dim) over (partition by w.id)) as total,
         sum(trunc(w.monthly_rent::numeric * w.n / w.dim))
           over (partition by w.id order by w.ms
                 rows between unbounded preceding and 1 preceding)                  as acc_before,
         row_number() over (partition by w.id order by w.ms desc)                   as rn_desc
    from want w
), want3 as (
  select w.*,
         case when rn_desc = 1 then total - coalesce(acc_before, 0)
              else trunc(monthly_rent::numeric * n / dim) end as want_amt
    from want2 w
), got as (
  select o.contract_id, o.id as order_id, o.order_key, o.checkin, o.checkout,
         o.amount, o.paid, date_trunc('month', o.checkin)::date as ms
    from public.orders o
   where o.imported_via = 'contract' and o.contract_id is not null
)
select
  coalesce(w.room, g2.room, '（無房號）')          as "房源",
  coalesce(w.tenant_name, g2.tenant_name)         as "租戶",
  to_char(coalesce(w.ms, g.ms), 'YYYY-MM')        as "期別",
  case
    when g.order_id is null                       then '❌ 少開'
    when w.p_start is null                        then '⚠ 多開'
    when g.checkin <> w.p_start or g.checkout <> w.p_end then '⚠ 期間不符'
    else '⚠ 金額不符'
  end                                             as "狀態",
  case when w.p_start is null then '—'
       else to_char(w.p_start, 'MM-DD') || '~' || to_char(w.p_end - 1, 'MM-DD')
            || '（' || w.n || ' 天）' end          as "應該是",
  case when g.order_id is null then '—'
       else to_char(g.checkin, 'MM-DD') || '~' || to_char(g.checkout - 1, 'MM-DD') end
                                                  as "實際是",
  coalesce(to_char(w.want_amt, 'FM999,999,999'), '—')  as "應收",
  coalesce(to_char(g.amount, 'FM999,999,999'), '—')    as "已開",
  coalesce(to_char(g.amount - w.want_amt, 'FM+999,999,999;-999,999,999'), '—') as "差額",
  case when g.paid then '⚠ 已收款' else '' end     as "收款",
  g.order_key                                     as "訂單編號"
from want3 w
full outer join got g
  on g.contract_id = w.id and g.ms = w.ms
left join c g2 on g2.id = g.contract_id
where g.order_id is null                        -- 少開
   or w.p_start is null                         -- 多開
   or g.checkin <> w.p_start                    -- 期間不符
   or g.checkout <> w.p_end
   or g.amount <> w.want_amt                    -- 金額不符
order by
  -- 少開的排最前面 —— 那是還沒收到的錢
  case when g.order_id is null then 0 when w.p_start is null then 1 else 2 end,
  coalesce(w.room, g2.room), coalesce(w.ms, g.ms);
