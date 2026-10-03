/* 補：評價「未對應」房源 → 用訂單反查（房客＋日期）補上                           2026-10-03
 *
 * 【為什麼】評價對房源有三層：listing_id → 訂單反查（房客＋日期）→ 保留舊值。
 *   10/02 把 Airbnb 全名補進訂單之後（「Kevin」→「Kevin Chen」），
 *   評價那邊還是只有名，第二層「房客名字完全相同」就再也對不到 —— Kevin（A17 8/28～9/30）因此「未對應」。
 *   程式已改成「全名或名（第一段）」都比（lib/review-match.ts，下次同步起生效）；
 *   這支把**已經進來、還是未對應**的評價用同一套規則補一次。
 *
 * 【規則，跟程式一樣】三關，前一關對到就停，每一關只採計唯一解（同名同天住兩間 → 不猜）：
 *   ① 退房日相同　② 入住日相同　③ 退房日差一天
 *   名字：全名相同，或第一段（名）相同。
 * ★ 只補 property_id 是空的；已經有房源的一列都不碰。
 * ★★ 自檢在 commit 後面 —— 看不到那張表就是整支回滾了。
 */
create temp table if not exists _fix (rid text, guest text, ci date, co date, pid uuid, how text) on commit preserve rows;

begin;
delete from _fix;

with o as (
  select property_id,
         checkin, checkout,
         lower(trim(regexp_replace(guest_name, '\s+', ' ', 'g'))) as full,
         split_part(lower(trim(regexp_replace(guest_name, '\s+', ' ', 'g'))), ' ', 1) as first
    from public.orders
   where property_id is not null and coalesce(trim(guest_name), '') <> ''
),
r as (
  select airbnb_review_id as rid, guest_name, checkin_date as ci, checkout_date as co,
         lower(trim(regexp_replace(guest_name, '\s+', ' ', 'g'))) as full,
         split_part(lower(trim(regexp_replace(guest_name, '\s+', ' ', 'g'))), ' ', 1) as first
    from public.reviews
   where property_id is null and coalesce(trim(guest_name), '') not in ('', '(unknown)')
),
m as (
  select r.*,
         (select (array_agg(distinct o.property_id))[1] from o
           where o.checkout = r.co and (o.full in (r.full, r.first) or o.first in (r.full, r.first))
          having count(distinct o.property_id) = 1) as p1,
         (select (array_agg(distinct o.property_id))[1] from o
           where o.checkin = r.ci and (o.full in (r.full, r.first) or o.first in (r.full, r.first))
          having count(distinct o.property_id) = 1) as p2,
         (select (array_agg(distinct o.property_id))[1] from o
           where o.checkout in (r.co - 1, r.co + 1) and (o.full in (r.full, r.first) or o.first in (r.full, r.first))
          having count(distinct o.property_id) = 1) as p3
    from r
)
insert into _fix
select rid, guest_name, ci, co, coalesce(p1, p2, p3),
       case when p1 is not null then '退房日' when p2 is not null then '入住日' else '退房日±1' end
  from m where coalesce(p1, p2, p3) is not null;

update public.reviews v set property_id = f.pid
  from _fix f
 where v.airbnb_review_id = f.rid and v.property_id is null;

commit;

-- ═══ 自檢（在 commit 後面 —— 看不到那張表就是整支回滾了） ═══════════
select 1 as 序, '這次補上的' as 檢查,
       (select count(*)::text from _fix) || ' 則' as 結果,
       coalesce((select string_agg(f.guest || ' ' || coalesce(to_char(f.ci, 'MM-DD'), '?') || '～' || coalesce(to_char(f.co, 'MM-DD'), '?')
                                   || ' → ' || coalesce(p.name, '?') || '（' || f.how || '）', '；' order by f.co desc)
                   from (select * from _fix order by co desc limit 30) f left join public.properties p on p.id = f.pid), '（沒有）') as 明細
union all
select 2, '還是未對應的（訂單也找不到，或同名撞兩間不猜）',
       (select count(*)::text from public.reviews where property_id is null) || ' 則',
       coalesce((select string_agg(guest_name || ' ' || coalesce(to_char(checkin_date, 'MM-DD'), '?') || '～' || coalesce(to_char(checkout_date, 'MM-DD'), '?'), '；' order by checkout_date desc)
                   from (select * from public.reviews where property_id is null order by checkout_date desc nulls last limit 15) x), '（沒有）')
union all
select 3, 'Kevin 8/28～9/30 那一則',
       coalesce((select coalesce(p.name, '★ 還是未對應') from public.reviews v left join public.properties p on p.id = v.property_id
                  where v.guest_name ilike 'kevin%' and v.checkin_date = '2026-08-28' limit 1), '（找不到那則評價）'),
       ''
order by 1;
