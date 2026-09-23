/* ══════════════════════════════════════════════════════════════════════
 * migration_293  備品盤點包成 RPC                                     2026-09-22
 *
 * 【為什麼】架構體檢 🔴1
 *   `supply-tab.tsx` 的 `saveCount()` 是兩步：先 `supply_count.upsert`
 *   再 `supply_txn.insert`（盤點調整）。第二步失敗 → **盤點存了、調整那筆沒進**
 *   → 餘量從此對不上，而畫面只是一句錯誤訊息，下個月再盤時系統數字已經是錯的。
 *
 * 【★★★ 寫進去的內容跟現在一模一樣】欄位、值、順序逐字照前端搬。
 * 【★★ security invoker】RLS 照舊。每一步數列數，0 就 raise → 整批回滾。
 *
 * `save_supply_count(p_ym, p_on, p_rows)`
 *   p_rows: [{item_id, system_qty, counted_qty, diff, reason}]
 *   diff ≠ 0 的才產生一筆 kind='adjust' 的流水，掛 count_id。
 *
 * ★★ 自檢在 commit 後面 —— 看不到那張表就是整支回滾了。
 * ══════════════════════════════════════════════════════════ */

begin;

create or replace function public.save_supply_count(p_ym text, p_on date, p_rows jsonb)
returns jsonb language plpgsql as $fn$
declare
  uid   uuid := auth.uid();
  it    jsonb;
  cid   uuid;
  n     int;
  n_cnt int := 0;
  n_adj int := 0;
  v_item uuid; v_sys numeric; v_cnt numeric; v_diff numeric; v_reason text;
begin
  if uid is null then
    return jsonb_build_object('ok', false, 'code', 'NO_AUTH', 'message', '請重新登入');
  end if;
  if p_ym !~ '^\d{6}$' then
    return jsonb_build_object('ok', false, 'code', 'BAD_YM', 'message', '月份格式不對（要六碼，例 202609）');
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    return jsonb_build_object('ok', false, 'code', 'EMPTY', 'message', '一個都還沒盤');
  end if;
  if p_on is null then p_on := (now() at time zone 'Asia/Taipei')::date; end if;

  for it in select * from jsonb_array_elements(p_rows) loop
    begin
      v_item := (it->>'item_id')::uuid;
      v_sys  := coalesce((it->>'system_qty')::numeric, 0);
      v_cnt  := (it->>'counted_qty')::numeric;
      v_diff := coalesce((it->>'diff')::numeric, v_cnt - v_sys);
      v_reason := nullif(btrim(coalesce(it->>'reason', '')), '');
    exception when others then
      return jsonb_build_object('ok', false, 'code', 'BAD_ROW', 'message', format('有一列格式不對：%s', it::text));
    end;
    if v_cnt is null then
      return jsonb_build_object('ok', false, 'code', 'NO_COUNT', 'message', '有一列沒填盤到的數量');
    end if;
    -- ★ diff 以資料庫算的為準；前端送來的要對得上（跟 request_leave_batch 同一個做法）
    if abs(v_diff - (v_cnt - v_sys)) > 0.005 then
      return jsonb_build_object('ok', false, 'code', 'DIFF_MISMATCH',
        'message', format('有一列的差異對不上：畫面 %s，系統算 %s。請重新整理再盤一次。', v_diff, v_cnt - v_sys));
    end if;

    -- ① 盤點紀錄（一個品項一個月一筆，重盤覆蓋 —— supply_count_uniq）
    insert into public.supply_count (item_id, ym, system_qty, counted_qty, diff, reason, counted_by)
    values (v_item, p_ym, v_sys, v_cnt, v_cnt - v_sys, v_reason, uid)
    on conflict (item_id, ym) do update
      set system_qty = excluded.system_qty, counted_qty = excluded.counted_qty,
          diff = excluded.diff, reason = excluded.reason, counted_by = excluded.counted_by,
          counted_at = now()
    returning id into cid;
    if cid is null then raise exception '盤點紀錄沒有寫進去（多半是權限）—— 整批退回'; end if;
    n_cnt := n_cnt + 1;

    -- ② 差異不是 0 才產生調整流水（qty=0 資料庫會擋，而且沒意義）
    if (v_cnt - v_sys) <> 0 then
      insert into public.supply_txn (item_id, kind, qty, happened_on, note, count_id, created_by)
      values (v_item, 'adjust', v_cnt - v_sys, p_on,
              format('%s-%s 盤點調整', left(p_ym, 4), right(p_ym, 2)), cid, uid);
      get diagnostics n = row_count;
      if n <> 1 then raise exception '盤點調整沒有寫進去（多半是權限）—— 盤點紀錄一起退回'; end if;
      n_adj := n_adj + 1;
    end if;
  end loop;

  return jsonb_build_object('ok', true, 'code', 'OK', 'counted', n_cnt, 'adjusted', n_adj,
    'message', format('盤點完成，產生 %s 筆調整', n_adj));
end $fn$;
grant execute on function public.save_supply_count(text, date, jsonb) to authenticated;

do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('293_supply_count_rpc');
  end if;
end $do$;

commit;

-- 自檢（在 commit 後面 —— 看不到就是整支回滾了）
select 1 as 序, '這支跑過了沒' as 檢查,
       (select count(*)::text from public.schema_migrations where name = '293_supply_count_rpc') as 結果,
       case when exists (select 1 from public.schema_migrations where name = '293_supply_count_rpc') then '✅' else '❌' end as 判定
union all select 2, 'save_supply_count 在不在',
       (select count(*)::text from pg_proc where proname = 'save_supply_count'),
       case when exists (select 1 from pg_proc where proname = 'save_supply_count') then '✅' else '❌' end
union all select 3, '★ security invoker（RLS 照舊）',
       (select case when prosecdef then 'definer' else 'invoker' end from pg_proc where proname = 'save_supply_count'),
       case when (select not prosecdef from pg_proc where proname = 'save_supply_count') then '✅' else '❌' end
union all select 4, 'supply_count_uniq 還在（on conflict 靠它）',
       (select count(*)::text from pg_indexes where indexname = 'supply_count_uniq'),
       case when exists (select 1 from pg_indexes where indexname = 'supply_count_uniq') then '✅' else '❌ 沒有它 on conflict 會炸' end
union all select 5, '母體：既有盤點筆數（參考，這支不動它）',
       (select count(*)::text from public.supply_count), '✅ 只加函式'
order by 1;
