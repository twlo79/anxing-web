/* ══════════════════════════════════════════════════════════════════════
 * migration_294  採購需求 → 請款單 包成 RPC                          2026-09-22
 *
 * 【為什麼】架構體檢 🔴1
 *   `demand-tab.tsx` 的 `makeRequest()` 是三步：`purchase_requests.insert`
 *   → `purchase_request_items.insert` → 逐筆 `purchase_demand_items.update`。
 *   第三步失敗 → **請款單建了、需求項目還標「未採購」** → 下次又被帶進另一張
 *   請款單，**同一筆錢請兩次**。程式自己的註解寫著「沒回寫的那幾項不要再帶一次」——
 *   那是把守門交給使用者記得。
 *
 * 【★★★ 寫進去的內容跟現在一模一樣】欄位、值、順序逐字照前端搬（含 `next_req_no()`）。
 * 【★★ security invoker】RLS 照舊。每一步數列數，0 就 raise → 整批回滾。
 *
 * `demand_to_request(p_demand uuid, p_items jsonb)`
 *   p_items: [{demand_item_id, item_name, purpose_type, estate_id, note, sort}]
 *   （item_name / note 由前端算好送來 —— demandNote() 那條規則在 .ts 有測試，不搬）
 *
 * ★★ 自檢在 commit 後面 —— 看不到那張表就是整支回滾了。
 * ══════════════════════════════════════════════════════════ */

begin;

create or replace function public.demand_to_request(p_demand uuid, p_items jsonb)
returns jsonb language plpgsql as $fn$
declare
  uid    uuid := auth.uid();
  dm     public.purchase_demands;
  no     text;
  pr_id  uuid;
  it     jsonb;
  ri_id  uuid;
  n      int;
  cnt    int := 0;
  v_did  uuid; v_name text; v_pt text; v_est uuid; v_note text; v_sort int;
  st     text;
begin
  if uid is null then
    return jsonb_build_object('ok', false, 'code', 'NO_AUTH', 'message', '請重新登入');
  end if;
  select * into dm from public.purchase_demands where id = p_demand;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'message', '找不到這張需求單');
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    return jsonb_build_object('ok', false, 'code', 'EMPTY', 'message', '先勾要進請款的項目');
  end if;

  -- ── 先檢查每一項還能不能帶（還沒寫任何東西）──
  for it in select * from jsonb_array_elements(p_items) loop
    v_did := (it->>'demand_item_id')::uuid;
    select status into st from public.purchase_demand_items where id = v_did and demand_id = p_demand;
    if not found then
      return jsonb_build_object('ok', false, 'code', 'BAD_ITEM', 'message', '有一項不在這張需求單上（可能剛被別人改過），請重新整理');
    end if;
    if st not in ('pending', 'quoted') then
      return jsonb_build_object('ok', false, 'code', 'TAKEN',
        'message', format('「%s」已經是「%s」，不能再帶進請款。請重新整理。', coalesce(it->>'item_name',''), st));
    end if;
  end loop;

  -- ① 單號 ＋ 草稿請款單（照前端逐字）
  no := public.next_req_no();
  if no is null then raise exception '拿不到請款單號'; end if;

  insert into public.purchase_requests (req_no, requester_id, status, note)
  values (no, uid, 'draft', btrim(format('從採購需求 %s 帶入', coalesce(dm.demand_no, ''))))
  returning id into pr_id;
  if pr_id is null then raise exception '建不出請款單（多半是權限）—— 什麼都沒寫進去'; end if;

  -- ② 項目 ＋ ③ 回寫需求項目，一項一項來（同一個交易）
  for it in select * from jsonb_array_elements(p_items) loop
    v_did  := (it->>'demand_item_id')::uuid;
    v_name := btrim(coalesce(it->>'item_name', ''));
    v_pt   := coalesce(it->>'purpose_type', 'estate');
    v_est  := case when v_pt = 'office' then null else nullif(it->>'estate_id', '')::uuid end;
    v_note := nullif(it->>'note', '');
    v_sort := coalesce((it->>'sort')::int, cnt);

    -- ★ 金額是 null 不是 0（migration_218）
    insert into public.purchase_request_items
      (request_id, item_name, amount, purpose_type, estate_id, note, sort)
    values (pr_id, v_name, null, v_pt, v_est, v_note, v_sort)
    returning id into ri_id;
    if ri_id is null then raise exception '項目帶不進去（多半是權限）—— 請款單一起退回'; end if;

    update public.purchase_demand_items
       set status = 'requested', request_item_id = ri_id
     where id = v_did;
    get diagnostics n = row_count;
    if n <> 1 then
      -- ★★★ 以前這裡只 flash「不要再帶一次」；現在整張請款單一起退回
      raise exception '需求項目沒有回寫（多半是權限）—— 請款單與項目一起退回，什麼都沒寫進去';
    end if;
    cnt := cnt + 1;
  end loop;

  return jsonb_build_object('ok', true, 'code', 'OK', 'request_id', pr_id, 'req_no', no, 'count', cnt,
    'message', format('已建請款單 %s，帶入 %s 項', no, cnt));
end $fn$;
grant execute on function public.demand_to_request(uuid, jsonb) to authenticated;

do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('294_demand_to_request_rpc');
  end if;
end $do$;

commit;

-- 自檢（在 commit 後面 —— 看不到就是整支回滾了）
select 1 as 序, '這支跑過了沒' as 檢查,
       (select count(*)::text from public.schema_migrations where name = '294_demand_to_request_rpc') as 結果,
       case when exists (select 1 from public.schema_migrations where name = '294_demand_to_request_rpc') then '✅' else '❌' end as 判定
union all select 2, 'demand_to_request 在不在',
       (select count(*)::text from pg_proc where proname = 'demand_to_request'),
       case when exists (select 1 from pg_proc where proname = 'demand_to_request') then '✅' else '❌' end
union all select 3, '★ security invoker（RLS 照舊）',
       (select case when prosecdef then 'definer' else 'invoker' end from pg_proc where proname = 'demand_to_request'),
       case when (select not prosecdef from pg_proc where proname = 'demand_to_request') then '✅' else '❌' end
union all select 4, 'next_req_no 還在（這支靠它）',
       (select count(*)::text from pg_proc where proname = 'next_req_no'),
       case when exists (select 1 from pg_proc where proname = 'next_req_no') then '✅' else '❌' end
union all select 5, '母體：需求單筆數（參考，這支不動它）',
       (select count(*)::text from public.purchase_demands), '✅ 只加函式'
order by 1;
