/* ══════════════════════════════════════════════════════════════════════
 * 查（只讀）：哪些 Airbnb 訂單建在錯的房源上？—— 鏡像上的編號「現在對到哪間」vs「訂單實際建在哪間」    2026-10-01
 *
 * 【為什麼】A11 10/17 與 A02 11/9 兩筆「沒爬到」查出來其實都爬到了，只是建在 B05 與 A06 ——
 *   因為當初編號 → 房源的對照是 127 用名字猜的，猜錯的那幾個編號，幾個月來進來的每一筆都建錯間。
 *   今天把對照修了，但**已經建好的訂單不會自己搬**。這支把不一致的全部列出來。
 *
 * 【怎麼讀】一列一個「編號 × 建在哪間」的組合：筆數、入住日範圍、幾個例子。
 *   「現在對到」是今天修完的對照；「建在」是訂單身上的房源。兩個不一樣就是要搬的。
 *   ★ 對照本身還可能有錯（A13 / B05 那兩個編號要先確認），所以先看、不搬。
 * 一個字都不改。
 * ══════════════════════════════════════════════════════════ */
with snap as (
  select s.code, s.listing_id, s.guest, s.start_date, s.end_date,
         (select m.property_id from public.listing_property_map m where m.listing_id = s.listing_id limit 1) as map_pid
    from public.airbnb_snapshots s
   where s.listing_id is not null
),
j as (
  select sn.*, o.property_id as ord_pid, o.property_raw,
         (select name from public.properties where id = sn.map_pid) as map_name,
         (select name from public.properties where id = o.property_id) as ord_name
    from snap sn
    join public.orders o on o.order_key = sn.code
)
select listing_id as 編號,
       coalesce(map_name, '（對不到房源）') as 現在對到,
       coalesce(ord_name, property_raw, '（訂單沒房源）') as 訂單建在,
       count(*) as 筆數,
       min(start_date)::text || ' ～ ' || max(start_date)::text as 入住日範圍,
       count(*) filter (where end_date >= current_date) as 還沒退房的,
       left(string_agg(code || ' ' || coalesce(guest, '?') || ' ' || start_date, '；' order by start_date desc), 160) as 例子
  from j
 where map_pid is distinct from ord_pid
 group by listing_id, map_name, ord_name, property_raw
 order by 還沒退房的 desc, 筆數 desc;
