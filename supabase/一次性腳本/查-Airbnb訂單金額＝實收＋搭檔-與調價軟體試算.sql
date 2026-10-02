/* ══════════════════════════════════════════════════════════════════════
 * 查（只讀）：Airbnb 訂單金額 ＝ 實收 ＋ 搭檔？覆蓋率多少？調價軟體 1.5% 每月每物業試算        2026-10-02
 *
 * 實收（You earn）＝ airbnb_snapshots.earnings；搭檔（Co-host payout）＝ .cohost；
 * 端點建單時寫的 orders.amount ＝ earnings ＋ cohost。這支一次看四件事：
 *   ① 有爬蟲明細的訂單，金額對不對得上（差超過 1 元的列出來）
 *   ② 覆蓋率：Airbnb 訂單裡，幾張有明細、幾張沒有（沒有的照編號開頭分：HM 確認碼／AB_ 舊匯入／其他）
 *   ③ 你截圖那一張 HM54DSP3QZ
 *   ④ 調價軟體試算：每月 × 每物業，Airbnb 營收認列（照住宿天數拆到各月）× 1.5%
 *   ⑤ 會計科目清單（找調價軟體要掛哪一科）
 *   ⑥ 爬蟲自動建的訂單從哪天開始（全量回補時用來劃線：比這更早的單不能讓爬蟲自動新增，會跟舊匯入的重複）
 * 一個字都不改。
 * ══════════════════════════════════════════════════════════ */
with ab as (
  select o.id, o.order_key, o.amount, o.checkin, o.imported_via, o.guest_name,
         s.earnings, s.cohost, s.revenue
    from public.orders o
    left join public.airbnb_snapshots s on s.code = o.order_key
   where o.source = 'airbnb'
),
chk as (select * from ab where earnings is not null)
select 1 as 序, '① 有明細的 Airbnb 訂單' as 項目,
       (select count(*)::text from chk) || ' 張；金額＝實收＋搭檔（±1 元內）' ||
       (select count(*) from chk where abs(coalesce(amount,0) - (coalesce(earnings,0) + coalesce(cohost,0))) <= 1) || ' 張；有搭檔的 ' ||
       (select count(*) from chk where coalesce(cohost,0) > 0) || ' 張；搭檔沒抓到（null）' || (select count(*) from chk where cohost is null) || ' 張' as 結果,
       coalesce((select string_agg(order_key || ' 訂單 ' || round(amount) || ' ≠ 實收 ' || round(earnings) || '＋搭檔 ' || coalesce(round(cohost)::text, '?')
                               || '（差 ' || round(amount - earnings - coalesce(cohost,0)) || '）', '；')
                   from (select * from chk where abs(coalesce(amount,0) - (coalesce(earnings,0) + coalesce(cohost,0))) > 1 order by checkin desc limit 15) x), '全部對得上') as 明細
union all
select 2, '② 覆蓋率（Airbnb 訂單共 ' || (select count(*) from ab) || ' 張）',
       '有明細 ' || (select count(*) from ab where earnings is not null) || '；沒有明細 ' || (select count(*) from ab where earnings is null),
       '沒有明細的：HM 確認碼 ' || (select count(*) from ab where earnings is null and order_key like 'HM%')
       || '（' || coalesce((select min(checkin)::text || '～' || max(checkin)::text from ab where earnings is null and order_key like 'HM%'), '—') || '）'
       || '・AB_ 舊匯入 ' || (select count(*) from ab where earnings is null and order_key like 'AB\_%')
       || '（' || coalesce((select min(checkin)::text || '～' || max(checkin)::text from ab where earnings is null and order_key like 'AB\_%'), '—') || '）'
       || '・其他 ' || (select count(*) from ab where earnings is null and order_key not like 'HM%' and order_key not like 'AB\_%')
union all
select 3, '③ HM54DSP3QZ',
       coalesce((select '訂單 ' || coalesce(round(o.amount)::text, '—') || '・' || o.checkin || '～' || o.checkout || '・' || coalesce(o.guest_name, '') from public.orders o where o.order_key = 'HM54DSP3QZ'), '（orders 沒有這張）'),
       coalesce((select '快照：實收 ' || earnings || '＋搭檔 ' || coalesce(cohost::text, 'null') || '＝' || revenue || '・' || start_date || '～' || end_date from public.airbnb_snapshots where code = 'HM54DSP3QZ'), '（快照沒有這張 → 爬蟲沒抓過）')
union all
select * from (
  select 4, '④ ' || r.ym || ' ' || coalesce(e.name, '（沒物業）'),
         'Airbnb 營收 ' || to_char(round(sum(r.month_amount)), 'FM999,999,999') || ' × 1.5% ＝ ' || to_char(round(sum(r.month_amount) * 0.015), 'FM999,999,999'),
         count(distinct r.order_id) || ' 張訂單'
    from public.revenue_recognitions r
    left join public.estates e on e.id = r.estate_id
   where r.source = 'airbnb' and r.ym between '202601' and '202610'
   group by r.ym, e.name
   order by r.ym desc, e.name
) t
union all
select 5, '⑤ 會計科目',
       (select count(*)::text from public.account_codes),
       (select string_agg(code || ' ' || name, '・' order by code) from public.account_codes)
union all
select 6, '⑥ 爬蟲自動建的訂單',
       (select count(*)::text from public.orders where imported_via = 'auto') || ' 張',
       '最早入住 ' || coalesce((select min(checkin)::text from public.orders where imported_via = 'auto'), '—')
       || '・最早建立 ' || coalesce((select to_char(min(created_at) at time zone 'Asia/Taipei', 'YYYY-MM-DD') from public.orders where imported_via = 'auto'), '—')
       || '・快照最早入住 ' || coalesce((select min(start_date)::text from public.airbnb_snapshots), '—')
order by 1, 2 desc;
