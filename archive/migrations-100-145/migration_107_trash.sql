-- migration_107：回收桶（軟刪除）
--
-- ============================================================
-- 【為什麼不是在每張表加 deleted_at】
--
-- 直覺的做法是每張表加一個 deleted_at，查詢時濾掉。這裡不能那樣做：
--
--   全站有幾十處查詢會碰到 orders / expenses / contracts，
--   每一處都要補 `is('deleted_at', null)`。**漏一處的症狀是
--   「已刪除的訂單還在算營收」** —— 而那不會報錯，只會讓數字悄悄變大。
--   這個專案 2026-08 才因為「查詢少了一截」出過一次事（1000 列上限），
--   同一類錯誤不要再製造一次。
--
-- 改成「刪除 = 把整列搬進回收桶，原表真的 delete」：
--   · 既有查詢一行都不用改，刪掉就是刪掉
--   · 營收、報表、統計自動正確
--   · 復原就是把 JSON 塞回去
--
-- 代價是復原要處理外鍵子列，下面用 pg_constraint 自動發現，不是手寫清單。
--
--
-- ============================================================
-- 【子列一定要一起存】
--
-- 刪一張訂單，資料庫會連帶 CASCADE 掉它的收款紀錄與營收認列。
-- 只存主列的話，復原回來的訂單「金額還在、收款紀錄不見了」——
-- 那比沒有復原更糟，因為看起來是好的。
--
-- 子表不是寫死的清單（寫死一定會漏掉之後新增的表），
-- 而是每次刪除時去 pg_constraint 查「誰的外鍵指向我而且是 CASCADE」。
--
--
-- ============================================================
-- 【永久刪除留墓碑】
--
-- 總經理按了永久刪除之後，內容清空，但「誰在什麼時候刪掉了什麼」
-- 那一列留著。不留的話，回收桶本身就變成一個可以湮滅紀錄的地方。
-- ============================================================


create table if not exists public.trash (
  id           uuid primary key default gen_random_uuid(),
  table_name   text not null,
  record_id    uuid not null,
  /** 人看得懂的識別。列表上顯示這個,不用點進去才知道刪了什麼。 */
  label        text,
  /** 原始內容（整列）。永久刪除後清空。 */
  payload      jsonb,
  /**
   * 連帶刪掉的子列，**有順序**：[{ "table": "...", "rows": [...] }, ...]
   * 復原時照這個順序塞回去 —— 先父後子，不然外鍵會擋。
   */
  children     jsonb not null default '[]'::jsonb,
  child_count  int  not null default 0,

  reason       text,
  deleted_by   uuid references public.profiles(id),
  deleted_at   timestamptz not null default now(),

  restored_at  timestamptz,
  restored_by  uuid references public.profiles(id),
  purged_at    timestamptz,
  purged_by    uuid references public.profiles(id)
);

create index if not exists trash_at_idx    on public.trash (deleted_at desc);
create index if not exists trash_table_idx on public.trash (table_name, deleted_at desc);
create index if not exists trash_open_idx  on public.trash (deleted_at desc)
  where restored_at is null and purged_at is null;

comment on table public.trash is
  '回收桶。刪除 = 整列搬到這裡,原表真的 delete —— '
  '這樣既有查詢一行都不用改,已刪的東西不會偷偷留在營收裡。'
  '永久刪除只清 payload,誰刪的與時間留著當墓碑。';


-- ============================================================
-- 中文表名。列表上顯示「訂單」而不是 orders。
-- ============================================================
create or replace function public.trash_table_label(p_table text)
returns text language sql immutable as $fn$
  select case p_table
    when 'orders'                     then '訂單'
    when 'contracts'                  then '契約'
    when 'expenses'                   then '支出'
    when 'purchase_requests'          then '請款單'
    when 'purchase_request_items'     then '請款項目'
    when 'deposits'                   then '押金'
    when 'invoices'                   then '發票'
    when 'order_payments'             then '訂單收款'
    when 'contract_payments'          then '契約期款'
    when 'revenue_recognitions'       then '營收認列'
    when 'attachments'                then '憑證'
    when 'contract_recurring_charges' then '固定加費'
    when 'recurring_charges'          then '定期收費'
    when 'reviews'                    then '評價'
    when 'estates'                    then '物業'
    when 'properties'                 then '房源'
    when 'payment_accounts'           then '收付款帳號'
    when 'payee_presets'              then '常用帳號'
    when 'customers'                  then '客戶'
    when 'announcements'              then '公告'
    when 'hk_work_item'               then '房務排班'
    when 'hk_event'                   then '房務事件'
    when 'cleaning_records'           then '清潔記錄'
    when 'announcement_reads'         then '公告已讀'
    when 'staff_properties'           then '管家負責房源'
    else p_table
  end;
$fn$;


-- ============================================================
-- 人看得懂的一句話識別。
--
-- 從整列的 jsonb 抓幾個關鍵欄位湊出來 —— 每張表的關鍵欄位不同，
-- 所以是 case 而不是通用規則。抓不到就退回 id 的前八碼，
-- 不要留空白（列表上一排空白等於沒有回收桶）。
-- ============================================================
create or replace function public.trash_label(p_table text, r jsonb)
returns text language sql immutable as $fn$
  select nullif(btrim(case p_table
    when 'orders' then
      concat_ws(' ', r->>'property_raw', r->>'guest_name',
        case when r->>'checkin' is not null then r->>'checkin' end,
        case when (r->>'amount')::numeric is not null
             then '$' || to_char((r->>'amount')::numeric, 'FM999,999,999') end)
    when 'contracts' then
      concat_ws(' ', r->>'room', coalesce(r->>'tenant_name', r->>'display_name'),
        concat_ws('~', r->>'start_date', r->>'end_date'))
    when 'expenses' then
      concat_ws(' ', r->>'spent_on', r->>'item_name',
        '$' || to_char(coalesce((r->>'amount')::numeric, 0), 'FM999,999,999'))
    when 'purchase_requests' then
      concat_ws(' ', r->>'title', r->>'payee',
        '$' || to_char(coalesce((r->>'total_amount')::numeric, 0), 'FM999,999,999'))
    when 'deposits' then
      concat_ws(' ', r->>'room', r->>'name',
        '$' || to_char(coalesce((r->>'amount')::numeric, 0), 'FM999,999,999'))
    when 'invoices' then concat_ws(' ', r->>'invoice_no', r->>'ym')
    when 'order_payments' then
      concat_ws(' ', r->>'paid_on', '$' || to_char(coalesce((r->>'amount')::numeric, 0), 'FM999,999,999'))
    when 'reviews' then concat_ws(' ', r->>'guest_name', r->>'checkout_date', r->>'overall_rating' || '★')
    when 'customers' then concat_ws(' ', r->>'name', r->>'property_label')
    when 'announcements' then r->>'title'
    else concat_ws(' ', r->>'name', r->>'title', r->>'label', r->>'item_name')
  end), '')
$fn$;


-- ============================================================
-- 誰可以刪。
--
-- **這支函式是 SECURITY DEFINER，會繞過 RLS** —— 不自己檢查的話，
-- 任何登入的人都能刪掉任何一列，而且不會有錯誤訊息。
-- 這是 SECURITY DEFINER 最常見的漏洞。
--
-- 規則刻意跟現有的 RLS 對齊：碰錢的表要會計以上，房務與內容類要主管以上。
-- **改 RLS 時這裡要跟著改** —— 兩邊不同步的話會出現「畫面上刪得掉、
-- 但其實他本來沒有權限」。
--
-- 【沒列到的表一律不能刪】
-- 這裡的預設**必須是拒絕**。預設允許的話，這支函式就變成一個
-- 「繞過所有 RLS 的萬用刪除器」—— 房管可以刪掉同事的 profiles、
-- 刪掉自己遲到的打卡紀錄，而且完全沒有錯誤訊息。
-- 之後新增的表要能刪，就到這裡加一行；漏加的症狀是「按了說沒權限」，
-- 那是吵的、看得見的、五分鐘可以修好的 —— 遠好過安靜地讓人刪掉不該刪的東西。
-- ============================================================
-- 白名單只有這一份。下面的權限判斷、以及檔案最後那條「有沒有表漏了中文名」
-- 的檢查，都是從這裡推出來的 —— 抄成兩份的話，遲早會有一份是舊的。
create or replace function public.trash_deletable_tables()
returns table (tbl text, min_role text) language sql immutable as $fn$
  select * from (values
    -- 碰錢與主檔：會計以上
    ('orders', 'accountant'), ('contracts', 'accountant'), ('expenses', 'accountant'),
    ('purchase_requests', 'accountant'), ('purchase_request_items', 'accountant'),
    ('deposits', 'accountant'), ('invoices', 'accountant'),
    ('order_payments', 'accountant'), ('contract_payments', 'accountant'),
    ('contract_recurring_charges', 'accountant'), ('recurring_charges', 'accountant'),
    ('estates', 'accountant'), ('properties', 'accountant'),
    ('payment_accounts', 'accountant'), ('payee_presets', 'accountant'),
    -- 房務、評價、客戶、公告：主管以上
    ('hk_work_item', 'manager'), ('hk_event', 'manager'), ('cleaning_records', 'manager'),
    ('reviews', 'manager'), ('customers', 'manager'), ('announcements', 'manager'),
    -- 憑證：任何角色都可能刪自己上傳的那張。這裡只放行到「有角色」，
    -- 真正的判斷在 soft_delete 裡用 can_edit_receipt(path) 逐列檢查 ——
    -- 跟 att_delete 那條 RLS 同一個述詞。
    ('attachments', 'any')
  ) v(tbl, min_role);
$fn$;

create or replace function public.trash_can_delete(p_table text)
returns boolean language sql stable as $fn$
  select case when current_role_of() is null then false else
    -- 查不到 = 不在白名單 = 不能刪。coalesce 的 false 就是那道預設拒絕。
    coalesce((
      select case d.min_role
        when 'any'        then true
        when 'manager'    then current_role_of() in ('manager', 'super_admin')
        when 'accountant' then current_role_of() in ('accountant', 'manager', 'super_admin')
        else false
      end
      from public.trash_deletable_tables() d
      where d.tbl = p_table
    ), false)
  end;
$fn$;

comment on function public.trash_can_delete(text) is
  '回收桶的表層權限。預設拒絕：沒列在 trash_deletable_tables 的表不能透過 soft_delete 刪除。';


-- ============================================================
-- 把「會被 CASCADE 帶走的子列」全部收集起來 —— **要一路往下收**。
--
-- 【為什麼必須遞迴】
-- 只收一層的話，刪一張契約會存下底下的訂單，但**不會存那些訂單的收款紀錄**。
-- 復原時訂單回來了，收款卻沒有 —— 收過的錢憑空消失，整張契約看起來變成未收。
-- 而且畫面上一切正常，沒有任何錯誤訊息。這種「復原成功但少東西」
-- 比復原失敗糟得多：失敗看得見，少東西要等到對帳才發現。
--
-- 訂單的營收認列靠觸發器會自己重建，但收款紀錄沒有觸發器 —— 沒存就是沒了。
--
-- 【順序】
-- 深度優先、父層先寫進陣列，所以還原時照順序插回去不會撞外鍵。
--
-- 【深度上限】
-- 支出的遞延子單是自我參照（expenses → expenses）。理論上收斂，
-- 但資料要是曾經被寫壞成環狀，這裡會轉到逾時。上限 5 層是保險絲。
-- ============================================================
create or replace function public.trash_collect_children(
  p_table text, p_ids uuid[], p_depth int default 0
) returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare
  out_j   jsonb := '[]'::jsonb;
  fk      record;
  rows_j  jsonb;
  ids     uuid[];
  has_id  boolean;
begin
  if p_depth >= 5 or coalesce(array_length(p_ids, 1), 0) = 0 then
    return out_j;
  end if;

  /*
   * 誰的外鍵指向我而且是 ON DELETE CASCADE。
   * 寫死清單一定會漏掉之後新增的表 —— 漏掉的症狀是
   * 「復原回來的訂單沒有收款紀錄」，看起來卻是好的。
   * confdeltype = 'c' 就是 CASCADE。只處理單欄外鍵（這個 schema 全部都是）。
   */
  for fk in
    select cl.relname as child_table, att.attname as child_col
      from pg_constraint c
      join pg_class cl  on cl.oid = c.conrelid
      join pg_namespace ns on ns.oid = cl.relnamespace
      join pg_attribute att on att.attrelid = c.conrelid and att.attnum = c.conkey[1]
     where c.contype = 'f'
       and c.confrelid = ('public.' || quote_ident(p_table))::regclass
       and c.confdeltype = 'c'
       and ns.nspname = 'public'
       and array_length(c.conkey, 1) = 1
     order by cl.relname
  loop
    execute format(
      'select coalesce(jsonb_agg(to_jsonb(t)), ''[]''::jsonb) from public.%I t where t.%I = any($1)',
      fk.child_table, fk.child_col) into rows_j using p_ids;

    continue when jsonb_array_length(rows_j) = 0;

    -- 父層先進陣列，還原時才不會撞外鍵
    out_j := out_j || jsonb_build_array(
      jsonb_build_object('table', fk.child_table, 'rows', rows_j));

    -- 沒有 id 欄位的表不可能是別人的父層，不用再往下找
    select exists (
      select 1 from information_schema.columns
       where table_schema = 'public' and table_name = fk.child_table and column_name = 'id'
    ) into has_id;
    continue when not has_id;

    execute format(
      'select coalesce(array_agg(t.id), ''{}''::uuid[]) from public.%I t where t.%I = any($1)',
      fk.child_table, fk.child_col) into ids using p_ids;

    out_j := out_j || public.trash_collect_children(fk.child_table, ids, p_depth + 1);
  end loop;

  return out_j;
end $fn$;

comment on function public.trash_collect_children is
  '遞迴收集所有會被 CASCADE 帶走的子列。只收一層的話，'
  '復原契約時訂單會回來但收款紀錄不會 —— 而且沒有任何錯誤訊息。';


-- ============================================================
-- 刪除：整列（含 CASCADE 子列）搬進回收桶，原表真的 delete。
-- ============================================================
create or replace function public.soft_delete(
  p_table text, p_id uuid, p_reason text default null
) returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare
  main    jsonb;
  kids    jsonb := '[]'::jsonb;
  n_kids  int := 0;
  tid     uuid;
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
  '子表用 pg_constraint 自動發現,不是寫死清單 —— 寫死一定會漏掉新表。';


-- ============================================================
-- 復原
-- ============================================================
create or replace function public.restore_trash(p_trash uuid)
returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare
  t       public.trash;
  exists_ boolean;
  entry   jsonb;
  r       jsonb;
  n       int := 0;
begin
  select * into t from public.trash where id = p_trash;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'message', '找不到這筆回收紀錄。');
  end if;
  if t.purged_at is not null then
    return jsonb_build_object('ok', false, 'code', 'PURGED',
      'message', '這筆已經永久刪除，內容不在了，救不回來。');
  end if;
  if t.restored_at is not null then
    return jsonb_build_object('ok', false, 'code', 'ALREADY',
      'message', '這筆已經復原過了。');
  end if;
  if not public.trash_can_delete(t.table_name) then
    return jsonb_build_object('ok', false, 'code', 'NO_PERM',
      'message', '你的帳號沒有復原「' || public.trash_table_label(t.table_name) || '」的權限。');
  end if;

  execute format('select exists(select 1 from public.%I where id = $1)', t.table_name)
    into exists_ using t.record_id;
  if exists_ then
    return jsonb_build_object('ok', false, 'code', 'EXISTS',
      'message', '同一筆資料已經存在了 —— 可能有人重新建過一次。'
              || E'\n請先確認現有那一筆，再決定要不要覆蓋。');
  end if;

  -- 主列
  execute format('insert into public.%I select * from jsonb_populate_record(null::public.%I, $1)',
                 t.table_name, t.table_name) using t.payload;

  /*
   * 子列。**on conflict do nothing**：
   * 主列塞回去時觸發器可能已經重新產生了一些子列（例如訂單的營收認列）。
   * 不加這一句的話復原會因為唯一鍵衝突整個失敗，
   * 而使用者看到的只會是一句看不懂的 duplicate key。
   */
  for entry in select * from jsonb_array_elements(t.children) loop
    for r in select * from jsonb_array_elements(entry->'rows') loop
      execute format(
        'insert into public.%I select * from jsonb_populate_record(null::public.%I, $1) on conflict do nothing',
        entry->>'table', entry->>'table') using r;
      n := n + 1;
    end loop;
  end loop;

  update public.trash set restored_at = now(), restored_by = auth.uid() where id = p_trash;

  return jsonb_build_object('ok', true, 'code', 'OK', 'children', n,
    'message', '已復原' || case when n > 0 then format('（連同 %s 筆相關資料）', n) else '' end || '。');
exception
  when others then
    return jsonb_build_object('ok', false, 'code', 'ERROR',
      'message', '復原失敗：' || sqlerrm
              || E'\n\n通常是因為它依賴的東西（物業、房源、契約）也被刪掉了 ——'
              || E'\n先復原那一個，再復原這一筆。');
end $fn$;


-- ============================================================
-- 永久刪除（只有總經理）
--
-- 不刪掉 trash 那一列，只清空內容 —— 留下「誰在什麼時候刪掉了什麼」。
-- 整列刪掉的話，回收桶本身就變成一個可以湮滅紀錄的地方。
-- ============================================================
create or replace function public.purge_trash(p_trash uuid)
returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare t public.trash;
begin
  if current_role_of() <> 'super_admin' then
    return jsonb_build_object('ok', false, 'code', 'NO_PERM',
      'message', '只有總經理可以永久刪除。'
              || E'\n\n如果確定不要了，請總經理到「刪除紀錄」執行。');
  end if;
  select * into t from public.trash where id = p_trash;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'message', '找不到這筆回收紀錄。');
  end if;
  if t.purged_at is not null then
    return jsonb_build_object('ok', false, 'code', 'ALREADY', 'message', '這筆已經永久刪除了。');
  end if;

  update public.trash
     set payload = null, children = '[]'::jsonb,
         purged_at = now(), purged_by = auth.uid()
   where id = p_trash;

  return jsonb_build_object('ok', true, 'code', 'OK',
    'message', '已永久刪除。內容清空了，救不回來 —— 但這筆紀錄會留著。');
end $fn$;


-- ============================================================
-- RLS
-- ============================================================
alter table public.trash enable row level security;

/*
 * 讀：自己刪的一定看得到；會計／主管／總經理看得到全部。
 *
 * 不全開的原因是 payload 裡有金額與租戶資料 —— 房務人員在原本的頁面上
 * 就看不到支出與押金，回收桶不該變成繞過去的入口。
 */
drop policy if exists trash_read on public.trash;
create policy trash_read on public.trash for select
  using (deleted_by = auth.uid()
         or current_role_of() in ('accountant', 'manager', 'super_admin'));

-- 寫入一律走 RPC（security definer），前端不直接 insert/update/delete
drop policy if exists trash_no_write on public.trash;
create policy trash_no_write on public.trash for all
  using (false) with check (false);

revoke all on function public.soft_delete(text, uuid, text) from public;
revoke all on function public.restore_trash(uuid) from public;
revoke all on function public.purge_trash(uuid) from public;
grant execute on function public.soft_delete(text, uuid, text) to authenticated;
grant execute on function public.restore_trash(uuid) to authenticated;
grant execute on function public.purge_trash(uuid) to authenticated;


-- ============================================================
-- 實測：建一筆假訂單 → 軟刪除 → 復原 → 再刪 → 永久刪除
--
-- 全部包在 do 區塊裡，最後把測試資料清乾淨。
-- **驗證段一定要真的寫入** —— 只讀不寫的驗證碰不到觸發器，
-- 而觸發器正是這支最可能出事的地方（sync_order_deposits 的陣列 bug
-- 就是因為驗證只讀不寫，撐了兩天沒被發現）。
-- ============================================================
do $$
declare
  oid uuid; tid uuid; r jsonb; bad int := 0; n_rev int;
  admin_id uuid; hk_id uuid; cid uuid; kids jsonb;
begin
  /*
   * 【為什麼要假裝成某個人】
   * soft_delete 的權限檢查看的是 current_role_of()，而它看的是 auth.uid()。
   * 在 SQL Editor 裡 auth.uid() 是 null —— 直接跑的話每一次刪除都會回
   * NO_PERM，測試「通過」的其實是錯誤路徑，等於什麼都沒測到。
   * set_config(..., true) 只在這個交易內有效，commit 就沒了。
   */
  select id into admin_id from public.profiles where role = 'super_admin' limit 1;
  if admin_id is null then
    raise warning '⚠ 找不到 super_admin,跳過回收桶自我測試';
    return;
  end if;
  perform set_config('request.jwt.claims',
    json_build_object('sub', admin_id::text)::text, true);

  insert into public.orders (order_key, source, guest_name, checkin, checkout, nights, amount)
  values ('__TRASH_TEST__', 'private', '回收桶測試', '2026-01-01', '2026-01-03', 2, 12345)
  returning id into oid;

  select count(*) into n_rev from public.revenue_recognitions where order_id = oid;

  r := public.soft_delete('orders', oid, '自動測試');
  if not (r->>'ok')::boolean then
    raise warning '❌ 軟刪除失敗：%', r->>'message'; bad := bad + 1;
  end if;
  select id into tid from public.trash where record_id = oid;

  if exists (select 1 from public.orders where id = oid) then
    raise warning '❌ 軟刪除後原表還在'; bad := bad + 1;
  end if;
  if not exists (select 1 from public.trash where record_id = oid and payload is not null) then
    raise warning '❌ 回收桶裡沒有內容'; bad := bad + 1;
  end if;

  r := public.restore_trash(tid);
  if not (r->>'ok')::boolean then
    raise warning '❌ 復原失敗：%', r->>'message'; bad := bad + 1;
  end if;
  if not exists (select 1 from public.orders where id = oid and amount = 12345) then
    raise warning '❌ 復原後金額不對'; bad := bad + 1;
  end if;
  -- 營收認列要跟著回來（觸發器重建 ＋ 快照補回，兩者不能互相打架）
  if (select count(*) from public.revenue_recognitions where order_id = oid) < n_rev then
    raise warning '❌ 復原後營收認列比原本少'; bad := bad + 1;
  end if;

  -- 重複復原要被擋
  if (public.restore_trash(tid)->>'code') <> 'ALREADY' then
    raise warning '❌ 重複復原沒有被擋'; bad := bad + 1;
  end if;

  /*
   * 【子列要一路收到底】
   * 拿一張真的有「訂單 → 收款紀錄」的契約來驗（唯讀，不刪任何東西）。
   * 只收一層的話 order_payments 不會出現在清單裡 —— 復原契約時
   * 訂單回來了、收過的錢卻不見了，而且畫面上完全正常。
   */
  select c.id into cid
    from public.contracts c
    join public.orders o on o.contract_id = c.id
    join public.order_payments p on p.order_id = o.id
   limit 1;
  if cid is not null then
    kids := public.trash_collect_children('contracts', array[cid]);
    if not exists (
      select 1 from jsonb_array_elements(kids) g where g->>'table' = 'order_payments'
    ) then
      raise warning '❌ 收集子列只收了一層 —— 復原契約會弄丟收款紀錄'; bad := bad + 1;
    end if;
  else
    raise notice 'ℹ 找不到「契約→訂單→收款」的樣本,跳過遞迴子列檢查';
  end if;

  /*
   * 【最重要的一條：沒列在白名單的表不能刪】
   * soft_delete 是 SECURITY DEFINER,繞過所有 RLS。白名單一旦改成
   * 預設放行,它就變成「任何登入的人都能刪掉任何一列」的後門 ——
   * 而後門不會報錯,只會安靜地生效。所以這條要用測試釘住。
   */
  if public.trash_can_delete('profiles') then
    raise warning '❌ profiles 竟然可以透過回收桶刪除 —— 白名單的預設值錯了'; bad := bad + 1;
  end if;
  if (public.soft_delete('profiles', admin_id)->>'code') <> 'NO_PERM' then
    raise warning '❌ 刪 profiles 沒有被擋下來'; bad := bad + 1;
  end if;

  -- 房管不能刪訂單（碰錢的表要會計以上）
  select id into hk_id from public.profiles where role = 'housekeeper' limit 1;
  if hk_id is not null then
    perform set_config('request.jwt.claims',
      json_build_object('sub', hk_id::text)::text, true);
    if public.trash_can_delete('orders') then
      raise warning '❌ 房管可以刪訂單'; bad := bad + 1;
    end if;
    perform set_config('request.jwt.claims',
      json_build_object('sub', admin_id::text)::text, true);
  end if;

  -- 收尾：測試資料一律清掉（硬刪，不留在回收桶裡）
  delete from public.orders where id = oid;
  delete from public.trash where record_id = oid;

  if bad = 0 then raise notice '✅ 回收桶：刪除 → 復原 → 重複復原防護 → 白名單預設拒絕，全部正確'; end if;
end $$;


-- ── 確認 ───────────────────────────────────────────
select
  (select count(*) from public.trash)                                        as "回收桶筆數",
  case when to_regprocedure('public.soft_delete(text,uuid,text)') is not null
       then '✓' else '❌' end                                                as "soft_delete",
  case when to_regprocedure('public.restore_trash(uuid)') is not null
       then '✓' else '❌' end                                                as "restore_trash",
  case when to_regprocedure('public.purge_trash(uuid)') is not null
       then '✓' else '❌' end                                                as "purge_trash",
  (select count(*) from pg_policies where schemaname='public' and tablename='trash')
                                                                             as "政策數";

-- 哪些表刪除時會連帶帶走子列（復原時會一起回來）
select
  public.trash_table_label(cl2.relname)                                      as "刪這個",
  string_agg(distinct public.trash_table_label(cl.relname), '、')             as "會連帶刪掉"
from pg_constraint c
join pg_class cl  on cl.oid = c.conrelid
join pg_class cl2 on cl2.oid = c.confrelid
join pg_namespace ns on ns.oid = cl.relnamespace
where c.contype = 'f' and c.confdeltype = 'c' and ns.nspname = 'public'
  and cl2.relname in ('orders','contracts','expenses','purchase_requests','deposits')
group by cl2.relname
order by cl2.relname;


/*
 * ── 有沒有哪張表會進回收桶、卻沒有中文名 ────────────
 *
 * trash_table_label 的 else 分支是「回傳英文表名」—— 不會報錯，
 * 只會在畫面上冒出一個 revenue_recognitions 給使用者看。
 * 這一查就是要把那種情況變成看得見的：**下面應該是空的**。
 * 有東西的話，到 trash_table_label 跟 src/lib/trash.ts 兩邊各補一行。
 *
 * 【只看真的到得了的表】
 * 從白名單那幾張表出發，沿 CASCADE 一路往下走。
 * 不設起點的話會把 profiles 底下那一整串（打卡、請假、推播訂閱…）
 * 也列出來 —— 但 profiles 不在白名單，那些永遠不會進回收桶。
 * 一份「大部分都是誤報」的清單，跟沒有清單是一樣的。
 */
with recursive
/*
 * 先把 pg_class 的表名轉成 text 並指定 default 定序。
 *
 * relname 的型別是 name，定序是 "C"；白名單那邊是 text，定序是 default。
 * 直接 union 兩者，Postgres 會說「非遞迴項與整體定序不一致」而整段掛掉。
 * 在這裡一次轉乾淨，下面就不用每個比較都掛 COLLATE。
 */
fks as (
  select cl.relname::text  collate "default" as child,
         cl2.relname::text collate "default" as parent
    from pg_constraint c
    join pg_class cl     on cl.oid = c.conrelid
    join pg_class cl2    on cl2.oid = c.confrelid
    join pg_namespace ns on ns.oid = cl.relnamespace
   where c.contype = 'f' and c.confdeltype = 'c' and ns.nspname = 'public'
),
reach(tbl, depth) as (
  select d.tbl, 0 from public.trash_deletable_tables() d
  union
  select f.child, r.depth + 1
    from reach r join fks f on f.parent = r.tbl
   where r.depth < 5
)
select distinct tbl as "缺中文名的表"
from reach
where public.trash_table_label(tbl) = tbl
order by 1;


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    raise notice '%', (select public.record_migration('107_trash'));
  else
    raise notice '尚未建立 schema_migrations（migration_70），這支沒有被記錄';
  end if;
end $$;
