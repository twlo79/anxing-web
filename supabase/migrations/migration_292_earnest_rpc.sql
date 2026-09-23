/* ══════════════════════════════════════════════════════════════════════
 * migration_292  訂金的兩條出路包成 RPC（沒收、轉押金）             2026-09-22
 *
 * ══════════════════════════════════════════════════════════
 * 【為什麼】架構體檢 🔴1
 *
 *   `deposits/page.tsx` 的 `forfeitEarnest()` 是兩步：先 `orders.insert`
 *   再 `deposits.update`。第二步失敗 → **收入建了、訂金還標「未沒收」**，
 *   下次再按就是第二筆收入。程式自己的註解也承認「中間斷掉會留孤兒收入」。
 *
 *   `convertEarnest()` 是四步（收款 insert → 押金 update ×2 → 訂金 update），
 *   後面三步**連回傳都沒接**。任一步失敗 → 押金收了一筆、訂金還是訂金。
 *
 *   前端沒有交易。要「三步一起成功或一起失敗」只有一條路：包成一支 RPC。
 *   `repay_advances()`（286）、`request_leave_batch()`（291）都是這樣做的。
 *
 * 【★★★ 寫進去的內容跟現在一模一樣】
 *   欄位、值、順序全部照前端逐字搬。差別只有：任一步失敗整批回滾。
 *   使用者按下去看到的資料相同 —— 不同的只有某一步失敗的那一刻。
 *
 * 【★★ security invoker，不是 definer】
 *   故意讓 RLS 照舊生效 —— 誰現在按得了，之後也一樣；誰現在被擋，之後也一樣。
 *   RLS 擋下來時 UPDATE 回 0 列（CLAUDE.md 第一條坑），所以每一步都數列數，
 *   0 就 raise → 整批回滾。以前是「安靜成功」，現在是「講出來並且什麼都不留」。
 *
 * 【這支做什麼】
 *   1. `forfeit_earnest(p_dep, p_on)`  沒收：建收入單 ＋ 回寫訂金，一個交易
 *   2. `convert_earnest(p_dep, p_on)`  轉押：記收款 ＋ 補押金欄位 ＋ 訂金結案，一個交易
 *   兩支都回 jsonb {ok, message, ...}；擋住的原因回 ok=false（前端顯示），
 *   **寫入之後**的錯誤一律 raise（才會回滾）。
 *
 * ★★ 自檢在 commit 後面 —— 看不到那張表就是整支回滾了。
 * ══════════════════════════════════════════════════════════ */

begin;

-- ── 1. 沒收訂金 ───────────────────────────────────────────
create or replace function public.forfeit_earnest(p_dep uuid, p_on date)
returns jsonb language plpgsql as $fn$
declare
  d      public.deposits;
  oid    uuid;
  n      int;
  uid    uuid := auth.uid();
begin
  if uid is null then
    return jsonb_build_object('ok', false, 'code', 'NO_AUTH', 'message', '請重新登入');
  end if;
  if p_on is null then p_on := (now() at time zone 'Asia/Taipei')::date; end if;

  select * into d from public.deposits where id = p_dep;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'message', '找不到這筆訂金（可能剛被別人刪了）');
  end if;
  if d.kind <> 'earnest' then
    return jsonb_build_object('ok', false, 'code', 'NOT_EARNEST', 'message', '這一筆不是訂金');
  end if;
  -- ★ 冪等：已經沒收過就不再產生第二筆（前端也擋，這裡是最後一道）
  if d.forfeit_order_id is not null then
    return jsonb_build_object('ok', false, 'code', 'ALREADY', 'message', '這筆訂金已經沒收過了。');
  end if;
  if d.converted_to_deposit_id is not null then
    return jsonb_build_object('ok', false, 'code', 'CONVERTED', 'message', '這筆訂金已經轉成押金了，不能再沒收。');
  end if;
  if d.returned_on is not null then
    return jsonb_build_object('ok', false, 'code', 'RETURNED', 'message', '這筆訂金已經退了，不能再沒收。');
  end if;

  -- ① 收入單（欄位逐字照 lib/earnest.ts 的 forfeitOrder()）
  insert into public.orders
    (source, fee_type, item_name, amount, checkin, checkout, deposit_id,
     estate_id, property_id, property_raw, guest_name, note,
     nights, order_key, imported_via)
  values
    ('oneoff', '其他', '取消入住', greatest(0, coalesce(d.amount, 0)), p_on, p_on, d.id,
     d.estate_id, d.property_id, d.room, d.guest_name, format('沒收訂金（%s）', p_on),
     0, format('FEIT_%s_%s', left(d.id::text, 8), (extract(epoch from clock_timestamp()) * 1000)::bigint), 'manual')
  returning id into oid;
  if oid is null then
    raise exception '收入單沒有建起來（多半是權限）—— 什麼都沒寫進去';
  end if;

  -- ② 回寫訂金
  update public.deposits
     set forfeited_on = p_on, forfeit_order_id = oid, forfeited_by = uid
   where id = d.id;
  get diagnostics n = row_count;
  if n <> 1 then
    -- ★★★ 這一句 raise 就是整支的重點：以前是「收入建好了但訂金沒更新」，現在收入也退回
    raise exception '訂金狀態沒有更新（多半是權限）—— 收入單也一起退回，什麼都沒寫進去';
  end if;

  return jsonb_build_object('ok', true, 'code', 'OK', 'order_id', oid, 'amount', d.amount,
    'message', format('已沒收，並產生一筆 NT$ %s 的「取消入住」收入', to_char(coalesce(d.amount,0), 'FM999,999,999')));
end $fn$;
grant execute on function public.forfeit_earnest(uuid, date) to authenticated;

-- ── 2. 訂金轉押金 ─────────────────────────────────────────
create or replace function public.convert_earnest(p_dep uuid, p_on date)
returns jsonb language plpgsql as $fn$
declare
  d        public.deposits;
  t        public.deposits;
  n        int;
  uid      uuid := auth.uid();
  transfer numeric;
  covered  numeric;
  remaining numeric;
begin
  if uid is null then
    return jsonb_build_object('ok', false, 'code', 'NO_AUTH', 'message', '請重新登入');
  end if;
  if p_on is null then p_on := (now() at time zone 'Asia/Taipei')::date; end if;

  select * into d from public.deposits where id = p_dep;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'message', '找不到這筆訂金（可能剛被別人刪了）');
  end if;
  if d.kind <> 'earnest' then
    return jsonb_build_object('ok', false, 'code', 'NOT_EARNEST', 'message', '這一筆不是訂金');
  end if;
  if d.converted_to_deposit_id is not null then
    return jsonb_build_object('ok', false, 'code', 'ALREADY', 'message', '這筆訂金已經轉過押金了。');
  end if;
  if d.forfeit_order_id is not null then
    return jsonb_build_object('ok', false, 'code', 'FORFEITED', 'message', '這筆訂金已經沒收了，不能再轉押金。');
  end if;
  if d.returned_on is not null then
    return jsonb_build_object('ok', false, 'code', 'RETURNED', 'message', '這筆訂金已經退了，不能再轉押金。');
  end if;
  if d.contract_id is null then
    return jsonb_build_object('ok', false, 'code', 'NO_CONTRACT', 'message', '這筆訂金沒有掛在契約上，無法轉押金。');
  end if;

  -- 同一張契約、同幣別的押金那一列（跟前端同一個查法）
  select * into t from public.deposits
   where contract_id = d.contract_id and kind = 'deposit' and currency = d.currency
   order by created_at limit 1;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NO_DEPOSIT',
      'message', '這張契約還沒有押金 —— 請先回契約把押金金額填上，再回來轉。');
  end if;

  transfer := greatest(0, coalesce(d.amount, 0));
  covered  := greatest(0, coalesce(t.received_amount, 0)) + transfer;
  remaining := greatest(0, coalesce(t.amount, 0) - covered);

  -- ① 押金記一筆收款（method = 'earnest_in'，不是 internal —— 見前端註解）
  insert into public.deposit_payments (deposit_id, paid_on, amount, method, note, created_by)
  values (t.id, p_on, transfer, 'earnest_in',
          format('訂金轉入（%s）', coalesce(nullif(d.guest_name, ''), d.room, '訂金')), uid);
  get diagnostics n = row_count;
  if n <> 1 then raise exception '押金的收款沒有記進去（多半是權限）—— 什麼都沒寫進去'; end if;

  -- ② 押金那一列：補 received_on（已有值不覆蓋）＋ 記來源
  update public.deposits
     set received_on = coalesce(received_on, p_on),
         converted_from_earnest_id = d.id
   where id = t.id;
  get diagnostics n = row_count;
  if n <> 1 then raise exception '押金那一列沒有更新（多半是權限）—— 收款也一起退回'; end if;

  -- ③ 訂金結案
  update public.deposits
     set converted_to_deposit_id = t.id, converted_by = uid, converted_at = now()
   where id = d.id;
  get diagnostics n = row_count;
  if n <> 1 then raise exception '訂金狀態沒有更新（多半是權限）—— 前面兩步一起退回'; end if;

  return jsonb_build_object('ok', true, 'code', 'OK', 'deposit_id', t.id,
    'transfer', transfer, 'remaining', remaining, 'settled', (remaining = 0 and coalesce(t.amount,0) > 0),
    'message', case when remaining = 0 and coalesce(t.amount,0) > 0 then '已轉押金，押金收齊了'
                    else format('已轉押金，押金尚欠 NT$ %s', to_char(remaining, 'FM999,999,999')) end);
end $fn$;
grant execute on function public.convert_earnest(uuid, date) to authenticated;

do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('292_earnest_rpc');
  end if;
end $do$;

commit;

-- ══════════════════════════════════════════════════════════
-- 自檢（在 commit 後面 —— 看不到這張表就是整支回滾了）
-- ══════════════════════════════════════════════════════════
select 1 as 序, '這支跑過了沒' as 檢查,
       (select count(*)::text from public.schema_migrations where name = '292_earnest_rpc') as 結果,
       case when exists (select 1 from public.schema_migrations where name = '292_earnest_rpc') then '✅' else '❌' end as 判定
union all select 2, 'forfeit_earnest 在不在',
       (select count(*)::text from pg_proc where proname = 'forfeit_earnest'),
       case when exists (select 1 from pg_proc where proname = 'forfeit_earnest') then '✅' else '❌' end
union all select 3, 'convert_earnest 在不在',
       (select count(*)::text from pg_proc where proname = 'convert_earnest'),
       case when exists (select 1 from pg_proc where proname = 'convert_earnest') then '✅' else '❌' end
union all select 4, '★ 兩支都是 security invoker（RLS 照舊）',
       (select string_agg(proname || ':' || case when prosecdef then 'definer' else 'invoker' end, ' ')
          from pg_proc where proname in ('forfeit_earnest', 'convert_earnest')),
       case when (select bool_and(not prosecdef) from pg_proc where proname in ('forfeit_earnest','convert_earnest'))
            then '✅' else '❌ 變 definer 了，RLS 會被跳過' end
union all select 5, '母體：訂金筆數（參考）',
       (select count(*)::text from public.deposits where kind = 'earnest'),
       case when (select count(*) from public.deposits where kind = 'earnest') = 0 then '⚠ 沒有訂金可比' else '✅' end
union all select 6, '這支沒動任何一列資料（沒收／轉押的筆數跟跑之前一樣）',
       (select count(*)::text || ' 沒收 / ' || (select count(*) from public.deposits where converted_to_deposit_id is not null)::text || ' 轉押'
          from public.deposits where forfeit_order_id is not null),
       '✅ 參考：只加函式，不寫資料'
order by 1;
