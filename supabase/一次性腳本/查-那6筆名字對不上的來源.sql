/* ══════════════════════════════════════════════════════════════════════
 * 查（只讀）：補全名時對不上的那 6 筆，系統裡的名字是怎麼來的                                2026-10-02
 *
 * 每一筆三個來源一起看：
 *   ① 訂單怎麼建的：imported_via（爬蟲／Excel／手動）、建立時間
 *   ② 爬蟲當時在 Airbnb 看到的名字（airbnb_snapshots.guest）—— 那是 Airbnb 給房東看的顯示名
 *   ③ 有沒有人改過名字：data_audit 裡 guest_name 的每一次變動、誰改的（user_id 空＝系統）
 * 一個字都不改。
 * ══════════════════════════════════════════════════════════ */
with c(code) as (values ('HME4WF2P5Q'), ('HMBPJT85ZD'), ('HMY5P2EQSR'), ('HM2WM5F25C'), ('HM4DRCAJ3K'), ('HM22KYSF5B'))
select o.order_key as 確認碼,
       o.guest_name as 系統現在,
       coalesce(s.guest, '（鏡像沒有）') as 爬蟲看到的,
       coalesce(o.imported_via, '?') || '・' || to_char(o.created_at at time zone 'Asia/Taipei', 'YYYY-MM-DD') as 怎麼建的,
       coalesce((
         select string_agg(
                  to_char(a.at at time zone 'Asia/Taipei', 'MM-DD HH24:MI') || ' '
                  || coalesce((select p.name from public.profiles p where p.id = a.user_id), case when a.user_id is null then '系統' else '?' end)
                  || '：' || coalesce(a.changes -> 'guest_name' ->> 0, '（空）') || ' → ' || coalesce(a.changes -> 'guest_name' ->> 1, '（空）'),
                  '；' order by a.at)
           from public.data_audit a
          where a.table_name = 'orders' and a.record_id = o.id and a.changes ? 'guest_name'), '沒人改過') as 名字改過的紀錄
  from c
  join public.orders o on o.order_key = c.code
  left join public.airbnb_snapshots s on s.code = c.code
 order by o.checkin desc;
