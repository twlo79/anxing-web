/* ══════════════════════════════════════════════════════════════════════
 * migration_304  請款單新單也帶 UUID（跟舊單一樣）                         2026-09-30
 *
 * 【為什麼】David：「為何不要有 UUID 像舊單一樣？」「重新修一下」。
 *   296 之後，新單送 p_id = ''（空字串）→ 轉 uuid 失敗，「＋ 填寫請款」一張都存不進去。
 *   前端先用 `|| null` 擋住；這支改成正式做法：**畫面開新單時就產生一個 UUID**，
 *   新單、舊單存檔都帶 id。
 *
 * 【只改一處】save_purchase_request() 的單頭那一段：
 *   p_id 在資料庫裡**找不到** → 新建，而且 id 就用 p_id（以前是「p_id 是 null 才新建」）。
 *   其餘（項目的刪／改／增、security invoker、RLS、next_req_no）一個字都沒動 ——
 *   整支是從 296 原樣抄過來，只改那三行。
 *
 * 【順帶的好處】同一張新單按兩次儲存，第二次變成更新，不會建出兩張。
 *
 * 【相容】p_id = null 還是照舊新建（資料庫發 id）—— 還沒推新前端之前也能用。
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
  -- ★ migration_304：新單由畫面先給一個 UUID（跟舊單一樣帶著 id 來）。
  --   資料庫裡還沒有這個 id → 新建，而且就用這個 id；已經有 → 更新。
  --   同一張新單按兩次「儲存」，第二次會變成更新，不會建出兩張。
  --   p_id 是 null（舊畫面）→ 照舊新建、由資料庫發 id。
  if rid is null or not exists (select 1 from public.purchase_requests where id = rid) then
    rno := public.next_req_no();
    if rno is null then raise exception '拿不到請款單號'; end if;
    insert into public.purchase_requests
      (id, req_no, requester_id, status,
       payment_method, payee_bank_code, payee_account, payee_company, payee_tax_id, note,
       currency, fx_rate, payout_account, planned_transfer_on, no_voucher, voucher_no, shared_voucher,
       book, fee_mode, fee_amount, advance_category, advance_for_book, advance_usage)
    values
      (coalesce(rid, gen_random_uuid()), rno, uid, 'draft',
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
    perform public.record_migration('304_pr_new_uuid');
  end if;
end $do$;

commit;

-- ═══ 自檢（在 commit 後面 —— 看不到這張表就是整支回滾了） ═══════════
select 1 as 序, '這支跑過了沒' as 檢查,
       (select count(*)::text from public.schema_migrations where name = '304_pr_new_uuid') as 結果,
       case when exists (select 1 from public.schema_migrations where name = '304_pr_new_uuid') then '✅' else '❌' end as 判定
union all select 2, '新版在不在（函式裡找得到「找不到 → 新建」那一行）',
       (select count(*)::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = 'save_purchase_request' and p.prokind in ('f','p')
           and p.prosrc ~ 'coalesce\(rid, gen_random_uuid\(\)\)'),
       case when exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = 'save_purchase_request' and p.prokind in ('f','p')
           and p.prosrc ~ 'coalesce\(rid, gen_random_uuid\(\)\)') then '✅' else '❌ 還是舊版' end
union all select 3, '★ 還是 security invoker（RLS 照舊）',
       (select case when prosecdef then 'definer' else 'invoker' end from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = 'save_purchase_request'),
       case when (select not prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = 'save_purchase_request') then '✅' else '❌' end
union all select 4, '母體：請款單筆數（這支不動資料，跑前跑後要一樣）',
       (select count(*)::text from public.purchase_requests), 'ℹ'
order by 1;
