/* ══════════════════════════════════════════════════════════════════════
 * 查：今天建的請款單 —— 那張 test 到底有沒有存進去                         2026-09-30
 *
 * 【只讀】列出今天（台北時間）建立的請款單，最新的在上面。
 *   上一支證明了資料庫存得進去；這支看「你按的那幾下」實際留下了什麼。
 *
 * 【怎麼讀】
 *   · 有一張備註 test、NT$ 30,000 的草稿 → 其實存進去了，只是畫面沒說（見回覆）
 *   · 有好幾張一樣的 → 按了好幾次，每次都建了一張新的
 *   · 一張都沒有 → 存檔那一下根本沒送到資料庫，是畫面在前面就擋掉了
 *
 * ★ 看不到這張表 ＝ 這支本身有錯（不會改到任何東西），把紅字貼給我。
 * ══════════════════════════════════════════════════════════ */

select r.req_no                                         as 單號,
       coalesce(p.name, '—')                            as 申請人,
       r.status                                         as 狀態,
       r.total_amount                                   as 總額,
       r.payment_method                                 as 支出方式,
       left(coalesce(r.note, ''), 20)                   as 備註,
       (select count(*) from public.purchase_request_items i where i.request_id = r.id) as 項目數,
       to_char(r.created_at at time zone 'Asia/Taipei', 'HH24:MI:SS') as 建立時間
  from public.purchase_requests r
  left join public.profiles p on p.id = r.requester_id
 where (r.created_at at time zone 'Asia/Taipei')::date = (now() at time zone 'Asia/Taipei')::date
 order by r.created_at desc
 limit 30;
