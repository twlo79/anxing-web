/* ══════════════════════════════════════════════════════════════════════
 * 查（只讀）：重複訂單 —— 全面掃一次                                                  2026-10-19
 *
 * 【David】「我發現有很多重複訂單，需要去重」
 *
 * 【抓哪幾種】（一次性費用、已取消、契約月租單、其他事業體 都不算）
 *   ① 同一間房、住宿日期重疊、客人名字相似      → 最像重複（房源狀態上會畫成「重疊」）
 *   ② 不同房、入住退房完全相同、客人名字相似    → 建錯房的那種（例：A11 補登＋B05 同步）
 *   名字相似 ＝ 第一個字（空格前）相同，或一個名字是另一個的開頭；大小寫、空白不管。
 *
 * 【怎麼讀】一列一組，左右各一張。每張寫：房・客人・金額・已收多少・押金幾筆・單號・怎麼進來的・建立日。
 *   「建議」那欄是我的判斷，不是結論 —— 刪之前看一眼。
 *   最上面一列是合計。
 *
 * ★ 一個字都不改。看完把整張表貼回來，我再寫刪除（進回收桶、可復原）的那一支。
 * ══════════════════════════════════════════════════════════ */
with o as (
  select o.id, o.order_key, o.guest_name, o.checkin, o.checkout, o.amount, o.source, o.imported_via, o.created_at,
         coalesce(o.paid_amount, 0) as paid_amt,
         coalesce(p.name, o.property_raw, '?') as room,
         lower(regexp_replace(trim(coalesce(o.guest_name, '')), '\s+.*$', '')) as first_word,
         lower(regexp_replace(trim(coalesce(o.guest_name, '')), '\s+', ' ', 'g')) as full_name,
         (select count(*) from public.order_payments x where x.order_id = o.id) as n_pay,
         (select count(*) from public.deposits d where d.order_id = o.id) as n_dep
    from public.orders o left join public.properties p on p.id = o.property_id
   where o.source not in ('oneoff', 'airbnb_cancelled', 'other_biz')
     and coalesce(o.imported_via, '') not in ('contract', 'contract_fee', 'recurring')
     and o.contract_id is null
     and o.cancelled_on is null
     and o.checkin is not null and o.checkout is not null
),
pairs as (
    select a.id as a_id, b.id as b_id,
           case when a.room = b.room then 1 else 2 end as kind
      from o a
      join o b on b.id > a.id
             and a.first_word <> '' and b.first_word <> ''
             and (a.first_word = b.first_word
                  or a.full_name like b.full_name || '%' or b.full_name like a.full_name || '%')
             and (
               (a.room = b.room and a.checkin < b.checkout and b.checkin < a.checkout)          -- ① 同房、日期重疊
               or (a.room <> b.room and a.checkin = b.checkin and a.checkout = b.checkout)      -- ② 不同房、日期完全相同
             )
),
lines as (
  select p.kind,
         a.checkin as sort_d,
         case when p.kind = 1 then '① 同房重疊' else '② 不同房同日期' end as 類型,
         least(a.checkin, b.checkin)::text || ' ～ ' || greatest(a.checkout, b.checkout)::text as 住宿,
         a.room || '・' || coalesce(a.guest_name, '?') || '・$' || to_char(a.amount, 'FM999,999,990')
           || '・已收 ' || to_char(a.paid_amt, 'FM999,999,990') || case when a.n_dep > 0 then '・押金 ' || a.n_dep || ' 筆' else '' end
           || '・' || coalesce(a.order_key, '?') || '・' || coalesce(a.imported_via, a.source) || '・建 ' || to_char(a.created_at, 'MM-DD') as 第一張,
         b.room || '・' || coalesce(b.guest_name, '?') || '・$' || to_char(b.amount, 'FM999,999,990')
           || '・已收 ' || to_char(b.paid_amt, 'FM999,999,990') || case when b.n_dep > 0 then '・押金 ' || b.n_dep || ' 筆' else '' end
           || '・' || coalesce(b.order_key, '?') || '・' || coalesce(b.imported_via, b.source) || '・建 ' || to_char(b.created_at, 'MM-DD') as 第二張,
         case
           when a.checkin = b.checkin and a.checkout = b.checkout and a.full_name = b.full_name
                and a.room = b.room and a.amount = b.amount then '⚠ 完全一樣 —— 刪一張（留有收款／押金的那張）'
           when (a.imported_via = 'manual') <> (b.imported_via = 'manual') then
             '⚠ 一張補登、一張同步 —— 多半刪補登那張'
             || case when (case when a.imported_via = 'manual' then a.n_pay + a.n_dep else b.n_pay + b.n_dep end) > 0
                     then '（★ 補登那張有收款／押金，要先搬到另一張）' else '' end
           when a.source = 'airbnb' and b.source = 'airbnb' then 'ℹ 兩張都是 Airbnb 同步 —— 可能是改訂後舊單沒消，對一下 Airbnb'
           when a.full_name <> b.full_name then 'ℹ 名字只是像，可能真的是兩個人'
           else '⚠ 看一下'
         end as 建議
    from pairs p join o a on a.id = p.a_id join o b on b.id = p.b_id
)
select 0 as 序, '合計' as 類型,
       count(*)::text || ' 組' as 住宿,
       '① 同房重疊 ' || count(*) filter (where kind = 1) || ' 組' as 第一張,
       '② 不同房同日期 ' || count(*) filter (where kind = 2) || ' 組' as 第二張,
       '其中「一張補登、一張同步」' || count(*) filter (where 建議 like '%補登%') || ' 組；完全一樣 ' || count(*) filter (where 建議 like '%完全一樣%') || ' 組' as 建議
  from lines
union all
select (row_number() over (order by kind, sort_d desc))::int, 類型, 住宿, 第一張, 第二張, 建議
  from lines
order by 1;
