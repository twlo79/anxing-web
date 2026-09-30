/* ══════════════════════════════════════════════════════════════════════
 * 查：請款單為什麼存不進去 —— 用總經理的身分「模擬」存一次，看資料庫回什麼   2026-09-30
 *
 * 【只讀】存的那一下包在子交易裡，拿到結果之後整個退回 —— 一筆都不會留下。
 *   模擬的內容就是截圖那一張：項目 test、NT$ 30,000、安幸辦公室、現金、備註 test。
 *
 * 【看哪一列】
 *   第 3 列「模擬存檔」：✅ 就是資料庫這邊沒問題（問題在畫面那一段）；
 *                      ❌ 後面那句就是真正的原因。
 *
 * ★ 看不到這張表 ＝ 這支本身有錯（不會改到任何東西），把紅字貼給我。
 * ══════════════════════════════════════════════════════════ */

create temp table if not exists _diag (序 int, 檢查 text, 結果 text, 判定 text);
truncate _diag;

do $$
declare
  uid   uuid;
  uname text;
  r     jsonb;
  err   text;
  errd  text;
begin
  select id, name into uid, uname from public.profiles
   where role = 'super_admin' and active order by name limit 1;
  insert into _diag values (1, '模擬用的帳號（總經理）', coalesce(uname, '找不到'),
    case when uid is null then '❌' else 'ℹ' end);

  insert into _diag values (2, '需要的函式在不在（save_purchase_request・next_req_no）',
    (select string_agg(p.proname, '、' order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.prokind in ('f','p') and p.proname in ('save_purchase_request','next_req_no')),
    case when (select count(distinct p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                where n.nspname = 'public' and p.proname in ('save_purchase_request','next_req_no')) = 2
         then '✅' else '❌ 少了 —— 請款單一定存不進去' end);

  if uid is null then return; end if;

  begin
    perform set_config('request.jwt.claim.sub', uid::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';

    r := public.save_purchase_request(null,
      jsonb_build_object('payment_method', 'cash', 'note', 'test', 'currency', 'TWD', 'fx_rate', 1,
                         'book', 'anxing', 'fee_mode', 'included', 'fee_amount', 0,
                         'no_voucher', false, 'shared_voucher', false),
      jsonb_build_array(jsonb_build_object('item_name', 'test', 'amount_original', 30000, 'amount', 30000,
                         'account_code', null, 'purpose_type', 'office', 'estate_id', null, 'property_id', null,
                         'note', null, 'sort', 0, 'voucher_no', null, 'no_voucher', false, 'id', null)));

    raise exception 'DIAG_ROLLBACK';   -- 成功也退回，一筆都不留
  exception when others then
    get stacked diagnostics err = message_text, errd = pg_exception_context;
  end;

  insert into _diag values (3, '模擬存檔（跟截圖同一張）',
    case when err = 'DIAG_ROLLBACK' then coalesce(r::text, '（沒有回傳）')
         else err || coalesce(E'\n位置：' || left(errd, 300), '') end,
    case when err = 'DIAG_ROLLBACK' and coalesce((r->>'ok')::boolean, false) then '✅ 資料庫這邊存得進去'
         when err = 'DIAG_ROLLBACK' then '❌ 函式回 ok=false，看左邊 message'
         else '❌ 這句就是原因' end);
end $$;

select * from _diag order by 1;
