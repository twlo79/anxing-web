/* ══════════════════════════════════════════════════════════════════════
 * 查（只讀）：同一段入住日、客人名字相似的訂單 —— 抓重複單                                   2026-10-01
 *
 * 【為什麼】今天補登的 A11（Daniel Lee）跟同步進來建在 B05 的 Daniel（HMA9M95B95）是同一個人同一段住宿；
 *   這種「一個客人兩張單」的情況可能不只這一組。
 *
 * 【怎麼比】同一個入住日＋同一個退房日，且名字相似：第一個字（空格前）相同、或一個名字是另一個的開頭。
 *   兩張單在哪間房不管 —— 建錯房的正是會跑到別間去的。排除一次性費用（oneoff）與已取消。
 * 【怎麼讀】一列一組，左右各一張。「補登」那張通常是多的；兩張都是同步進來的（HM 開頭）就要看是不是真的兩個客人。
 * 一個字都不改。
 * ══════════════════════════════════════════════════════════ */
with o as (
  select o.id, o.order_key, o.guest_name, o.checkin, o.checkout, o.amount, o.paid, o.source, o.imported_via,
         coalesce(p.name, o.property_raw, '?') as room,
         lower(regexp_replace(trim(coalesce(o.guest_name, '')), '\s+.*$', '')) as first_word,
         lower(trim(coalesce(o.guest_name, ''))) as full_name
    from public.orders o left join public.properties p on p.id = o.property_id
   where o.source not in ('oneoff', 'airbnb_cancelled', 'other_biz')
     and o.checkin is not null and o.checkout is not null
)
select a.checkin::text || ' ～ ' || a.checkout::text as 住宿,
       a.room || '・' || coalesce(a.guest_name, '?') || '・$' || a.amount || case when a.paid then '・已收' else '・未收' end
         || '・' || a.order_key || case when a.imported_via = 'manual' then '（補登）' else '' end as 第一張,
       b.room || '・' || coalesce(b.guest_name, '?') || '・$' || b.amount || case when b.paid then '・已收' else '・未收' end
         || '・' || b.order_key || case when b.imported_via = 'manual' then '（補登）' else '' end as 第二張,
       case when a.room = b.room then '同一間' else '不同間' end as 房源,
       case when a.imported_via = 'manual' or b.imported_via = 'manual' then '⚠ 有一張是補登的，多半重複'
            when a.full_name = b.full_name then '⚠ 名字完全一樣'
            else 'ℹ 名字只是像，可能真的是兩個人' end as 判定
  from o a
  join o b on b.checkin = a.checkin and b.checkout = a.checkout and b.id > a.id
         and a.first_word <> '' and b.first_word <> ''
         and (a.first_word = b.first_word
              or a.full_name like b.full_name || '%' or b.full_name like a.full_name || '%')
 order by a.checkin desc, 第一張;
