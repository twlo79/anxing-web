/* ══════════════════════════════════════════════════════════════════════
 * 查－住房率為什麼不准（子母房源）           2026-09-21
 *
 * 只讀不寫。整支貼進 Supabase SQL Editor 跑，把整張結果表貼回來給我。
 *
 * 要回答的問題：
 *   ① 各物業現在算出來的住房率是多少（這是「修之前」的基準，之後要拿來比）
 *   ② 每一間房源實際被佔用幾天 —— 整棟／樓層那種父房源會很高、底下的子房源會是 0
 *   ③ 訂單或契約用到、但房源表**根本沒有這個名字**的房號
 *        ← 這種天數現在完全沒進住房率，而畫面上不會有任何錯誤
 *
 * 算法跟前端完全一致（`lib/room-calendar.ts` 的 occupies()）：
 *   訂單  checkout 是退房日 → 最後一晚 = checkout − 1
 *   契約  end_date 就是最後一晚
 *   契約產生的月租單要丟掉，不然同一段期間被算兩次
 *   逐日算，同一天有三筆也只算一天
 *
 * 期間：近 12 個月（從 11 個月前的月初到今天）
 * ══════════════════════════════════════════════════════════════════════ */

with period as (
  select (date_trunc('month', current_date) - interval '11 months')::date as d1,
         current_date                                                    as d2
),
span as (select d1, d2, (d2 - d1 + 1) as nd from period),

/* ── 佔用（跟前端同一套規則） ───────────────────────────────── */
stays as (
  select o.property_raw::text as room,
         o.checkin::date      as s,
         (o.checkout::date - 1) as e          -- ★ 退房日不算一晚
  from public.orders o, span p
  where o.property_raw is not null
    and coalesce(o.source, '') not in ('oneoff', 'airbnb_cancelled')
    and o.checkin <= p.d2
    and o.checkout > p.d1                     -- ★ 是 > 不是 >=
    /* ★★★ 契約產生的月租單丟掉 —— 契約自己那一筆已經畫了同一段期間 */
    and not exists (
      select 1 from public.contracts c, span q
      where c.id = o.contract_id
        and c.room is not null
        and c.active is distinct from false
        and c.start_date <= q.d2
        and c.end_date   >= q.d1)
  union all
  select c.room::text, c.start_date::date, c.end_date::date
  from public.contracts c, span p
  where c.room is not null
    and c.active is distinct from false
    and c.start_date <= p.d2
    and c.end_date   >= p.d1
),
days as (select generate_series(p.d1, p.d2, interval '1 day')::date as d from span p),
occ as (                                       -- ★ 逐日、去重複：重疊只算一天
  select st.room, count(distinct d.d)::int as used
  from stays st
  join days d on d.d >= st.s and d.d <= st.e
  where st.e >= st.s                           -- ★ 當日單（加費、折讓）不佔任何一晚
  group by st.room
),
cnt as (select room, count(*)::int as n from stays group by room),

/* ── 房源（住房率的分母就是這一份） ─────────────────────────── */
props as (
  select pr.name::text                              as name,
         coalesce(e.name, '（沒設物業）')::text      as est,
         (pr.active is not false)                   as act,
         (pr.show_in_room_calendar is not false)    as cal
  from public.properties pr
  left join public.estates e on e.id = pr.estate_id
),
inden as (select * from props where act and cal),  -- 真正進分母的那些

/* ── ① 各物業現在的住房率 ──────────────────────────────────── */
sec1 as (
  select 1 as sort, '① 各物業現在的住房率'::text as 區,
         i.est                                  as 物業,
         '（合計）'::text                        as 房源,
         ''::text as 啟用, ''::text as 排房表,
         count(*)::text                         as 間數,
         (count(*) * max(p.nd))::text           as 可住天數,
         sum(coalesce(o.used, 0))::text         as 佔用天數,
         to_char(100.0 * sum(coalesce(o.used, 0))
                 / nullif(count(*) * max(p.nd), 0), 'FM990.0') || '%' as 住房率,
         case when count(*) filter (where i.name ~ '(整棟|全棟|全館)') > 0
              then '⚠ 這個物業有「整棟」這種父房源，父子都在分母裡 → 現在這個數字偏低'
              else '' end::text as 備註
  from inden i
  cross join span p
  left join occ o on o.room = i.name
  group by i.est
),
sec1t as (
  select 2 as sort, '① 各物業現在的住房率'::text, '　＝＝ 全部 ＝＝'::text, '（合計）'::text,
         '', '',
         count(*)::text,
         (count(*) * max(p.nd))::text,
         sum(coalesce(o.used, 0))::text,
         to_char(100.0 * sum(coalesce(o.used, 0))
                 / nullif(count(*) * max(p.nd), 0), 'FM990.0') || '%',
         '期間 ' || max(p.d1)::text || ' ~ ' || max(p.d2)::text
                 || '，共 ' || max(p.nd)::text || ' 天'
  from inden i cross join span p left join occ o on o.room = i.name
),

/* ── ② 每一間房源 ──────────────────────────────────────────── */
sec2 as (
  select 3 as sort, '② 房源清單'::text,
         pp.est, pp.name,
         case when pp.act then '✓' else '✗ 停用' end::text,
         case when pp.cal then '✓' else '✗ 沒勾' end::text,
         '1'::text,
         case when pp.act and pp.cal then p.nd::text else '0（不在分母裡）' end,
         coalesce(o.used, 0)::text,
         case when pp.act and pp.cal
              then to_char(100.0 * coalesce(o.used, 0) / nullif(p.nd, 0), 'FM990.0') || '%'
              else '—' end,
         (case when pp.name ~ '(整棟|全棟|全館)' then '⚠ 看起來是父房源（整棟）；' else '' end
          || case when coalesce(o.used, 0) = 0 and pp.act and pp.cal
                  then '整段期間一天都沒有人 —— 要嘛真的空著，要嘛它的佔用記在父房源上' else '' end
         )::text
  from props pp
  cross join span p
  left join occ o on o.room = pp.name
),

/* ── ③ 有佔用、但房源表沒有這個名字 ────────────────────────── */
sec3 as (
  select 4 as sort, '③ ⚠ 房源表沒有這個名字'::text,
         '—'::text, o.room,
         '', '', '—'::text, '—'::text,
         o.used::text, '—'::text,
         '訂單或契約用了這個房號，但 properties 沒有這一列 → 這 '
           || o.used::text || ' 天完全沒有進住房率（分子分母都沒有）'
  from occ o
  where not exists (select 1 from props pp where pp.name = o.room)
),
sec3n as (
  select 5 as sort, '③ ⚠ 房源表沒有這個名字'::text,
         '—'::text, '（沒有，很好）'::text, '', '', '—'::text, '—'::text, '—'::text, '—'::text,
         '每一個被用到的房號都在房源表裡'::text
  where not exists (
    select 1 from occ o where not exists (select 1 from props pp where pp.name = o.room))
)

select 區, 物業, 房源, 啟用, 排房表, 間數, 可住天數, 佔用天數, 住房率, 備註
from (
  select * from sec1
  union all select * from sec1t
  union all select * from sec2
  union all select * from sec3
  union all select * from sec3n
) x(sort, 區, 物業, 房源, 啟用, 排房表, 間數, 可住天數, 佔用天數, 住房率, 備註)
order by sort, 物業, 房源;
