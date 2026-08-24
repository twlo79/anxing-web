-- migration_167：開放管家刪除訂單
--
-- ============================================================
-- 【擋在哪裡】（查證，不是猜的）
--
-- 前端那顆「刪除」按鈕**本來就沒有任何角色判斷** —— 管家看得到、按得下去。
-- 按下去之後走 `soft_delete('orders', id)`，而那支是 SECURITY DEFINER，
-- **繞過 RLS**。所以 orders 的 policy 怎麼寫都不影響這條路。
--
-- 真正擋下來的是白名單:
--
--     trash_deletable_tables() → ('orders', 'accountant')
--                                            ^^^^^^^^^^
--     trash_can_delete('orders') → current_role_of() in
--                                  ('accountant','manager','super_admin')
--
-- 管家不在裡面，所以 soft_delete 第一行就回:
--
--     {"ok": false, "code": "NO_PERM", "message": "你的帳號沒有刪除「訂單」的權限。"}
--
-- 至少它**有講話** —— 這一次不是安靜失敗。
--
--
-- ============================================================
-- 【只放訂單，不放契約與支出】
--
-- 白名單裡跟訂單同一排的還有 contracts / expenses / deposits /
-- purchase_requests / order_payments…… 這支**只動 orders 一項**。
--
-- 理由:管家每天在做的是短租訂單（重複匯入、打錯房號、房客取消）。
-- 契約與支出他在選單上根本沒有寫入權，順手一起開等於偷偷擴權，
-- 而擴權的症狀是「三個月後有人發現一筆契約不見了，不知道是誰刪的」。
--
--
-- ============================================================
-- 【復原是同一把鑰匙】
--
-- `restore_trash()` 檢查的也是 `trash_can_delete(t.table_name)`，
-- 所以這一改**同時**給了管家「刪」與「復原」。這是刻意的:
-- 只能刪不能復原的話，他誤刪之後只能去找會計 ——
-- 而那正是回收桶要解決的事。
--
-- 回收桶看得到嗎?看得到。`trash_read` 的第一個條件是
-- `deleted_by = auth.uid()` —— 自己刪的自己看得到。
-- （別人刪的仍然看不到,那一條沒動。）
--
--
-- ============================================================
-- 【三道還留著的閘門 —— 不要以為這支把訂單全開了】
--
--  ① 已退押金／已掛加費的訂單刪不掉。
--     `trg_orders_lock_guard`（migration_157）在 before delete 就擋下來，
--     而且只放行 accountant / super_admin。管家會收到:
--     「這筆訂單的押金已退款…要修改請洽會計或總管理員。」
--     **這是對的** —— 錢已經退出去了，訂單不能憑空消失。
--
--  ② 其他帳本（愛皮／洪鯊）的收入刪不掉 —— 這支加的 row 層檢查，見下。
--
--  ③ 收款紀錄會跟著進回收桶（trash_collect_children），
--     復原時一起回來。營收認列由 `trg_orders_recog_del` 處理。
-- ============================================================


-- ============================================================
-- ① 白名單:訂單降到管家
-- ============================================================
/*
 * ★ 新增一個 'housekeeper' 層級，而不是把 orders 改成 'any'。
 *
 *   'any' 的意思是「有角色就能刪」—— 那會**連 cleaner 一起放進來**。
 *   資料庫的 RLS 分不出 cleaner 與 housekeeper（migration_131 起就相同），
 *   但 trash_can_delete 看的是 current_role_of() 字串，這裡分得出來，
 *   所以這裡是少數「真的擋得住」的地方。既然擋得住就不要放掉。
 */
create or replace function public.trash_deletable_tables()
returns table (tbl text, min_role text) language sql immutable as $fn$
  select * from (values
    -- ★ 訂單降到管家（migration_167）。其餘一律維持原樣
    ('orders', 'housekeeper'),
    ('contracts', 'accountant'), ('expenses', 'accountant'),
    ('purchase_requests', 'accountant'), ('purchase_request_items', 'accountant'),
    ('deposits', 'accountant'), ('invoices', 'accountant'),
    ('order_payments', 'accountant'), ('contract_payments', 'accountant'),
    ('deposit_payments', 'accountant'),
    ('contract_recurring_charges', 'accountant'), ('recurring_charges', 'accountant'),
    ('estates', 'accountant'), ('properties', 'accountant'),
    ('payment_accounts', 'accountant'), ('payee_presets', 'accountant'),
    ('hk_work_item', 'manager'), ('hk_event', 'manager'), ('cleaning_records', 'manager'),
    ('reviews', 'manager'), ('customers', 'manager'), ('announcements', 'manager'),
    ('attachments', 'any')
  ) v(tbl, min_role);
$fn$;

comment on function public.trash_deletable_tables() is
  '哪些表可以走 soft_delete，以及最低角色。沒列在這裡的表一律不能刪（預設拒絕）。'
  'orders 於 migration_167 降到 housekeeper —— 管家每天在處理短租訂單。';


create or replace function public.trash_can_delete(p_table text)
returns boolean language sql stable as $fn$
  select case when public.current_role_of() is null then false else
    coalesce((
      select case d.min_role
        when 'any'         then true
        when 'manager'     then public.current_role_of() in ('manager', 'super_admin')
        when 'accountant'  then public.current_role_of() in ('accountant', 'manager', 'super_admin')
        /*
         * ★ 新層級（migration_167）。
         *   **cleaner 不在裡面** —— 見上面的說明。
         */
        when 'housekeeper' then public.current_role_of() in
                                 ('housekeeper', 'accountant', 'manager', 'super_admin')
        else false
      end
      from public.trash_deletable_tables() d
      where d.tbl = p_table
    ), false)
  end;
$fn$;

comment on function public.trash_can_delete(text) is
  '回收桶的表層權限。預設拒絕：沒列在 trash_deletable_tables 的表不能透過 soft_delete 刪除。'
  '層級 housekeeper 不含 cleaner（migration_167）。';


-- ============================================================
-- ② row 層:管家只能刪安幸的訂單
-- ============================================================
/*
 * 【為什麼需要這一層】
 *
 * soft_delete 是 SECURITY DEFINER，**RLS 完全不參與**。
 * 所以「管家能不能刪這一筆」不會有第二道自動的檢查 ——
 * 白名單放行之後他就能刪 orders 表裡的任何一列，
 * 包含愛皮與洪鯊的收入（那兩家也存在 orders，只是 book 不同）。
 *
 * 管家在選單上連「其他收支帳」都看不到。看不到卻刪得掉，
 * 而且刪掉之後那筆收入從愛皮的儀錶板上消失、沒有人會知道是誰。
 *
 * 這裡照 attachments 的做法:在 soft_delete 裡加一條 row 層檢查。
 *
 * 【為什麼不用 RLS 重寫 soft_delete】
 * 拿掉 SECURITY DEFINER 的話 trash 那張表的 insert 也會被 RLS 擋
 * （trash_no_write 是 `using(false)`）,整個回收桶要重做。不值得。
 */
create or replace function public.soft_delete(
  p_table text, p_id uuid, p_reason text default null
) returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare
  main    jsonb;
  kids    jsonb := '[]'::jsonb;
  n_kids  int := 0;
  tid     uuid;
  v_role  text := public.current_role_of();
begin
  if not public.trash_can_delete(p_table) then
    return jsonb_build_object('ok', false, 'code', 'NO_PERM',
      'message', '你的帳號沒有刪除「' || public.trash_table_label(p_table) || '」的權限。');
  end if;

  -- 表名只能來自白名單。直接把 p_table 拼進 SQL 是注入的入口，
  -- 而 to_regclass 只認得真的存在的表，拼不出東西。
  if to_regclass('public.' || quote_ident(p_table)) is null then
    return jsonb_build_object('ok', false, 'code', 'NO_TABLE', 'message', '找不到資料表 ' || p_table);
  end if;

  execute format('select to_jsonb(t) from public.%I t where t.id = $1', p_table)
    into main using p_id;
  if main is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'message', '找不到這一筆,可能已經被刪掉了。');
  end if;

  /*
   * 逐列的權限檢查。
   *
   * 憑證是唯一一個「同一張表、不同人能刪的列不一樣」的情況：
   * 房管刪得掉自己請款單上的收據，刪不掉別人的。
   * 這裡直接呼叫 att_delete 那條 RLS 用的同一個述詞 ——
   * 自己重寫一份的話，兩邊遲早會不一致，而不一致的那一邊會是這裡
   * （因為它繞過 RLS，沒有人會發現）。
   */
  if p_table = 'attachments' and not public.can_edit_receipt(main->>'path') then
    return jsonb_build_object('ok', false, 'code', 'NO_PERM',
      'message', '這張憑證不是你上傳的,不能刪除。');
  end if;

  /*
   * ★ 管家只能刪安幸帳本的訂單（migration_167）。
   *
   *   coalesce 的預設是 'anxing' —— 舊資料 book 是 null 的那些仍然刪得掉。
   *   反過來寫（null 當作其他帳本）的話，管家會突然刪不了任何舊訂單，
   *   而症狀是「按了沒反應」。
   */
  if p_table = 'orders' and v_role = 'housekeeper'
     and coalesce(main->>'book', 'anxing') <> 'anxing' then
    return jsonb_build_object('ok', false, 'code', 'NO_PERM',
      'message', '這筆是「其他收支帳」的收入,不在你的權限範圍。請洽會計。');
  end if;

  -- 子列一路收到底（契約 → 訂單 → 收款紀錄）。只收一層的話，
  -- 復原之後收過的錢會憑空消失，而且沒有任何錯誤訊息。
  kids := public.trash_collect_children(p_table, array[p_id]);

  select coalesce(sum(jsonb_array_length(g->'rows')), 0)::int
    into n_kids from jsonb_array_elements(kids) g;

  insert into public.trash (table_name, record_id, label, payload, children, child_count,
                            reason, deleted_by)
  values (p_table, p_id, public.trash_label(p_table, main), main, kids, n_kids,
          nullif(btrim(coalesce(p_reason, '')), ''), auth.uid())
  returning id into tid;

  execute format('delete from public.%I where id = $1', p_table) using p_id;

  return jsonb_build_object('ok', true, 'code', 'OK', 'trash_id', tid,
    'children', n_kids,
    'message', '已移到回收桶'
      || case when n_kids > 0 then format('（連同 %s 筆相關資料）', n_kids) else '' end
      || '。到「刪除紀錄」可以復原。');
end $fn$;

comment on function public.soft_delete is
  '刪除 = 整列（含 CASCADE 子列）搬進 trash,原表真的 delete。'
  '表層權限看 trash_can_delete；row 層另外擋憑證（非本人）與'
  '其他帳本的訂單（管家，migration_167）。';


-- ============================================================
-- ③ 同步 restore_trash 的權限（它用的是同一支 trash_can_delete）
-- ============================================================
/*
 * restore_trash 沒有改 —— 它本來就呼叫 trash_can_delete，
 * 上面改了函式本體，它自動跟著。
 *
 * 這裡只是把「有沒有跟著」放進下面的驗證，
 * 免得哪天有人把 restore 的檢查換成寫死的角色清單。
 */


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('167_housekeeper_delete_order');
  end if;
end $$;


-- ============================================================
-- 驗證
-- ============================================================
/*
 * ★★ 真的刪一筆再回滾。
 *
 *   只查「白名單裡 orders 是 housekeeper 嗎」抓不到問題 ——
 *   trash_can_delete 的 case 少一個分支的話，白名單是對的、
 *   函式回的仍然是 false（164 就是這樣漏掉的:索引存在，但對不到）。
 *
 *   SQL Editor 是 super_admin 連線，current_role_of() 不是 housekeeper，
 *   所以這裡直接**呼叫函式檢查每個角色的答案**，而不是靠模擬登入。
 */
do $$
declare
  v_id uuid; v_r jsonb; v_book text;
begin
  -- 挑一筆沒有鎖定、屬於安幸的訂單
  select o.id, coalesce(o.book, 'anxing') into v_id, v_book
    from public.orders o
   where coalesce(o.book, 'anxing') = 'anxing'
     and public.order_locked_reason(o.id) is null
   limit 1;

  if v_id is null then
    raise notice '★ 跳過刪除測試（找不到可刪的安幸訂單）';
    return;
  end if;

  v_r := public.soft_delete('orders', v_id, '__migration_167 自檢__');

  raise notice '★★ soft_delete 回傳:% ／ 子列 %',
    case when (v_r->>'ok')::boolean then '成功 ✅' else '失敗 ❌ ' || (v_r->>'message') end,
    coalesce(v_r->>'children', '0');

  raise exception using errcode = 'restrict_violation', message = '__rollback__';
exception
  when restrict_violation then
    if sqlerrm = '__rollback__' then raise notice '★ 測試刪除已回滾,訂單還在';
    else raise; end if;
end $$;


select "檢查項目", "結果", "說明" from (

  /*
   * ★★ 白名單。orders 必須是 housekeeper，其餘一項都不能鬆掉。
   */
  select 1 as ord, '★★ 訂單降到管家' as "檢查項目",
         coalesce((select min_role from public.trash_deletable_tables() where tbl = 'orders'),
                  '(不在白名單)') as "結果",
         '應為 housekeeper' as "說明"

  union all
  /*
   * ★★ 這一項才是真的在測函式 —— 白名單對、case 分支漏掉的話這裡會是 ❌。
   */
  select 2, '★★ trash_can_delete 認得新層級',
         case when public.trash_can_delete('orders') then '✅ super_admin 可刪'
              else '❌ 連總管理員都刪不了,case 分支漏了' end,
         '以目前連線的角色實測'

  union all
  /*
   * ★★ cleaner 不能因為這支被順手放進來。
   *   函式定義裡那一行必須**只列四個角色**。
   */
  select 3, '★★ 房務(cleaner)沒被一起開放',
         case when pg_get_functiondef('public.trash_can_delete(text)'::regprocedure)
                   like '%''housekeeper'', ''accountant'', ''manager'', ''super_admin''%'
               and pg_get_functiondef('public.trash_can_delete(text)'::regprocedure)
                   not like '%''cleaner''%'
              then '✅' else '❌ 定義裡出現 cleaner' end,
         'RLS 分不出 cleaner 與管家,但這裡分得出來'

  union all
  /*
   * ★★ 其他帳本的 row 層檢查有沒有真的寫進去。
   *   漏了的話管家刪得掉愛皮／洪鯊的收入,而且沒有人會發現。
   */
  select 4, '★★ 管家擋在其他帳本外',
         case when pg_get_functiondef('public.soft_delete(text,uuid,text)'::regprocedure)
                   like '%其他收支帳%' then '✅' else '❌ row 層檢查沒進去' end,
         '愛皮／洪鯊的收入也在 orders 表裡'

  union all
  /*
   * ★ 復原走的是同一支檢查。寫死角色清單的話這裡會是 ❌。
   */
  select 5, '★ 復原跟著一起開放',
         case when pg_get_functiondef('public.restore_trash(uuid)'::regprocedure)
                   like '%trash_can_delete%' then '✅' else '❌ 只能刪不能復原' end,
         '誤刪之後自己救得回來'

  union all
  /*
   * ★ 已退押金的訂單仍然刪不掉 —— 這支不該把 157 的鎖打開。
   */
  select 6, '★ 已退押金的訂單仍然鎖著',
         case when exists (select 1 from pg_trigger
                            where tgrelid = 'public.orders'::regclass
                              and tgname = 'trg_orders_lock_guard')
              then '✅ 守衛還在' else '❌ 鎖不見了' end,
         (select count(*)::text || ' 筆訂單目前處於鎖定'
            from public.orders o where public.order_locked_reason(o.id) is not null)

  union all
  select 7, '其他表維持原樣',
         (select count(*)::text || ' / 22'
            from public.trash_deletable_tables()
           where tbl <> 'orders' and min_role in ('accountant', 'manager', 'any')),
         '這支只動 orders 一項'

  union all
  select 8, '目前訂單數', count(*)::text || ' 筆', '這支只改規則,一筆資料都沒動'
    from public.orders

) v order by ord;
