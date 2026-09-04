-- ============================================================
-- 唯讀。2026-09-04 14:31 花新增的「Christy $7,000」訂單，
-- 為什麼訂單頁看不到。
--
-- 【訂單頁會濾掉什麼】（`app/(app)/shortterm/page.tsx`）
--
--   1. `source` 不在 (airbnb, agoda, private, oneoff, partner, airbnb_cancelled)
--      → 長租的三種（longterm／company／office）走契約頁，不在這一頁
--   2. 篩選列的日期:`checkin <= 迄` 且 `checkout >= 起`
--   3. 物業、來源、關鍵字、收款狀態、發票那幾個篩選
--   4. 被丟進回收桶（`deleted_at` 有值）
--   5. RLS 擋掉（但 David 是總經理，不該被擋）
--
-- ★★ 這一支不猜是哪一種 —— **把每一條逐一判定**，
--   哪一條是 ❌ 就是那一條。
--
-- 【怎麼跑】整份貼進 SQL Editor。
-- ============================================================

-- ── ① 先從編輯紀錄找出那一筆是誰 ─────────────────────────────
-- ★ 母體要判定。找不到的話下面全部是空的，而空表跟「一切正常」長得一樣
select 'data_audit 裡的那一列' as 檢查,
       count(*)::text          as 結果,
       case when count(*) = 0
            then '⚠ 找不到 —— 時間或名字對不上，下面兩張表不算數'
            else '✅ 找到了' end as 判定
  from public.data_audit
 where table_name = 'orders'
   and action = 'insert'
   and at >= timestamptz '2026-09-04 00:00+08'
   and at <  timestamptz '2026-09-05 00:00+08'
   and coalesce(label, '') ilike '%Christy%';


-- ── ② 那一筆訂單長什麼樣子，以及每一條篩選的判定 ─────────────
with a as (
  select record_id, at, label
    from public.data_audit
   where table_name = 'orders' and action = 'insert'
     and at >= timestamptz '2026-09-04 00:00+08'
     and at <  timestamptz '2026-09-05 00:00+08'
     and coalesce(label, '') ilike '%Christy%'
),
o as (
  select o.*, a.at as 建立時間, a.label as 紀錄標籤
    from a
    left join public.orders o on o.id = a.record_id
)
select 建立時間,
       紀錄標籤,
       case when id is null then '❌ 訂單不存在（建完被刪了？）' else '✅ 訂單還在' end as 訂單在不在,
       order_key,
       source                                as 來源,
       -- ★★★ 最可能的一條:來源不在訂單頁的白名單裡
       case when source in ('airbnb','agoda','private','oneoff','partner','airbnb_cancelled')
            then '✅ 在訂單頁的來源白名單裡'
            when source in ('longterm','company','office')
            then '❌ 這是長租的來源 —— 要去「契約」那一頁看，不在訂單頁'
            else '❌ 來源「' || coalesce(source,'（空的）') || '」不在任何一頁的白名單裡' end as 來源判定,

       guest_name                            as 房客,
       amount                                as 金額,
       checkin                               as 入住,
       checkout                              as 退房,
       -- ★★ 訂單頁預設不帶日期篩選，但使用者常常留著上次的
       case when checkin > current_date + interval '1 year'
             or checkout < current_date - interval '2 years'
            then '⚠ 日期離現在很遠 —— 篩選列如果留著日期就會被濾掉'
            else '✅ 日期在常見範圍內' end    as 日期判定,

       parent_order_id                       as 母訂單,
       -- ★ 加費是掛在母訂單底下的子單，主清單本來就不會單獨列出來
       case when parent_order_id is not null
            then '❌ 這是加費（子訂單）—— 要展開母訂單才看得到'
            else '✅ 不是子訂單' end          as 子訂單判定,

       coalesce(property_raw, '（沒填）')      as 房號,
       estate_id                             as 物業id,
       case when estate_id is null
            then '⚠ 沒掛物業 —— 篩選列如果選了物業就會被濾掉'
            else '✅ 有掛物業' end            as 物業判定,

       paid                                  as 已收款,
       imported_via                          as 怎麼建的,
       created_at                            as 資料庫建立時間
  from o;


-- ── ③ 同一天所有新增的訂單（拿來比對:別筆看得到嗎）──────────
-- ★★ 只看一筆的話分不出是「這一筆特別」還是「那天建的都看不到」。
--   兩者的處理方式完全不同。
select o.created_at                          as 建立時間,
       o.source                              as 來源,
       o.guest_name                          as 房客,
       o.amount                              as 金額,
       o.checkin                             as 入住,
       coalesce(o.property_raw, '—')          as 房號,
       case when o.source in ('airbnb','agoda','private','oneoff','partner','airbnb_cancelled')
            then '訂單頁看得到'
            when o.source in ('longterm','company','office')
            then '契約頁（不在訂單頁）'
            else '兩頁都看不到' end            as 會出現在哪
  from public.orders o
 where o.created_at >= timestamptz '2026-09-04 00:00+08'
   and o.created_at <  timestamptz '2026-09-05 00:00+08'
 order by o.created_at;
