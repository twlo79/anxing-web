/* ══════════════════════════════════════════════════════════════════════
 * migration_295  短租移房包成 RPC                                     2026-09-22
 *
 * 【為什麼】架構體檢 🔴1
 *   `shortterm/page.tsx` 的 `doMove()` 是三步：主段 `orders.update`
 *   → 其他分段 `orders.delete`（硬刪）→ 逐段 `orders.insert`。
 *   第三步任何一段失敗 → **舊分段已經刪了、新分段只建了一半**，
 *   那幾晚的營收憑空消失，而畫面只有一句「建立分段失敗」。
 *   第二步的 delete 連錯誤都沒接。
 *
 * 【★★★ 寫進去的內容跟現在一模一樣】patch 欄位、刪除條件、分段欄位逐字照前端搬。
 *   移房鏈（move_chain）與備註追加的規則在 .ts 算好送來 —— 那些在前端有測試。
 * 【★★ security invoker】RLS、關帳守衛、認列觸發器全部照舊生效。
 *   任何一步被擋（含觸發器 raise）→ 整批回滾，舊分段還在。
 *
 * `move_order(p_grp, p_segs, p_patch)`
 *   p_grp   主段的 id（也是 move_group）
 *   p_segs  [{estate_id, property_id, room, from, to, nights, amount}]，第 0 段是主段
 *   p_patch {move_chain, note}  主段要一起改的兩欄（沒移房就不帶）
 *   其餘欄位（source、guest_name、account、imported_via）從主段抄。
 *
 * ★★ 自檢在 commit 後面 —— 看不到那張表就是整支回滾了。
 * ══════════════════════════════════════════════════════════ */

begin;

create or replace function public.move_order(p_grp uuid, p_segs jsonb, p_patch jsonb default '{}'::jsonb)
returns jsonb language plpgsql as $fn$
declare
  uid   uuid := auth.uid();
  main  public.orders;
  s0    jsonb;
  it    jsonb;
  i     int := 0;
  n     int;
  n_del int;
  n_seg int;
  multi boolean;
  chain text := nullif(p_patch->>'move_chain', '');
  v_note text := p_patch->>'note';
begin
  if uid is null then
    return jsonb_build_object('ok', false, 'code', 'NO_AUTH', 'message', '請重新登入');
  end if;
  if p_segs is null or jsonb_typeof(p_segs) <> 'array' or jsonb_array_length(p_segs) = 0 then
    return jsonb_build_object('ok', false, 'code', 'EMPTY', 'message', '沒有任何一段');
  end if;
  select * into main from public.orders where id = p_grp;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'message', '找不到這張訂單（可能剛被刪了）');
  end if;

  n_seg := jsonb_array_length(p_segs);
  multi := n_seg > 1;
  s0 := p_segs->0;

  -- 每一段先驗（還沒寫）
  for it in select * from jsonb_array_elements(p_segs) loop
    if coalesce(btrim(it->>'room'), '') = '' then
      return jsonb_build_object('ok', false, 'code', 'NO_ROOM', 'message', '每段都要選房源');
    end if;
    if (it->>'from') is null or (it->>'to') is null or (it->>'to')::date <= (it->>'from')::date then
      return jsonb_build_object('ok', false, 'code', 'BAD_RANGE', 'message', '每段至少 1 晚（日期需在期間內）');
    end if;
  end loop;

  -- ① 主段（欄位逐字照前端的 patch）
  update public.orders
     set estate_id    = nullif(s0->>'estate_id', '')::uuid,
         property_id  = nullif(s0->>'property_id', '')::uuid,
         property_raw = s0->>'room',
         checkin      = (s0->>'from')::date,
         checkout     = (s0->>'to')::date,
         nights       = coalesce((s0->>'nights')::int, 0),
         amount       = coalesce((s0->>'amount')::numeric, 0),
         move_group   = case when multi then p_grp else null end,
         move_chain   = coalesce(chain, move_chain),
         note         = coalesce(v_note, note)
   where id = p_grp;
  get diagnostics n = row_count;
  if n <> 1 then raise exception '主段沒有更新（多半是權限或關帳）—— 什麼都沒動'; end if;

  -- ② 其他分段硬刪（不進回收桶 —— 下面馬上重建，跟前端一樣）
  delete from public.orders where move_group = p_grp and id <> p_grp;
  get diagnostics n_del = row_count;

  -- ③ 重建分段（欄位逐字照前端）
  for it in select * from jsonb_array_elements(p_segs) loop
    if i > 0 then
      insert into public.orders
        (order_key, source, estate_id, property_id, property_raw, guest_name,
         checkin, checkout, nights, amount, deposit, account, note, move_chain, move_group, imported_via)
      values
        (format('MOVE_%s_%s_%s', left(p_grp::text, 8), i, (extract(epoch from clock_timestamp()) * 1000)::bigint),
         main.source, nullif(it->>'estate_id', '')::uuid, nullif(it->>'property_id', '')::uuid, it->>'room',
         main.guest_name, (it->>'from')::date, (it->>'to')::date,
         coalesce((it->>'nights')::int, 0), coalesce((it->>'amount')::numeric, 0), 0,
         main.account, format('移房 %s', coalesce(chain, '')), chain, p_grp, 'manual');
      get diagnostics n = row_count;
      if n <> 1 then
        -- ★★★ 以前這裡是 flash「建立分段失敗」而舊分段已經刪了；現在主段、刪除、前幾段一起退回
        raise exception '第 % 段建不起來（多半是權限或關帳）—— 整次移房退回，舊的分段還在', i + 1;
      end if;
    end if;
    i := i + 1;
  end loop;

  return jsonb_build_object('ok', true, 'code', 'OK', 'segments', n_seg, 'deleted', n_del,
    'message', case when multi then format('已移房，拆成 %s 段', n_seg) else '已更新' end);
end $fn$;
grant execute on function public.move_order(uuid, jsonb, jsonb) to authenticated;

do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('295_move_order_rpc');
  end if;
end $do$;

commit;

-- 自檢（在 commit 後面 —— 看不到就是整支回滾了）
select 1 as 序, '這支跑過了沒' as 檢查,
       (select count(*)::text from public.schema_migrations where name = '295_move_order_rpc') as 結果,
       case when exists (select 1 from public.schema_migrations where name = '295_move_order_rpc') then '✅' else '❌' end as 判定
union all select 2, 'move_order 在不在',
       (select count(*)::text from pg_proc where proname = 'move_order'),
       case when exists (select 1 from pg_proc where proname = 'move_order') then '✅' else '❌' end
union all select 3, '★ security invoker（RLS 與關帳守衛照舊）',
       (select case when prosecdef then 'definer' else 'invoker' end from pg_proc where proname = 'move_order'),
       case when (select not prosecdef from pg_proc where proname = 'move_order') then '✅' else '❌' end
union all select 4, '母體：移過房的訂單（參考，這支不動它）',
       (select count(*)::text from public.orders where move_group is not null), '✅ 只加函式'
order by 1;
