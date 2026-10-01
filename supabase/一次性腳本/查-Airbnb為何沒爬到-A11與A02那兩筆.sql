/* ══════════════════════════════════════════════════════════════════════
 * 查（只讀）：Airbnb 那兩筆為什麼沒進系統？—— A11 10/17～11/16、A02 11/9～12/8（Ryan Hansen）     2026-10-01
 *
 * 流程是兩段：① 爬蟲把 Airbnb 後台看到的訂單寫進 airbnb_snapshots（鏡像）
 *            ② 對帳拿整張鏡像去跟 orders 對，照 listing_id → 房源 建訂單
 * 「沒爬到」只有幾種可能，各一區：
 *   ① 爬蟲最近幾輪：什麼時候跑、掃了哪段入住日（很久沒跑／範圍沒到 11、12 月 → 原因 A）
 *   ② 鏡像整體：入住日最晚到哪天、十月以後有幾筆
 *   ③ 那兩筆：在鏡像裡嗎？對帳建到哪間房？（「鏡像裡沒有」→ 爬蟲沒爬到；建在別間 → 對照錯；今天修對照之前 A02 的編號指到 A18）
 *   ④ 卡著的差異：對不到房源／待人工判斷（入住日 10 月以後）
 * 一個字都不改。SQL Editor 只顯示最後一句的結果，所以全部併成一張表。
 * ══════════════════════════════════════════════════════════ */
with want(label, ci, co) as (values ('A11 10/17～11/16', date '2026-10-17', date '2026-11-16'),
                                    ('A02 11/9～12/8 Ryan', date '2026-11-09', date '2026-12-08'))
select * from (
  -- ① 最近五輪同步
  select 1 as 區, '① 同步 ' || to_char(r.at at time zone 'Asia/Taipei', 'MM-DD HH24:MI') as 項目,
         r.received || ' 收到・' || r.inserted || ' 新增・' || r.updated || ' 更新・' || r.skipped || ' 略過' as 內容,
         '掃的入住日 ' || coalesce(r.scan_from::text, '?') || ' ～ ' || coalesce(r.scan_to::text, '?') as 補充,
         left(r.detail::text, 140) as 其他,
         r.at as ord
    from public.sync_runs r where r.kind = 'orders' order by r.at desc limit 5
) a
union all
select 2, '② 鏡像整體',
       '最後一次看到 ' || to_char(max(last_seen) at time zone 'Asia/Taipei', 'MM-DD HH24:MI') || '・共 ' || count(*) || ' 筆',
       '入住日最晚 ' || max(start_date)::text,
       '十月以後 ' || count(*) filter (where start_date >= date '2026-10-01') || ' 筆',
       null
  from public.airbnb_snapshots
union all
select 3, '③ ' || w.label,
       coalesce('確認碼 ' || s.code || '・' || coalesce(s.guest, '?') || '・編號 ' || coalesce(s.listing_id, '?'), '（鏡像裡沒有 → 爬蟲沒爬到這筆）'),
       case when s.code is null then null else
         '編號現在對到 ' || coalesce((select p.name from public.listing_property_map m join public.properties p on p.id = m.property_id where m.listing_id = s.listing_id limit 1), '（對不到房源）') end,
       case when s.code is null then null else
         coalesce((select '訂單建在 ' || o.property_raw || '（' || coalesce(p.name, '?') || '）' from public.orders o left join public.properties p on p.id = o.property_id where o.order_key = s.code),
                  '（orders 裡沒有這個確認碼）') || '・最後看到 ' || to_char(s.last_seen at time zone 'Asia/Taipei', 'MM-DD HH24:MI') end,
       null
  from want w
  left join public.airbnb_snapshots s on s.start_date = w.ci and s.end_date = w.co
union all
select * from (
  select 4, '④ 卡著 ' || i.code, i.field || '：' || coalesce(i.from_val, '') || ' → ' || coalesce(i.to_val, ''),
         '編號 ' || coalesce(i.listing_id, '?') || '・入住 ' || s.start_date || '・最後看到 ' || to_char(i.last_seen at time zone 'Asia/Taipei', 'MM-DD HH24:MI'),
         left(i.extra::text, 120), i.last_seen
    from public.sync_issues i join public.airbnb_snapshots s on s.code = i.code
   where i.kind = 'orders' and s.start_date >= date '2026-10-01'
   order by i.last_seen desc limit 20
) d
order by 區, ord desc nulls last, 項目;
