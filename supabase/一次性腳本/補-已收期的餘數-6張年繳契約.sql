/* ══════════════════════════════════════════════════════════════════════
 * 一次性：已收的期補回餘數（應收＋已收一起調）                              2026-09-23
 *
 * 【為什麼】migration_298 之後，未收的期已經對回契約每期金額；
 *   但已收的期函式不碰（收了的錢是既成事實），所以 6 張年繳契約的第 1 期
 *   還是月租 × 12：10A3 +4、14A2 +4、7A3 −4、8A3 +4、8A5 −4、9A3 +3。
 *   使用者（2026-09-23）：「已收款的也改成，應收、已收也都調整」。
 *
 * 【做什麼】每一張非月繳契約、每一個「整期都已收」的期：
 *   期合計 ≠ 每期金額 → 差額加到**那一期最後一個月**那張單（跟 298 同一條規則）。
 *   · paid 不動（還是已收）、paid_at 不動
 *   · 那一期若有分筆收款（order_payments），最後一筆收款也加同樣的差額 ——
 *     不然觸發器會把它算成「還差 4 元」退回部分收款
 *   · 認列（revenue_recognitions）由 orders 上的觸發器自己重算，不用另外做
 *
 * 【不動的】未收的期（298 已處理）、月繳、租期最後不足整期的那一期、
 *   已收但收得不完整的期（一期 12 張只收了 3 張 —— 那不是「已收的期」）。
 *
 * ★★ 跑之前記下已收合計（跑之後應該是它 + 所有差額；自檢第 4 列會算給你看）：
 *    select sum(amount) from orders where imported_via = 'contract' and paid;
 * ★★ 自檢在 commit 後面 —— 看不到那張表就是整支回滾了。
 * ══════════════════════════════════════════════════════════ */

begin;

-- 要改哪幾張：每張契約每一期的最後一個月（只挑整期已收、合計 ≠ 每期金額的）
create temp table _fix as
with s as (
  select c.id, c.room, c.amount_per_period as per,
         case c.cadence when 'quarterly' then 3 when 'halfyear' then 6 when 'yearly' then 12 else 1 end as step
    from public.contracts c
   where c.active and c.cadence <> 'monthly' and c.amount_per_period is not null
     and c.room is not null and btrim(c.room) <> ''
),
o as (
  select s.id as contract_id, s.room, s.per, s.step, x.id as order_id, x.amount, x.paid, x.checkin,
         (row_number() over (partition by s.id order by x.checkin) - 1) / s.step as p,   -- 第幾期（從 0）
         (row_number() over (partition by s.id order by x.checkin) - 1) % s.step as q    -- 期內第幾個月（從 0）
    from s join public.orders x on x.contract_id = s.id and x.imported_via = 'contract'
),
per_period as (
  select contract_id, room, per, step, p,
         count(*) as n, count(*) filter (where paid) as paid_n, sum(amount) as total
    from o group by contract_id, room, per, step, p
)
select pp.room, pp.p + 1 as 期, pp.total as 原合計, pp.per as 每期金額, pp.per - pp.total as 差額,
       lo.order_id, lo.checkin as 餘數月, lo.amount as 原金額, lo.amount + (pp.per - pp.total) as 新金額,
       pp.contract_id
  from per_period pp
  join o lo on lo.contract_id = pp.contract_id and lo.p = pp.p and lo.q = pp.step - 1   -- 這一期最後一個月
 where pp.n = pp.step and pp.paid_n = pp.step        -- 整期、而且整期都已收
   and pp.total <> pp.per;

-- 有分筆收款的期：最後一筆收款也加同樣的差額
create temp table _pay as
select f.room, f.期, f.差額, op.id as payment_id, op.amount as 原收款, op.amount + f.差額 as 新收款
  from _fix f
  join lateral (
    select op.id, op.amount from public.order_payments op
     where op.order_id in (select o2.id from public.orders o2
                            where o2.contract_id = f.contract_id and o2.imported_via = 'contract'
                              and o2.checkin <= f.餘數月
                              and o2.checkin >  f.餘數月 - (select case c.cadence when 'quarterly' then 3 when 'halfyear' then 6 when 'yearly' then 12 else 1 end
                                                            from public.contracts c where c.id = f.contract_id) * interval '1 month')
     order by op.paid_on desc, op.created_at desc limit 1
  ) op on true;

do $$
begin
  if exists (select 1 from _pay where 新收款 <= 0) then
    raise exception '有一筆分筆收款調完會 ≤ 0，停下來（貼 _pay 給我）';
  end if;
end $$;

update public.orders o set amount = f.新金額
  from _fix f where o.id = f.order_id;

update public.order_payments op set amount = p.新收款
  from _pay p where op.id = p.payment_id;

commit;

-- 自檢（在 commit 後面 —— 看不到就是整支回滾了）
select 1 as 序, '這次改了哪幾張（房源 第幾期 差額）' as 檢查,
       coalesce((select string_agg(room || ' 第' || 期 || '期 ' || case when 差額 > 0 then '+' else '' end || 差額::text, '、' order by room) from _fix), '（沒有要改的）') as 結果,
       case when (select count(*) from _fix) = 0 then '⚠ 一張都沒改 —— 要嘛已經跑過、要嘛沒有整期已收的差額' else '✅ ' || (select count(*) from _fix) || ' 張' end as 判定
union all select 2, '改完之後，整期已收的期是不是都等於每期金額',
       (select count(*)::text from (
          with s as (select c.id, c.amount_per_period per, case c.cadence when 'quarterly' then 3 when 'halfyear' then 6 when 'yearly' then 12 else 1 end step
                       from public.contracts c where c.active and c.cadence <> 'monthly' and c.amount_per_period is not null and c.room is not null and btrim(c.room) <> ''),
               o as (select s.id, s.per, s.step, x.amount, x.paid, (row_number() over (partition by s.id order by x.checkin) - 1) / s.step p
                       from s join public.orders x on x.contract_id = s.id and x.imported_via = 'contract')
          select 1 from o group by id, per, step, p having count(*) = step and count(*) filter (where paid) = step and sum(amount) <> per) z),
       case when (select count(*) from (
          with s as (select c.id, c.amount_per_period per, case c.cadence when 'quarterly' then 3 when 'halfyear' then 6 when 'yearly' then 12 else 1 end step
                       from public.contracts c where c.active and c.cadence <> 'monthly' and c.amount_per_period is not null and c.room is not null and btrim(c.room) <> ''),
               o as (select s.id, s.per, s.step, x.amount, x.paid, (row_number() over (partition by s.id order by x.checkin) - 1) / s.step p
                       from s join public.orders x on x.contract_id = s.id and x.imported_via = 'contract')
          select 1 from o group by id, per, step, p having count(*) = step and count(*) filter (where paid) = step and sum(amount) <> per) z) = 0
            then '✅' else '❌ 還有對不上的，貼結果給我' end
union all select 3, '已收張數（改前改後要一樣 —— paid 沒被觸發器翻掉）',
       (select count(*)::text from public.orders where imported_via = 'contract' and paid),
       'ℹ 跟改之前比'
union all select 4, '已收合計（＝跑之前的數字 ＋ 這次差額合計）',
       (select sum(amount)::text from public.orders where imported_via = 'contract' and paid)
         || '（差額合計 ' || coalesce((select sum(差額) from _fix), 0)::text || '）',
       'ℹ 跑之前記的數字 + 括號裡的 = 左邊'
union all select 5, '分筆收款跟著調的筆數',
       (select count(*)::text from _pay),
       case when (select count(*) from _pay) = 0 then 'ℹ 這幾期都不是分筆收的，沒有要調' else '✅ ' || (select string_agg(room || ' ' || 原收款 || '→' || 新收款, '、') from _pay) end
order by 1;
