/* ══════════════════════════════════════════════════════════════════════
 * 查－住房率 第二支：空房號、重複房源、父子重疊        2026-09-21
 *
 * 只讀不寫。整支貼進 Supabase SQL Editor，把整張結果表貼回來。
 *
 * 第一支查出來三件不能放著的事，這支把它們挖開：
 *   ① 有一個**空的**房號佔了 356 天（整個期間）—— 是哪一筆、哪張表
 *   ② 洪家「C房」在房源表裡有兩列 —— 還有哪些名字重複
 *   ③ 同一個物業裡，同一天有兩個房號都有人
 *        父子關係的話這是正常的（訂了整棟，3F 不該再被訂）
 *        **有重疊就是真的撞房，或是同一件事記了兩次**
 *
 * 算法跟第一支、跟前端完全一致（`lib/room-calendar.ts` 的 occupies()）。
 * 期間：近 12 個月。
 * ══════════════════════════════════════════════════════════════════════ */

with period as (
  select (date_trunc('month', current_date) - interval '11 months')::date as d1,
         current_date                                                    as d2
),
span as (select d1, d2, (d2 - d1 + 1) as nd from period),

/* ── 佔用（跟第一支同一套） ─────────────────────────────────── */
stays as (
  select 'orders'::text as tbl, o.id::text as rid,
         o.property_raw::text as room,
         o.checkin::date as s, (o.checkout::date - 1) as e,
         coalesce(o.source, '')::text as info,
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
         coalesce(c.type, '')::text,
         coalesce(nullif(c.display_name, ''), c.tenant_name, '')::text
  from public.contracts c, span p
  where c.room is not null and c.active is distinct from false
    and c.start_date <= p.d2 and c.end_date >= p.d1
),
days as (select generate_series(p.d1, p.d2, interval '1 day')::date as d from span p),
occd as (                                      -- 逐日展開，一間房一天一列
  select distinct st.room, d.d
  from stays st join days d on d.d >= st.s and d.d <= st.e
  where st.e >= st.s
),
props as (
  select pr.id, pr.name::text as name,
         coalesce(e.name, '（沒設物業）')::text as est,
         (pr.active is not false) as act,
         (pr.show_in_room_calendar is not false) as cal
  from public.properties pr
  left join public.estates e on e.id = pr.estate_id
),
estof as (                                     -- 房號 → 物業（孤兒房號歸「—」）
  select o.room, coalesce(max(pp.est), '—') as est
  from (select distinct room from occd) o
  left join props pp on pp.name = o.room
  group by o.room
),

/* ── ① 空白房號 ────────────────────────────────────────────── */
sec1 as (
  select 1 as sort, '① 空白房號的那幾筆'::text as 區,
         st.tbl                                as 來源表,
         '[' || st.room || ']'                 as 房號,
         st.s::text                            as 起,
         st.e::text                            as 迄,
         (st.e - st.s + 1)::text               as 天數,
         st.info                               as 類別,
         st.who                                as 客人或承租人,
         st.rid                                as id,
         '房號是空的或只有空白 → 這些天完全沒進住房率'::text as 備註
  from stays st
  where btrim(coalesce(st.room, '')) = ''
),
sec1n as (
  select 2, '① 空白房號的那幾筆'::text, '—'::text, '（沒有）'::text,
         '—'::text, '—'::text, '—'::text, '—'::text, '—'::text, '—'::text,
         '每一筆佔用都有房號'::text
  where not exists (select 1 from stays st where btrim(coalesce(st.room, '')) = '')
),

/* ── ② 房源表裡同名的列 ────────────────────────────────────── */
dupe as (select name from props group by name having count(*) > 1),
sec2 as (
  select 3, '② 房源表同一個名字有好幾列'::text,
         pp.est, pp.name,
         '—'::text, '—'::text,
         coalesce(o.used, 0)::text,
         case when pp.act then '啟用' else '停用' end
           || '／' || case when pp.cal then '在排房表' else '不在排房表' end,
         '—'::text,
         pp.id::text,
         '同名的列有 ' || (select count(*)::text from props q where q.name = pp.name)
           || ' 列 —— 兩列都進分母的話這間房會被算兩次'
  from props pp
  join dupe d on d.name = pp.name
  left join (select room, count(*)::int as used from occd group by room) o on o.room = pp.name
),
sec2n as (
  select 4, '② 房源表同一個名字有好幾列'::text, '—'::text, '（沒有）'::text,
         '—'::text, '—'::text, '—'::text, '—'::text, '—'::text, '—'::text,
         '每個房源名字都只有一列'::text
  where not exists (select 1 from dupe)
),

/* ── ③ 疑似父子、同一天都有人 ──────────────────────────────── */
/* ★★★ 只看**疑似父子**的配對，不是任兩間房。
     時兆 26 間、正隆 71 間，九成以上的日子都有人 —— 任兩間都會「重疊」，
     那種列印出來幾百列，真正要看的那幾列會埋在裡面（CLAUDE.md:誤報會把真警報淹掉）。
   判斷疑似父子：名字裡有 整棟／整層／公區，或一個是另一個的字首，
     或前三個字一樣而長度不同（開封2F ↔ 開封2-1；A01 ↔ A02 這種同長度的排除）。 */
likeParent as (
  select x.room as r1, y.room as r2, count(*)::int as ov
  from occd x
  join occd y on y.d = x.d and y.room > x.room
  where x.room ~ '(整棟|整層|公區)'
     or y.room ~ '(整棟|整層|公區)'
     or y.room like x.room || '%'
     or x.room like y.room || '%'
     or (left(x.room, 3) = left(y.room, 3) and length(x.room) <> length(y.room))
  group by x.room, y.room
),
pairs as (select * from likeParent),
sec3 as (
  select 5, '③ 疑似父子、同一天都有人'::text,
         e1.est,
         p.r1 || '  ✕  ' || p.r2,
         '—'::text, '—'::text,
         p.ov::text,
         case when e1.est = e2.est then '同一個物業' else '跨物業（' || e2.est || '）' end,
         '—'::text, '—'::text,
         '重疊 ' || p.ov::text || ' 天 —— 父子關係的話不該重疊，重疊就是撞房或同一件事記了兩次'
  from pairs p
  join estof e1 on e1.room = p.r1
  join estof e2 on e2.room = p.r2
  where e1.est = e2.est                        -- ★ 只看同一個物業，跨物業的重疊沒有意義
  order by p.ov desc
  limit 60
),
sec3n as (
  select 6, '③ 疑似父子、同一天都有人'::text, '—'::text, '（沒有）'::text,
         '—'::text, '—'::text, '—'::text, '—'::text, '—'::text, '—'::text,
         '同一個物業裡沒有任何兩間房在同一天都有人'::text
  where not exists (
    select 1 from pairs p
    join estof e1 on e1.room = p.r1 join estof e2 on e2.room = p.r2
    where e1.est = e2.est)
)

select 區, 來源表, 房號, 起, 迄, 天數, 類別, 客人或承租人, id, 備註
from (
  select * from sec1
  union all select * from sec1n
  union all select * from sec2
  union all select * from sec2n
  union all select * from sec3
  union all select * from sec3n
) x(sort, 區, 來源表, 房號, 起, 迄, 天數, 類別, 客人或承租人, id, 備註)
order by sort, 區, 房號;
