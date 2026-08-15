-- migration_53：跨月營收拆分改成「捨去 + 尾期補餘額」
--
-- 舊做法：每個月各自 round(amount * n / nights, 2)
--   1000 元 3 晚跨三個月 → 333.33 + 333.33 + 333.33 = 999.99
--   各月加起來跟訂單金額對不上，而且會出現小數。
--
-- 新做法：
--   除了最後一個月以外 → trunc(amount * n / nights)   無條件捨去到整數
--   最後一個月         → amount − 前面各月的合計       餘數全部給它
--
--   10000 分三期 → 3333 + 3333 + 3334 = 10000
--
-- 為什麼餘數放最後一期而不是第一期：
--   最後一期通常還沒結案，調整它不會動到已經對過帳、已經出過月報的月份。
--
-- 用 trunc 而不是 floor 是為了負數（退款、折讓改走一次性訂單，
-- 但萬一有負數的一般訂單，floor(-3333.3) = -3334 會變成「捨去反而變大」）。
-- 正數兩者結果相同。

create or replace function public.gen_recognitions(o orders)
returns void
language plpgsql
security definer
as $function$
declare
  ms date; me date; n int; ename text; pname text;
  last_ms date;          -- 最後一個有住宿天數的月份
  acc numeric := 0;      -- 前面各月已認列的合計
  amt numeric;
begin
  select e.name into ename from estates e where e.id = o.estate_id;
  select p.name into pname from properties p where p.id = o.property_id;
  pname := coalesce(pname, o.property_raw);

  -- 一次性收入（含折讓的負數）不跨月，整筆記在 checkin 當月
  if o.source in ('oneoff', 'airbnb_cancelled') then
    if o.checkin is null or o.amount is null then return; end if;
    ms := date_trunc('month', o.checkin)::date;
    insert into revenue_recognitions(order_id, ym, period_start, period_end, source, estate_id, property_id,
      estate_name, property_raw, guest_name, checkin, checkout, total_amount, total_nights, month_nights, month_amount, fee_type)
    values (o.id, to_char(o.checkin,'YYYYMM'), ms, (ms + interval '1 month')::date, 'oneoff', o.estate_id, o.property_id,
      ename, pname, o.guest_name, o.checkin, o.checkout, o.amount, coalesce(o.nights,0), 0, o.amount, coalesce(o.fee_type,'取消費'));
    return;
  end if;

  if o.checkin is null or o.checkout is null or o.nights is null or o.nights <= 0 then return; end if;

  -- checkout 是退房日（不算一晚），所以最後一晚是 checkout - 1。
  -- 7/30 進 8/1 出 → 最後一晚在 7/31，最後一個月是 7 月，不是 8 月。
  last_ms := date_trunc('month', o.checkout - 1)::date;

  ms := date_trunc('month', o.checkin)::date;
  while ms < o.checkout loop
    me := (ms + interval '1 month')::date;
    n := greatest(0, least(o.checkout, me) - greatest(o.checkin, ms));
    if n > 0 then
      if ms = last_ms then
        amt := o.amount - acc;                        -- 餘數全給最後一期
      else
        amt := trunc(o.amount * n / o.nights);        -- 無條件捨去到整數
        acc := acc + amt;
      end if;

      insert into revenue_recognitions(order_id, ym, period_start, period_end, source, estate_id, property_id,
        estate_name, property_raw, guest_name, checkin, checkout, total_amount, total_nights, month_nights, month_amount, fee_type)
      values (o.id, to_char(ms,'YYYYMM'), greatest(o.checkin, ms), least(o.checkout, me),
        case when o.source = 'partner' then 'airbnb' else o.source end,
        o.estate_id, o.property_id,
        ename, pname, o.guest_name, o.checkin, o.checkout, o.amount, o.nights, n, amt, null);
    end if;
    ms := me;
  end loop;
end $function$;


-- ============================================================
-- 既有資料要重算，否則新舊兩種算法會並存在同一份報表裡。
--
-- rebuild_recognitions() 會清空整張表再從 orders 重跑 ——
-- revenue_recognitions 本來就是純衍生資料，沒有人工編輯過的內容會遺失。
-- ============================================================
select public.rebuild_recognitions() as 重算訂單數;


-- ============================================================
-- 驗證：每張訂單的各月認列加總，必須等於訂單金額
-- 這個查詢應該回傳 0 列
-- ============================================================
select r.order_id, r.total_amount, sum(r.month_amount) as 認列合計, count(*) as 月數
from public.revenue_recognitions r
group by r.order_id, r.total_amount
having sum(r.month_amount) <> r.total_amount
limit 20;

-- 還有沒有非整數的認列金額（一次性收入若原本就有小數會留著，屬正常）
select source, count(*) as 非整數筆數
from public.revenue_recognitions
where month_amount <> trunc(month_amount)
group by source;

-- 抽樣看跨月的單子拆得對不對
select ym, month_nights, total_nights, total_amount, month_amount
from public.revenue_recognitions
where order_id in (
  select order_id from public.revenue_recognitions
  group by order_id having count(*) > 1 limit 3
)
order by order_id, ym;
