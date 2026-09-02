/*
 * audit_one_purchase_request —— 一張請款單的付款資訊與完整編輯紀錄（唯讀）
 * ============================================================
 * 2026-09-01。「編輯紀錄」頁只有兩個下拉 ＋ 最近 300 筆，沒有搜尋框 ——
 * 舊的單子翻不到，只能走這裡。
 *
 * ★★★ 只有第 44 行的關鍵字要改，其餘整份照貼。
 *   **貼完不要把游標停在某一行按 Run —— 要跑整份**（見下）。
 *
 * ============================================================
 * 【畫面上那兩個值存在哪】
 *
 *   「預定 2026-09-21」   → purchase_requests.planned_transfer_on
 *   「8088」（支出帳戶）   → purchase_requests.payout_account
 *
 *   順帶:
 *   「匯款」               → payment_method
 *   受款人帳號             → payee_bank_code ／ payee_account ／ payee_company
 *   實際出款日             → purchased_on（**跟預定日不同**，見下）
 *
 * ★★ `planned_transfer_on` 是**預定**，`purchased_on` 是**實際**。
 *   兩個都查出來 —— 只看預定日的話，一張排了 9/21 但實際 9/25 才匯的單，
 *   看起來會像準時付了。
 *
 * ============================================================
 * 【★★ 關鍵字為什麼不放在自己的 CTE 裡】（2026-09-01 踩過）
 *
 * 上一版寫成 `with kw as (select '關鍵字'::text as q), …`。
 * 那一行**單獨看就是一個合法的查詢** —— 游標停在上面按 Run，
 * 編輯器就只跑它，結果是一張只有 `q` 一欄的表，而且不會報錯。
 *
 * ★ 現在關鍵字埋在 `where` 裡，選不出一段可以單獨執行的東西。
 *   靠 `concat_ws` 把五個欄位串起來比一次 —— 所以關鍵字**只出現一次**。
 *
 * ============================================================
 * 【★★ 為什麼是 left join，不是 join】
 *
 * `join` 的話，「關鍵字打錯」跟「這張單沒有任何編輯紀錄」都是空結果 ——
 * 而那兩件事的下一步完全不同。`left join` 讓對到的單一定至少出現一列：
 * 時間是空的就代表「有這張單，但它沒被改過」。
 */

with hit as (
  select distinct r.id, r.req_no, r.status, r.total_amount,
         r.planned_transfer_on, r.payout_account, r.payment_method,
         r.purchased_on, r.payee_company, r.payee_bank_code, r.payee_account
    from public.purchase_requests r
    left join public.purchase_request_items i on i.request_id = r.id
   where concat_ws(' ', r.req_no, i.item_name, i.note, r.note, r.payee_company)
         ilike '%' || '115/7-8月管理服務費' || '%'          -- ★★★ 改這裡
),

/*
 * 這幾張單牽涉到的所有 record_id —— **單頭與單身都要**。
 *
 * ★ 金額改在項目上、預定付款日與帳戶改在單頭上。
 *   只查一邊會漏掉一半，而漏掉的那一半通常正是要找的那一筆。
 */
ids as (
  select h.id::text as rid, h.*, '單頭' as part from hit h
  union all
  select i.id::text, h.*, '項目'
    from public.purchase_request_items i
    join hit h on h.id = i.request_id
)

select
  ids.req_no                              as "單號",
  ids.status                              as "目前狀態",
  round(ids.total_amount)                 as "金額",
  -- ★★★ 你要的兩個。每一列都帶著，掃一眼就有答案
  ids.planned_transfer_on                 as "預定付款日",
  ids.payout_account                      as "支出帳戶",
  ids.purchased_on                        as "實際出款日",
  ids.payment_method                      as "收款方式",
  concat_ws(' / ', ids.payee_company, ids.payee_bank_code, ids.payee_account) as "受款人",
  ids.part                                as "位置",
  a.at                                    as "改動時間",
  coalesce(s.name,
           case when a.id is null then null
                when a.user_id is null then '系統／爬蟲'
                else left(a.user_id::text, 8) end)  as "誰改的",
  case a.action when 'insert' then '新增'
                when 'update' then '修改'
                when 'delete' then '刪除'
                else a.action end         as "動作",
  a.label                                 as "對象",
  /*
   * ★ `updated_at` 之類的雜訊濾掉 —— 它每次都變，
   *   留著會把真正的變動蓋掉（跟畫面上的 AUDIT_SKIP 同一份名單）。
   */
  case
    when a.id is null then '（這張單沒有任何編輯紀錄）'
    when jsonb_typeof(a.changes) <> 'object' then a.changes::text
    else coalesce((
      select string_agg(k || '：' || coalesce(a.changes->k->>'old', '(空)')
                          || ' → ' || coalesce(a.changes->k->>'new', '(空)'), E'\n')
        from jsonb_object_keys(a.changes) k
       where k not in ('updated_at', 'created_at', 'id')
    ), '（只有時間戳記變動）')
  end                                     as "改了什麼"
from ids
left join public.data_audit a on a.record_id::text = ids.rid
left join public.staff s on s.auth_uid = a.user_id
order by ids.req_no, a.at desc nulls last;
