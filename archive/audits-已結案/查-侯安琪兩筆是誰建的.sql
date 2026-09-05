/*
 * 查-侯安琪兩筆是誰建的 —— 系統長出來的，還是人工 key 的？（唯讀）
 * ============================================================
 * 2026-09-04。使用者:「幫我查侯安琪 為何有兩筆／我之前刪一筆，
 * 是系統多創還是人工 key 的」。
 *
 * ★★★ 分得出來的欄位全都不在畫面上:
 *
 *     deposits.order_id   有值 → 系統。押金列是 trg_sync_order_deposits
 *                                跟著訂單自動長的，沒有人按過「新增押金」
 *     deposits.is_manual  true → 人工。有人在押金頁按新增
 *     data_audit.user_id  null → 系統／爬蟲／觸發器連帶；有值 → 那個人
 *
 * ★★ 原本寫成一大段 union 一次回答所有問題，貼進 SQL Editor 被截斷
 *   （syntax error at end of input / LINE 0）。拆成四支短的，一次跑一支 ——
 *   而且拆開之後結果是正常的表格，比一整塊文字好讀。
 *
 * 全部只有 select。
 */


-- ══════════════════════════════════════════════════
-- ① 侯安琪的訂單與押金 —— ★「誰建的」那一欄就是答案
-- ══════════════════════════════════════════════════
select
  '押金' as "類型",
  to_char(d.created_at at time zone 'Asia/Taipei', 'MM-DD HH24:MI:SS') as "建立時間",
  case when d.is_manual              then '★人工 key 的（押金頁按新增）'
       when d.order_id is not null   then '系統：觸發器跟著訂單長的'
       when d.contract_id is not null then '系統：觸發器跟著契約長的'
       else '？無來源也沒標人工' end as "誰建的",
  d.currency || ' ' || d.amount as "金額",
  coalesce(d.received_on::text, '未收') as "收款日",
  d.id::text as "id"
from deposits d
where d.guest_name ilike '%侯安琪%'
union all
select
  '訂單',
  to_char(o.created_at at time zone 'Asia/Taipei', 'MM-DD HH24:MI:SS'),
  -- OO_/PV_=人在短租頁新增　FEE_=加費子單　MOVE_=移房　CFEE_=契約加費　其餘=平台匯入
  coalesce(o.imported_via, '?') || ' / ' || left(o.order_key, 14),
  o.amount::text,
  o.checkin::text,
  o.id::text
from orders o
where o.guest_name ilike '%侯安琪%'
order by 2;


-- ══════════════════════════════════════════════════
-- ② ★★ 個案還是通病 —— 「相差秒」分辨程式的錯 vs 操作重複
--    差幾秒   = 連點造成的重複送出（程式的錯）
--    差幾小時 = 有人真的又 key 了一次（操作重複）
-- ══════════════════════════════════════════════════
select
  coalesce(guest_name, '?') as "房客",
  checkin as "入住",
  amount as "金額",
  count(*) as "筆數",
  to_char(min(created_at) at time zone 'Asia/Taipei', 'MM-DD HH24:MI:SS') as "最早",
  to_char(max(created_at) at time zone 'Asia/Taipei', 'MM-DD HH24:MI:SS') as "最晚",
  round(extract(epoch from (max(created_at) - min(created_at)))) as "相差秒"
from orders
where parent_order_id is null
group by coalesce(guest_name, '?'), checkin, amount
having count(*) > 1
order by max(created_at) desc
limit 50;


-- ══════════════════════════════════════════════════
-- ③ 編輯紀錄 —— 操作人是「系統／觸發器」就不是人做的
-- ══════════════════════════════════════════════════
select
  to_char(a.at at time zone 'Asia/Taipei', 'MM-DD HH24:MI:SS') as "時間",
  case when a.user_id is null then '系統／觸發器'
       else coalesce(p.name, '已刪除的帳號') end as "操作人",
  a.table_name as "資料",
  a.action as "動作",
  coalesce(a.label, '—') as "對象",
  left(a.changes::text, 200) as "改了什麼"
from data_audit a
left join profiles p on p.id = a.user_id
where coalesce(a.label, '') ilike '%侯安琪%'
   or coalesce(a.changes::text, '') ilike '%侯安琪%'
order by a.at;


-- ══════════════════════════════════════════════════
-- ④ 回收桶 —— 你刪掉的那筆原本是什麼、誰刪的
-- ══════════════════════════════════════════════════
select
  to_char(t.deleted_at at time zone 'Asia/Taipei', 'MM-DD HH24:MI:SS') as "刪除時間",
  coalesce(p.name, '系統') as "刪除者",
  t.table_name as "資料",
  coalesce(t.label, '—') as "對象",
  coalesce(t.reason, '—') as "原因",
  left(t.payload::text, 400) as "原始內容"
from trash t
left join profiles p on p.id = t.deleted_by
where coalesce(t.label, '') ilike '%侯安琪%'
   or coalesce(t.payload::text, '') ilike '%侯安琪%'
order by t.deleted_at;
