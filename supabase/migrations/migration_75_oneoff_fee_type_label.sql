-- migration_75：一次性收入的科目統一
--
-- 【這支做兩件事】
--
-- 一、把「取消費」併進「其他」
--     2026-08 查到的實際資料：
--       oneoff / 取消費 / Airbnb 取消收入            47 筆   $1,137,746
--       oneoff / 取消費 / 取消預訂                   14 筆     $182,012
--       oneoff / 取消費 / Airbnb 取消收入(搭檔收款)   12 筆     $188,497
--     業務決定是這三種都歸「其他」，明細留在備註。
--     所以下拉選單（src/lib/fee-types.ts）也不放取消相關的選項。
--
--     代價要寫下來：營收報表的「其他」會含這約 150 萬，光看報表分不出組成，
--     得回訂單看備註。之後若要分開，加科目再重新標記即可，資料都還在。
--
-- 二、修正沒填科目時的預設值
--     原本是 coalesce(o.fee_type, '取消費')，而且條件涵蓋 oneoff 與
--     airbnb_cancelled 兩種來源 —— 任何沒填科目的一次性收入都會被標成「取消費」。
--
--     這一版前端新增了科目下拉，不選就是 null，所以這個預設從現在開始才真的會被踩到。
--     改成 '其他'，跟上面的併法一致 —— 兩邊不同步的話，同一種單會出現兩個科目。

create or replace function public.gen_recognitions(o orders)
 returns void language plpgsql security definer
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
      ename, pname, o.guest_name, o.checkin, o.checkout, o.amount, coalesce(o.nights,0), 0, o.amount,
      -- 這一行是這支 migration 對函式的唯一改動（原本是 '取消費'）
      coalesce(o.fee_type, '其他'));
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


-- ── 改既有資料 ─────────────────────────────────────
--
-- 先改 orders（那是真正的來源），認列表由觸發器連動重算。
-- 只改 orders 不改認列表，兩邊就會不一致而且沒人會發現。
do $$
declare n_ord int; n_rec int; before_total bigint; after_total bigint;
begin
  -- 動之前先記住一次性收入的總額。改的是分類，金額一分都不該變。
  select coalesce(sum(month_amount), 0)::bigint into before_total
  from revenue_recognitions where source = 'oneoff';

  update orders set fee_type = '其他'
   where source in ('oneoff', 'airbnb_cancelled')
     and fee_type = '取消費';
  get diagnostics n_ord = row_count;
  raise notice '訂單改標「其他」：% 筆', n_ord;

  -- 觸發器只在 orders 更新時重算認列。舊的認列列若有漏網的，直接補上。
  update revenue_recognitions set fee_type = '其他' where fee_type = '取消費';
  get diagnostics n_rec = row_count;
  raise notice '認列列補標「其他」：% 筆', n_rec;

  select coalesce(sum(month_amount), 0)::bigint into after_total
  from revenue_recognitions where source = 'oneoff';

  if before_total <> after_total then
    raise exception '一次性收入總額被動到了：% → %，差 %。這支只該改分類。',
      before_total, after_total, after_total - before_total;
  end if;
  raise notice '一次性收入總額不變：%', after_total;
end $$;


-- ============================================================
-- 驗證
-- ============================================================

-- 一次性收入的科目分布。預期看不到「取消費」了。
select coalesce(fee_type, '(null)') as 科目,
       count(*) as 筆數,
       sum(month_amount)::bigint as 金額
from public.revenue_recognitions
where source = 'oneoff'
group by 1
order by 3 desc;

-- 取消相關的明細還在備註裡，查得回來
select coalesce(o.note, '(沒有備註)') as 備註,
       count(*) as 筆數,
       sum(o.amount)::bigint as 金額
from public.orders o
where o.source in ('oneoff', 'airbnb_cancelled')
  and o.fee_type = '其他'
group by 1
order by 3 desc;
-- 預期：Airbnb 取消收入 / 取消預訂 / Airbnb 取消收入(搭檔收款) 三種都還分得出來

-- 全站不該再有「取消費」這個科目
select count(*) as 還有取消費的筆數
from public.revenue_recognitions where fee_type = '取消費';
-- 預期：0


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    raise notice '%', (select public.record_migration('75_oneoff_fee_type_label'));
  else
    raise notice '尚未建立 schema_migrations（migration_70），這支沒有被記錄';
  end if;
end $$;
