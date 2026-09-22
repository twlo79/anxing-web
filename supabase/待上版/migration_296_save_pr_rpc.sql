/* ══════════════════════════════════════════════════════════════════════
 * migration_296  請款單存檔（單頭 ＋ 項目）包成 RPC                  2026-09-22
 *
 * 【為什麼】架構體檢 🔴1
 *   `purchases/page.tsx` 的 `save()` 是六步：單頭 insert/update → 撈既有項目
 *   → 刪掉拿掉的 → upsert 既有的 → insert 新的 → （送審）update status。
 *   中間任一步失敗 → **單頭改了、項目對不上**：總額（觸發器加總 items）跟
 *   畫面上填的不一樣，而錯誤訊息是一句 flash。
 *
 * 【★★★ 寫進去的內容跟現在一模一樣】
 *   單頭 20 欄逐字對應；項目的「刪／改／增」規則照 `lib/pr-items-save.ts` 的
 *   `planItemSave()`：id 存在於這張單 → update，否則 insert，沒送來的 → delete。
 *
 * 【★ 送審那一步不搬】前端在項目存好之後還要**上傳憑證圖**（瀏覽器裡的檔案，
 *   RPC 碰不到），上傳完才送審 —— 順序不能變。送審本來就有數列數，留在前端。
 *
 * 【★★ security invoker】RLS、`pri_write`（只認 draft/rejected）、`pr_guard_votes`、
 *   `sync_pr_total()` 全部照舊生效。任何一步被擋 → 整批回滾。
 *
 * `save_purchase_request(p_id, p_header, p_items)`
 *   p_id     null ＝ 新建（會呼叫 next_req_no()）
 *   p_header {payment_method, payee_bank_code, payee_account, payee_company, payee_tax_id,
 *             note, currency, fx_rate, payout_account, planned_transfer_on, no_voucher,
 *             voucher_no, shared_voucher, book, fee_mode, fee_amount,
 *             advance_category, advance_for_book, advance_usage, status?}
 *   p_items  [{id?, item_name, amount_original, amount, account_code, purpose_type,
 *              estate_id, property_id, note, sort, voucher_no, no_voucher}]
 *   回 {ok, request_id, req_no, new_ids: {sort: id}, deleted, updated, inserted}
 *
 * ★★ 自檢在 commit 後面 —— 看不到那張表就是整支回滾了。
 * ══════════════════════════════════════════════════════════ */

begin;

create or replace function public.save_purchase_request(p_id uuid, p_header jsonb, p_items jsonb)
returns jsonb language plpgsql as $fn$
declare
  uid     uuid := auth.uid();
  rid     uuid := p_id;
  rno     text;
  n       int;
  it      jsonb;
  iid     uuid;
  keep    uuid[] := '{}';
  n_del   int := 0; n_upd int := 0; n_ins int := 0;
  new_ids jsonb := '{}'::jsonb;
  h       jsonb := coalesce(p_header, '{}'::jsonb);
begin
  if uid is null then
    return jsonb_build_object('ok', false, 'code', 'NO_AUTH', 'message', '請重新登入');
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    return jsonb_build_object('ok', false, 'code', 'EMPTY', 'message', '至少要有一個請款項目');
  end if;

  -- ── ① 單頭 ──
  if rid is null then
    rno := public.next_req_no();
    if rno is null then raise exception '拿不到請款單號'; end if;
    insert into public.purchase_requests
      (req_no, requester_id, status,
       payment_method, payee_bank_code, payee_account, payee_company, payee_tax_id, note,
       currency, fx_rate, payout_account, planned_transfer_on, no_voucher, voucher_no, shared_voucher,
       book, fee_mode, fee_amount, advance_category, advance_for_book, advance_usage)
    values
      (rno, uid, 'draft',
       nullif(h->>'payment_method',''), nullif(h->>'payee_bank_code',''), nullif(h->>'payee_account',''),
       nullif(h->>'payee_company',''), nullif(h->>'payee_tax_id',''), nullif(h->>'note',''),
       coalesce(nullif(h->>'currency',''), 'TWD'), coalesce((h->>'fx_rate')::numeric, 1),
       nullif(h->>'payout_account',''), nullif(h->>'planned_transfer_on','')::date,
       coalesce((h->>'no_voucher')::boolean, false), nullif(h->>'voucher_no',''),
       coalesce((h->>'shared_voucher')::boolean, false),
       coalesce(nullif(h->>'book',''), 'anxing'), coalesce(nullif(h->>'fee_mode',''), 'included'),
       coalesce((h->>'fee_amount')::numeric, 0),
       nullif(h->>'advance_category',''), nullif(h->>'advance_for_book',''), nullif(h->>'advance_usage',''))
    returning id into rid;
    if rid is null then raise exception '建立失敗（多半是權限）—— 什麼都沒寫進去'; end if;
  else
    update public.purchase_requests set
       payment_method = nullif(h->>'payment_method',''), payee_bank_code = nullif(h->>'payee_bank_code',''),
       payee_account = nullif(h->>'payee_account',''), payee_company = nullif(h->>'payee_company',''),
       payee_tax_id = nullif(h->>'payee_tax_id',''), note = nullif(h->>'note',''),
       currency = coalesce(nullif(h->>'currency',''), 'TWD'), fx_rate = coalesce((h->>'fx_rate')::numeric, 1),
       payout_account = nullif(h->>'payout_account',''),
       planned_transfer_on = nullif(h->>'planned_transfer_on','')::date,
       no_voucher = coalesce((h->>'no_voucher')::boolean, false), voucher_no = nullif(h->>'voucher_no',''),
       shared_voucher = coalesce((h->>'shared_voucher')::boolean, false),
       book = coalesce(nullif(h->>'book',''), 'anxing'), fee_mode = coalesce(nullif(h->>'fee_mode',''), 'included'),
       fee_amount = coalesce((h->>'fee_amount')::numeric, 0),
       advance_category = nullif(h->>'advance_category',''), advance_for_book = nullif(h->>'advance_for_book',''),
       advance_usage = nullif(h->>'advance_usage',''),
       -- ★ 送審中／已核可被編輯 → 退回草稿（清票由 pr_apply_status 做，這裡不碰核可欄）
       status = coalesce(nullif(h->>'status',''), status)
     where id = rid;
    get diagnostics n = row_count;
    if n <> 1 then
      -- ★★★ 以前這裡 flash 之後 return；現在什麼都沒動（單頭沒改所以也沒東西可退）
      raise exception '存不進去：沒有任何一列被更新。通常是權限（這張單目前的狀態不允許你修改），請重新整理後再試';
    end if;
    select req_no into rno from public.purchase_requests where id = rid;
  end if;

  -- ── ② 項目：照 planItemSave() —— id 在這張單上 → update；否則 insert；沒送來的 → delete ──
  for it in select * from jsonb_array_elements(p_items) loop
    iid := nullif(it->>'id', '')::uuid;
    if iid is not null and exists (select 1 from public.purchase_request_items where id = iid and request_id = rid) then
      update public.purchase_request_items set
         item_name = btrim(it->>'item_name'),
         amount_original = (it->>'amount_original')::numeric,   -- null 就是 null（migration_218）
         amount = (it->>'amount')::numeric,
         account_code = nullif(it->>'account_code',''), purpose_type = coalesce(it->>'purpose_type','estate'),
         estate_id = nullif(it->>'estate_id','')::uuid, property_id = nullif(it->>'property_id','')::uuid,
         note = nullif(it->>'note',''), sort = coalesce((it->>'sort')::int, 0),
         voucher_no = nullif(it->>'voucher_no',''), no_voucher = coalesce((it->>'no_voucher')::boolean, false)
       where id = iid;
      get diagnostics n = row_count;
      if n <> 1 then raise exception '項目更新失敗（多半是權限）—— 整批退回'; end if;
      keep := keep || iid; n_upd := n_upd + 1;
    else
      insert into public.purchase_request_items
        (request_id, item_name, amount_original, amount, account_code, purpose_type,
         estate_id, property_id, note, sort, voucher_no, no_voucher)
      values
        (rid, btrim(it->>'item_name'), (it->>'amount_original')::numeric, (it->>'amount')::numeric,
         nullif(it->>'account_code',''), coalesce(it->>'purpose_type','estate'),
         nullif(it->>'estate_id','')::uuid, nullif(it->>'property_id','')::uuid,
         nullif(it->>'note',''), coalesce((it->>'sort')::int, 0),
         nullif(it->>'voucher_no',''), coalesce((it->>'no_voucher')::boolean, false))
      returning id into iid;
      if iid is null then raise exception '項目儲存失敗（多半是權限）—— 整批退回'; end if;
      keep := keep || iid; n_ins := n_ins + 1;
      new_ids := new_ids || jsonb_build_object(coalesce(it->>'sort','0'), iid::text);
    end if;
  end loop;

  -- 沒送來的刪掉（attachments 是 cascade，跟前端一樣 —— 前端在按下去之前已經問過憑證圖）
  delete from public.purchase_request_items where request_id = rid and not (id = any(keep));
  get diagnostics n_del = row_count;

  return jsonb_build_object('ok', true, 'code', 'OK', 'request_id', rid, 'req_no', rno,
    'new_ids', new_ids, 'deleted', n_del, 'updated', n_upd, 'inserted', n_ins);
end $fn$;
grant execute on function public.save_purchase_request(uuid, jsonb, jsonb) to authenticated;

do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('296_save_pr_rpc');
  end if;
end $do$;

commit;

-- 自檢（在 commit 後面 —— 看不到就是整支回滾了）
select 1 as 序, '這支跑過了沒' as 檢查,
       (select count(*)::text from public.schema_migrations where name = '296_save_pr_rpc') as 結果,
       case when exists (select 1 from public.schema_migrations where name = '296_save_pr_rpc') then '✅' else '❌' end as 判定
union all select 2, 'save_purchase_request 在不在',
       (select count(*)::text from pg_proc where proname = 'save_purchase_request'),
       case when exists (select 1 from pg_proc where proname = 'save_purchase_request') then '✅' else '❌' end
union all select 3, '★ security invoker（RLS 與 pri_write 照舊）',
       (select case when prosecdef then 'definer' else 'invoker' end from pg_proc where proname = 'save_purchase_request'),
       case when (select not prosecdef from pg_proc where proname = 'save_purchase_request') then '✅' else '❌' end
union all select 4, 'next_req_no 還在',
       (select count(*)::text from pg_proc where proname = 'next_req_no'),
       case when exists (select 1 from pg_proc where proname = 'next_req_no') then '✅' else '❌' end
union all select 5, '母體：請款單筆數（參考，這支不動它）',
       (select count(*)::text from public.purchase_requests), '✅ 只加函式'
order by 1;
