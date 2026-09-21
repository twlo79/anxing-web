/* ══════════════════════════════════════════════════════════════════════
 * 查－信陽與南京到底是不是子母                       2026-09-21
 *
 * 只讀不寫。整支貼進 Supabase SQL Editor，把結果表貼回來。
 *
 * 第二支查出來：
 *   信陽5 跟 信陽5-1／5-2／5-3 **同一天都有人**，各重疊 65 ~ 77 天。
 *   父子關係的話不該重疊 —— 所以要嘛是撞房，要嘛同一件事被記了兩次，
 *   要嘛「信陽5」根本不是母房源而是獨立的一間。
 *   這支把那幾間房的每一筆佔用攤開，一看就知道是哪一種。
 *
 * 順便攤開南京（南京10 整年 0 天，看不出是母房源還是真的空著）。
 *
 * 算法跟前面兩支、跟前端完全一致（`lib/room-calendar.ts` 的 occupies()）。
 * 期間：近 12 個月。
 * ══════════════════════════════════════════════════════════════════════ */

with period as (
  select (date_trunc('month', current_date) - interval '11 months')::date as d1,
         current_date                                                    as d2
),
span as (select d1, d2 from period),

/* ★★★ 要看的房號。信陽與南京全部，另外帶開封／JPR 各一組當對照
     —— 那兩組第二支已經證實是乾淨的父子（父被訂時子沒被訂）。 */
want as (
  select unnest(array[
    '信陽整層','信陽5','信陽5-1','信陽5-2','信陽5-3',
    '南京10','南京10-1','南京10-2','南京10-3','南京5','南京6'
  ]) as room
),

stays as (
  select 'orders'::text as tbl, o.id::text as rid,
         o.property_raw::text as room,
         o.checkin::date as s, (o.checkout::date - 1) as e,
         coalesce(o.source, '')::text as kind,
         coalesce(o.guest_name, '')::text as who
  from public.orders o, span p
  where o.property_raw is not null
    and coalesce(o.source, '') not in ('oneoff', 'airbnb_cancelled')
    and o.checkin <= p.d2 and o.checkout > p.d1
    and not exists (
      select 1 from public.contracts c, span q
      where c.id = o.contract_id and c.room is not null
        and c.active is distinct from false
        and c.start_date <= q.d2 and c.end_date >= q.d1)
  union all
  select 'contracts', c.id::text, c.room::text,
         c.start_date::date, c.end_date::date,
         '契約:' || coalesce(c.type, '')::text,
         coalesce(nullif(c.display_name, ''), c.tenant_name, '')::text
  from public.contracts c, span p
  where c.room is not null and c.active is distinct from false
    and c.start_date <= p.d2 and c.end_date >= p.d1
)

select st.room                          as 房號,
       st.tbl                           as 來源表,
       st.kind                           as 類別,
       st.s::text                       as 起,
       st.e::text                       as "迄（最後一晚）",
       (st.e - st.s + 1)::text          as 天數,
       st.who                           as 客人或承租人,
       /* ★ 同一個物業裡，這一筆跟哪些別的房號的日子撞在一起 */
       coalesce((
         select string_agg(distinct o2.room, '、' order by o2.room)
         from stays o2
         where o2.room <> st.room
           and o2.room in (select room from want)
           and left(o2.room, 2) = left(st.room, 2)   -- 同一個物業（信陽／南京）
           and o2.e >= o2.s
           and o2.s <= st.e and o2.e >= st.s
       ), '（沒有）')                   as 跟誰的日子撞在一起,
       st.rid                           as id
from stays st
where st.room in (select room from want)
  and st.e >= st.s
order by left(st.room, 2), st.room, st.s;
