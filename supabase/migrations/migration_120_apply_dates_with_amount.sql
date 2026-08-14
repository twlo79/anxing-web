-- migration_120：套用日期時，金額一起寫進去
--
-- ============================================================
-- 【為什麼】
--
-- 延住 2 晚不可能只改日期不改錢。前一版套用「住宿起訖」只寫 checkin /
-- checkout / nights，金額原封不動 —— 結果那筆訂單變成
-- **住 30 晚、收 28 晚的錢**，而且看起來完全正常。
--
-- 更糟的是接下來會發生什麼：下一輪同步發現金額對不上，再產生一條
-- 「金額」建議。使用者按了一次卻要處理兩次，而中間那段時間
-- 帳上那筆是錯的。
--
--
-- ============================================================
-- 【金額從哪來】
--
-- `airbnb_snapshots.revenue` —— 那是爬取當下算好的
-- 「你賺得 ＋ 搭檔收款」，跟金額建議用的是同一個數字。
--
-- 不從 sync_issues 的「金額」那一條拿，因為那一條**不一定存在**：
-- 金額差在 1 元以內就不會產生建議，但日期變了照樣要同步。
--
--
-- ============================================================
-- 【套用日期 ＝ 把這筆整個同步到 Airbnb 現在的樣子】
--
-- 這是刻意選的心智模型：一顆按鈕做一件完整的事，
-- 而不是「改了一半，另一半明天再說」。
--
-- 反過來不成立 —— 套用「金額」不會動日期。日期牽涉行事曆與
-- 重複出租，那個決定要單獨做。

create or replace function public.apply_sync_issue(
  p_kind text, p_code text, p_field text
) returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare
  r      sync_issues;
  v_amt  numeric;
  v_rev  numeric;
  v_in   date;
  v_out  date;
  n      int;
begin
  if current_role_of() not in ('manager', 'super_admin', 'accountant') then
    return jsonb_build_object('ok', false, 'message', '你的角色不能處理同步建議');
  end if;

  select * into r from sync_issues
   where kind = p_kind and code = p_code and field = p_field;
  if not found then
    return jsonb_build_object('ok', false, 'message', '這條建議已經不在了,重新整理看看');
  end if;

  if r.field = '金額' then
    v_amt := nullif(r.to_val, '')::numeric;
    if v_amt is null then
      return jsonb_build_object('ok', false, 'message', '這條建議沒有可套用的金額');
    end if;
    update orders set amount = v_amt where order_key = p_code;

  elsif r.field = '住宿起訖' then
    -- to_val 長這樣：2026-07-21~2026-08-20
    v_in  := nullif(split_part(r.to_val, '~', 1), '')::date;
    v_out := nullif(split_part(r.to_val, '~', 2), '')::date;
    if v_in is null or v_out is null then
      return jsonb_build_object('ok', false, 'message', '這條建議的日期格式不對:' || coalesce(r.to_val, ''));
    end if;

    /*
     * 金額一起更新。
     *
     * 沒有快照時就不動金額（爬蟲還沒看過這筆）——
     * 寧可日期對、金額待確認，也不要拿一個不知道從哪來的數字覆蓋。
     */
    select revenue into v_rev from airbnb_snapshots where code = p_code;

    update orders
       set checkin  = v_in,
           checkout = v_out,
           nights   = greatest(v_out - v_in, 0),
           amount   = case when v_rev is not null and v_rev > 0 then v_rev else amount end
     where order_key = p_code;

  else
    return jsonb_build_object('ok', false,
      'message', r.field || '不能一鍵套用。房源不一致請到「房源管理」修對照表 —— 改單一筆只是把症狀蓋掉');
  end if;

  /*
   * 【一定要檢查有沒有真的改到】
   * RLS 擋下的 update 會回「成功」而且影響 0 列 —— 不檢查的話，
   * 畫面顯示套用成功、資料一個字都沒變，而那比報錯更難查。
   */
  get diagnostics n = row_count;
  if n = 0 then
    return jsonb_build_object('ok', false, 'message', '找不到訂單 ' || p_code || ',或你沒有權限改它');
  end if;

  /*
   * 關掉這一筆訂單上「已經被這次套用解決掉」的建議。
   *
   * 套用日期時金額也寫進去了，所以金額那一條（如果有）也該一起關 ——
   * 留著的話使用者會再按一次，而那一次什麼都不會改變，
   * 只會讓他懷疑第一次到底有沒有生效。
   */
  insert into sync_issue_log
    (kind, code, field, from_val, to_val, reason, severity, opened_at, resolution, acted_by)
  select kind, code, field, from_val, to_val, reason, severity, first_seen, 'applied', auth.uid()
    from sync_issues
   where kind = p_kind and code = p_code
     and (field = p_field or (p_field = '住宿起訖' and field = '金額' and v_rev is not null));

  delete from sync_issues
   where kind = p_kind and code = p_code
     and (field = p_field or (p_field = '住宿起訖' and field = '金額' and v_rev is not null));

  return jsonb_build_object(
    'ok', true, 'applied', r.to_val,
    'amount', case when p_field = '住宿起訖' then v_rev else v_amt end);
end $fn$;

grant execute on function public.apply_sync_issue(text, text, text) to authenticated;


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('120_apply_dates_with_amount');
  end if;
end $$;


-- ============================================================
-- 驗證
-- ============================================================
do $$
declare
  v_oid uuid; v_est uuid; v_amt numeric; v_out date; n int;
begin
  drop table if exists _chk120;
  create temp table _chk120 (ord int, item text, result text, detail text);

  insert into _chk120 values (1, 'apply_sync_issue 函式',
    case when to_regprocedure('public.apply_sync_issue(text,text,text)') is not null
         then '✅' else '❌' end, '');

  select id into v_est from public.estates limit 1;

  -- 準備一筆假訂單 ＋ 快照 ＋ 兩條建議
  delete from public.orders          where order_key = '__T120__';
  delete from public.airbnb_snapshots where code      = '__T120__';
  delete from public.sync_issues     where code      = '__T120__';

  insert into public.orders
    (order_key, source, estate_id, property_raw, guest_name,
     checkin, checkout, nights, amount, imported_via)
  values ('__T120__', 'airbnb', v_est, '__T120房__', '測試',
          '2026-07-21', '2026-08-18', 28, 100000, 'auto')
  returning id into v_oid;

  insert into public.airbnb_snapshots (code, earnings, cohost, revenue)
  values ('__T120__', 110000, 0, 110000);

  insert into public.sync_issues (kind, code, field, from_val, to_val, severity)
  values ('orders', '__T120__', '住宿起訖', '2026-07-21~2026-08-18', '2026-07-21~2026-08-20', 'mid'),
         ('orders', '__T120__', '金額', '100000', '110000', 'high');

  perform public.apply_sync_issue('orders', '__T120__', '住宿起訖');

  select checkout, amount into v_out, v_amt from public.orders where order_key = '__T120__';

  insert into _chk120 values (2, '★ 日期有寫進去',
    case when v_out = '2026-08-20' then '✅' else '❌ ' || coalesce(v_out::text, 'null') end,
    '28 晚 → 30 晚');

  insert into _chk120 values (3, '★★ 金額也一起寫進去',
    case when v_amt = 110000 then '✅' else '❌ ' || coalesce(v_amt::text, 'null') end,
    '延住 2 晚不可能只改日期不改錢 —— '
    || '只改日期的話那筆會變成「住 30 晚、收 28 晚的錢」,而且看起來完全正常');

  select count(*) into n from public.sync_issues where code = '__T120__';
  insert into _chk120 values (4, '★★ 金額那條建議也一起關掉',
    case when n = 0 then '✅' else '❌ 還剩 ' || n || ' 條' end,
    '留著的話他會再按一次,而那一次什麼都不會改變 —— '
    || '只會讓他懷疑第一次到底有沒有生效');

  select count(*) into n from public.sync_issue_log
   where code = '__T120__' and resolution = 'applied';
  insert into _chk120 values (5, '兩條都進了處理紀錄',
    case when n = 2 then '✅' else '⚠ ' || n || ' 條' end, '');

  -- 收尾
  delete from public.sync_issue_log  where code      = '__T120__';
  delete from public.sync_issues     where code      = '__T120__';
  delete from public.airbnb_snapshots where code     = '__T120__';
  delete from public.orders          where order_key = '__T120__';
end $$;

select item as "檢查項目", result as "結果", detail as "說明"
from _chk120 order by ord, item;
