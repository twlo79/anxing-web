-- migration_147：押金收款改成一筆一列（比照訂單）
--
-- ============================================================
-- 【要解決什麼】（2026-08-19 使用者指定：「收押金 像左方一樣 可多筆收入」）
--
-- 押金現在是**一次收清**的模型：deposits 上三個欄位
--     received_on / received_method / received_account
-- 收了就填、沒收就空。
--
-- 但實務上收兩次很常見（先收一半、入住當天補齊），而現在的模型
-- **記不下第一筆** —— 只能等收滿了才填一個日期，
-- 於是「已經收了一半」跟「一毛都沒收」在畫面上長得一模一樣。
--
-- 這正是短租訂單當初踩過的坑（migration_84 的註解寫得很清楚），
-- 那邊的解法是 order_payments 一筆一列。押金照抄同一套 ——
-- 兩張表形狀一致，將來看帳的人不用學兩種模型。
--
--
-- ============================================================
-- 【received_on 的意思變了，但只變一點】
--
--   之前:人手動填的「收款日」
--   之後:**收滿的那一天**，由觸發器維護
--
-- 沒收滿就是 null。所以所有既有的判斷（`received_on is null` = 還沒收、
-- 有值 = 錢在我們手上）語意完全不變 —— 押金頁的三張卡、
-- transfer_deposit 的前置檢查、dep_return_needs_receive 約束都不用動。
--
-- 新增的是中間狀態:`received_amount` 大於 0 但小於 amount = 部分收款。
--
-- ★ **不要把 received_on 改成「第一筆收款日」** ——
--   那會讓一筆只收了 100 元的押金看起來像已經收齊，
--   而它會直接通過移轉與退款的前置檢查。
--
--
-- ============================================================
-- 【為什麼合計要存在 deposits 上】
--
-- 跟訂單同一個理由:列表一頁幾十筆，每筆都去查明細就是幾十次往返。
-- 觸發器維護的合計欄位讓列表一次查詢就拿得到，而且可以排序。
--
-- **前端絕對不自己算合計寫回去** —— 兩邊各算一次就會有對不上的一天，
-- 而那一天你只會看到「這筆押金的明細加起來跟上面的數字不一樣」。


-- ── ① 收款明細 ─────────────────────────────────────
create table if not exists public.deposit_payments (
  id          uuid primary key default gen_random_uuid(),
  deposit_id  uuid not null references public.deposits(id) on delete cascade,
  paid_on     date not null,
  amount      numeric not null,
  /*
   * 收款方式與帳號。`internal` 是押金移房（migration_146）——
   * 錢沒有實際進出，只是換了名目。它選不到（不在 METHOD_OPTS 裡），
   * 只由 transfer_deposit 寫入。
   */
  method      text,
  /*
   * on update cascade:帳號代碼改名時自己跟上。
   * migration_111 為了 order_payments 補過這件事,這裡一開始就做對。
   */
  account     text references public.payment_accounts(code) on update cascade,
  note        text,
  created_at  timestamptz not null default now(),
  created_by  uuid references public.profiles(id),
  deleted_at  timestamptz,
  deleted_by  uuid references public.profiles(id)
);

comment on table public.deposit_payments is
  '押金收款明細，一筆一列（migration_147）。押金常常分兩次收，'
  '而單一個 received_on 記不下第一筆 —— 「收了一半」跟「一毛沒收」會長得一樣。'
  '合計由觸發器寫回 deposits.received_amount，前端不自己算。';

create index if not exists dep_pay_dep_idx on public.deposit_payments (deposit_id, paid_on);
-- 回收桶會用 deleted_at 過濾，沒有索引的話每次都全表掃
create index if not exists dep_pay_alive_idx on public.deposit_payments (deposit_id) where deleted_at is null;


-- ── ② 合計欄位 ─────────────────────────────────────
alter table public.deposits
  add column if not exists received_amount numeric not null default 0;

comment on column public.deposits.received_amount is
  '實收合計（台幣），由 deposit_payments 的觸發器維護。'
  '大於 0 而小於 amount = 部分收款。**不要用前端算出來的值覆蓋它**。';


-- ── ③ 觸發器 ───────────────────────────────────────
/*
 * 【為什麼 received_method / received_account 也一起維護】
 *
 * 那兩欄全站有十幾個地方在讀（押金頁、請款頁、Excel、分享訊息）。
 * 留著不管的話它們會停在回填當下的值，然後慢慢跟明細對不上 ——
 * 而畫面上看起來完全正常。
 *
 * 規則:只有一筆收款時填那一筆的；多筆時清成 null，
 * 畫面顯示「多筆」並要人去看明細。**不要挑最後一筆填** ——
 * 那會讓一筆現金＋一筆匯款的押金看起來像全部匯款進來的。
 */
create or replace function public.sync_deposit_received()
returns trigger language plpgsql security definer set search_path = public as $fn$
declare
  d_id uuid;
  v_sum numeric;
  v_cnt int;
  v_due numeric;
  v_on  date;
  v_method text;
  v_acct text;
begin
  d_id := coalesce(new.deposit_id, old.deposit_id);

  select coalesce(sum(amount), 0), count(*)
    into v_sum, v_cnt
    from public.deposit_payments
   where deposit_id = d_id and deleted_at is null;

  select coalesce(amount, 0) into v_due from public.deposits where id = d_id;

  /*
   * 收滿的那一天 = 累計第一次達到應收金額的那一筆的日期。
   *
   * 不是 max(paid_on) —— 之後補記一筆超收的話，收滿日會莫名其妙往後跳。
   * 也不是 min —— 那是第一筆，見檔頭的警告。
   */
  v_on := null;
  if v_due > 0 and round(v_sum, 2) >= round(v_due, 2) then
    select paid_on into v_on from (
      select paid_on,
             sum(amount) over (order by paid_on, created_at
                               rows between unbounded preceding and current row) as run
        from public.deposit_payments
       where deposit_id = d_id and deleted_at is null
    ) t where round(t.run, 2) >= round(v_due, 2)
    order by t.paid_on limit 1;
  end if;

  if v_cnt = 1 then
    select method, account into v_method, v_acct
      from public.deposit_payments
     where deposit_id = d_id and deleted_at is null;
  else
    v_method := null; v_acct := null;
  end if;

  update public.deposits set
    received_amount  = v_sum,
    received_on      = v_on,
    received_method  = v_method,
    received_account = v_acct
  where id = d_id;

  return coalesce(new, old);
end $fn$;

drop trigger if exists trg_dep_payments_sync on public.deposit_payments;
create trigger trg_dep_payments_sync
  after insert or update or delete on public.deposit_payments
  for each row execute function public.sync_deposit_received();


-- ── ④ RLS ──────────────────────────────────────────
/*
 * 跟 deposits 一模一樣的規則:會計以上可寫、管家只能看（migration_139）。
 *
 * ★ 抄一份而不是共用述詞是刻意的 —— Postgres 沒有「繼承另一張表的 policy」。
 *   但兩邊要一起改,不然會出現「押金看得到、收款明細看不到」的半殘狀態。
 */
alter table public.deposit_payments enable row level security;

drop policy if exists dep_pay_read on public.deposit_payments;
create policy dep_pay_read on public.deposit_payments for select
  using ((current_role_of() = ANY (ARRAY['housekeeper','accountant','manager','super_admin'])));

drop policy if exists dep_pay_write on public.deposit_payments;
create policy dep_pay_write on public.deposit_payments for all
  using ((current_role_of() = ANY (ARRAY['accountant','manager','super_admin'])))
  with check ((current_role_of() = ANY (ARRAY['accountant','manager','super_admin'])));


-- ── ⑤ 回收桶 ───────────────────────────────────────
/*
 * 收款記錯了是刪掉重記（跟訂單同一個道理:一筆收款是一個事實）。
 * 刪掉的要能救回來,所以要進回收桶。
 *
 * `trash_deletable_tables()` 是整份回收桶的單一事實來源 ——
 * 沒加進去的表，soft_delete 會直接拒絕。
 */
create or replace function public.trash_deletable_tables()
returns table (tbl text, min_role text) language sql immutable as $fn$
  select * from (values
    ('orders', 'accountant'), ('contracts', 'accountant'), ('expenses', 'accountant'),
    ('purchase_requests', 'accountant'), ('purchase_request_items', 'accountant'),
    ('deposits', 'accountant'), ('invoices', 'accountant'),
    ('order_payments', 'accountant'), ('contract_payments', 'accountant'),
    -- ★ 新增（migration_147）
    ('deposit_payments', 'accountant'),
    ('contract_recurring_charges', 'accountant'), ('recurring_charges', 'accountant'),
    ('estates', 'accountant'), ('properties', 'accountant'),
    ('payment_accounts', 'accountant'), ('payee_presets', 'accountant'),
    ('hk_work_item', 'manager'), ('hk_event', 'manager'), ('cleaning_records', 'manager'),
    ('reviews', 'manager'), ('customers', 'manager'), ('announcements', 'manager'),
    ('attachments', 'any')
  ) v(tbl, min_role);
$fn$;


/*
 * 回收桶的中文名與摘要。
 *
 * 【為什麼要一起改】兩份對照表（SQL 這份給查詢結果、lib/trash.ts 那份給畫面）
 * 少改一邊，回收桶裡就會直接顯示英文表名 `deposit_payments`。
 *
 * 摘要照 order_payments 的格式:日期 ＋ 金額。回收桶列表上就靠這一句
 * 判斷「要復原的是不是這一筆」。
 */
create or replace function public.trash_table_label(p_table text)
returns text language sql immutable as $fn$
  select case p_table
    when 'orders' then '訂單'
    when 'contracts' then '契約'
    when 'expenses' then '支出'
    when 'purchase_requests' then '請款單'
    when 'purchase_request_items' then '請款項目'
    when 'deposits' then '押金'
    when 'invoices' then '發票'
    when 'order_payments' then '訂單收款'
    when 'deposit_payments' then '押金收款'      -- ★ migration_147
    when 'contract_payments' then '契約期款'
    when 'revenue_recognitions' then '營收認列'
    when 'attachments' then '憑證'
    when 'contract_recurring_charges' then '固定加費'
    when 'recurring_charges' then '定期收費'
    when 'reviews' then '評價'
    when 'estates' then '物業'
    when 'properties' then '房源'
    when 'payment_accounts' then '收付款帳號'
    when 'payee_presets' then '常用帳號'
    when 'customers' then '客戶'
    when 'announcements' then '公告'
    when 'hk_work_item' then '房務排班'
    when 'hk_event' then '房務事件'
    when 'cleaning_records' then '清潔記錄'
    when 'announcement_reads' then '公告已讀'
    when 'staff_properties' then '管家負責房源'
    else p_table
  end;
$fn$;


/*
 * 回收桶列表上那一句識別文字。
 *
 * 不加的話會掉到最後的 else，而 deposit_payments 沒有 name/title/label/item_name
 * 四個欄位裡的任何一個 —— 結果是整列空白，只剩 id 前八碼。
 * 那時要復原的人根本分不出哪一筆是哪一筆。
 *
 * 格式照 order_payments:日期 ＋ 金額。
 */
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
    -- ★ 新增（migration_147）
    when 'deposit_payments' then
      concat_ws(' ', r->>'paid_on', '$' || to_char(coalesce((r->>'amount')::numeric, 0), 'FM999,999,999'))
    when 'reviews' then concat_ws(' ', r->>'guest_name', r->>'checkout_date', r->>'overall_rating' || '★')
    when 'customers' then concat_ws(' ', r->>'name', r->>'property_label')
    when 'announcements' then r->>'title'
    else concat_ws(' ', r->>'name', r->>'title', r->>'label', r->>'item_name')
  end), '')
$fn$;


-- ── ⑥ 收款憑證掛到「哪一筆收款」 ──────────────────
/*
 * 【為什麼不繼續掛在押金上】（2026-08-19 使用者指定「照片上傳 分收押金 跟 退押金」）
 *
 * 收兩次就有兩張單據。都掛在押金底下的話，看的人分不出
 * 哪一張對應哪一筆 —— 而金額對不上時，那正是唯一能查的東西。
 *
 * 訂單那邊已經是這個做法（attachments.order_payment_id，migration_85），
 * 這裡照抄:收款證明掛收款、退款憑證留在押金上。
 *
 * ★ 既有的圖片**原地不動**。系統分不出哪張是收款單據、哪張是退款水單 ——
 *   那個資訊從來沒存過。硬猜會把退款水單標成收款證明，而看的人會相信它。
 *   畫面上那些會標「其他憑證（舊）」。
 */
alter table public.attachments
  add column if not exists deposit_payment_id uuid
    references public.deposit_payments(id) on delete cascade;

create index if not exists att_dep_pay_idx on public.attachments (deposit_payment_id);

/*
 * att_one_parent 要重建 —— 它規定「剛好掛在一個母體底下」，
 * 多一欄就要多算一個。
 *
 * ★ 用動態 SQL 從 information_schema 組欄位清單，不寫死。
 *   schema-baseline 那份是舊的（沒有 order_payment_id，那是 migration_85 加的），
 *   照它寫死會把已經在用的那一欄從約束裡刪掉 ——
 *   而症狀是「同時掛在訂單收款與押金底下」這種壞資料再也不會被擋。
 */
do $$
declare cols text;
begin
  select string_agg(column_name, ', ' order by column_name)
    into cols
    from information_schema.columns
   where table_schema = 'public' and table_name = 'attachments'
     and column_name in ('request_id', 'expense_id', 'deposit_id',
                         'order_payment_id', 'deposit_payment_id');

  alter table public.attachments drop constraint if exists att_one_parent;
  execute format(
    'alter table public.attachments add constraint att_one_parent check (num_nonnulls(%s) = 1)',
    cols);
  raise notice 'att_one_parent 重建，母體欄位：%', cols;
end $$;


-- ── ⑦ 回填 ─────────────────────────────────────────
/*
 * ★★ 既有的 received_on 要變成一筆收款，否則上線那一刻
 *    所有押金的實收都會歸零 —— 而觸發器接手之後就再也回不去了。
 *
 * 只回填「有 received_on 而且還沒有任何明細」的，跑第二次不會重複。
 * 金額用 deposits.amount（台幣那部分）—— 舊模型本來就是「一次收清」，
 * 所以有 received_on 就代表收滿了。
 */
insert into public.deposit_payments (deposit_id, paid_on, amount, method, account, note)
select d.id, d.received_on, coalesce(d.amount, 0),
       d.received_method, d.received_account,
       '（migration_147 由舊欄位轉入）'
  from public.deposits d
 where d.received_on is not null
   and coalesce(d.amount, 0) > 0
   and not exists (select 1 from public.deposit_payments p where p.deposit_id = d.id);


-- ── ⑧ 押金移房要改成寫一筆收款 ─────────────────────
/*
 * ★★ 不改的話 migration_146 的移轉會直接壞掉。
 *
 * transfer_deposit 原本是**直接寫** B 的 received_on / received_method。
 * 現在那幾欄由觸發器維護，所以會發生：
 *
 *   ① 移轉當下 received_on 有值，但 received_amount 還是 0
 *      → 畫面顯示「尚未收」，而它明明剛剛收到一筆移轉進來的押金
 *   ② 之後任何一筆收款有異動，觸發器就把 received_on 蓋回 null
 *
 * 兩個都**不會報錯**。所以改成:移轉時插一筆 deposit_payments，
 * 方式 `internal`，剩下的交給觸發器。
 *
 * 這樣「這筆押金的錢從哪來」永遠只有一張表回答得了。
 */
create or replace function public.transfer_deposit(
  p_from uuid, p_to uuid, p_on date default current_date
) returns table(ok boolean, item text, detail text)
language plpgsql security definer set search_path = public as $fn$
declare
  f public.deposits;
  t public.deposits;
  v_from_name text;
  v_to_name   text;
begin
  if current_role_of() not in ('accountant', 'super_admin') then
    return query select false, '權限不足'::text, '只有會計與總管理員能移轉押金'::text;
    return;
  end if;

  if p_from is null or p_to is null or p_from = p_to then
    return query select false, '來源與目的不能是同一筆'::text, ''::text;
    return;
  end if;

  select * into f from public.deposits where id = p_from;
  select * into t from public.deposits where id = p_to;
  if f.id is null then
    return query select false, '找不到來源押金'::text, ''::text; return;
  end if;
  if t.id is null then
    return query select false, '找不到目的押金'::text, ''::text; return;
  end if;

  v_from_name := coalesce(nullif(f.room, ''), nullif(f.guest_name, ''), '（未填房號）');
  v_to_name   := coalesce(nullif(t.room, ''), nullif(t.guest_name, ''), '（未填房號）');

  if f.received_on is null then
    return query select false, '來源還沒收到押金'::text,
      v_from_name || ' 這筆是「尚未收」—— 沒有錢可以移'::text; return;
  end if;
  if f.returned_on is not null then
    return query select false, '來源已經退款了'::text,
      v_from_name || ' 於 ' || f.returned_on || ' 已退' ||
      case when f.transfer_to_id is not null then '（移轉出去）' else '' end; return;
  end if;
  if f.orphaned then
    return query select false, '來源是孤兒紀錄'::text,
      '來源訂單／契約已經不在了,請先確認這筆押金的歸屬'::text; return;
  end if;

  if t.received_on is not null then
    return query select false, '目的已經收過押金了'::text,
      v_to_name || ' 於 ' || t.received_on || ' 已收 —— 重複收兩次押金是錯的'::text; return;
  end if;
  /*
   * ★ 目的**部分收款**也要擋（migration_147 新增的狀態）。
   *   收了一半再移一整筆進來會變成超收,而畫面上只會看到一個對不起來的數字。
   */
  if coalesce(t.received_amount, 0) > 0 then
    return query select false, '目的已經收過一部分押金了'::text,
      v_to_name || ' 已收 ' || to_char(t.received_amount, 'FM999,999,999') ||
      ' —— 先把那幾筆處理掉再移轉'::text; return;
  end if;
  if t.returned_on is not null then
    return query select false, '目的已經退款了'::text, ''::text; return;
  end if;
  if t.orphaned then
    return query select false, '目的是孤兒紀錄'::text, ''::text; return;
  end if;

  if coalesce(f.currency, 'TWD') <> coalesce(t.currency, 'TWD') then
    return query select false, '幣別不同'::text,
      coalesce(f.currency,'TWD') || ' → ' || coalesce(t.currency,'TWD') ||
      ' —— 換匯是另一件事,不能靠移轉帶過'::text; return;
  end if;
  if round(coalesce(f.amount, 0), 2) <> round(coalesce(t.amount, 0), 2) then
    return query select false, '金額不同,不能移轉'::text,
      v_from_name || ' 收了 ' || to_char(coalesce(f.amount,0), 'FM999,999,999') ||
      '，' || v_to_name || ' 要 ' || to_char(coalesce(t.amount,0), 'FM999,999,999') ||
      '，差 ' || to_char(abs(coalesce(t.amount,0) - coalesce(f.amount,0)), 'FM999,999,999') ||
      '。請先到' || case when t.order_id is not null then '訂單' else '契約' end ||
      '把押金金額改成一致,再回來移轉'::text; return;
  end if;
  if to_jsonb(f)->'lines' is distinct from to_jsonb(t)->'lines' then
    return query select false, '多幣別明細不同,不能移轉'::text,
      '兩邊的外幣組成要一模一樣'::text; return;
  end if;

  -- 來源:退出去（移轉），這幾欄不歸觸發器管
  update public.deposits set
    returned_on      = p_on,
    returned_method  = 'internal',
    returned_account = null,
    refund_status    = 'approved',
    transfer_to_id   = t.id,
    transferred_by   = auth.uid(),
    transferred_at   = now(),
    note = concat_ws('・', nullif(note, ''),
             '押金移轉至 ' || v_to_name || ' ' || to_char(p_on, 'YYYY-MM-DD'))
  where id = f.id;

  /*
   * 目的:插一筆收款，received_on / received_amount 由觸發器算。
   * **不要直接 update received_***  —— 見這一段開頭的說明。
   */
  insert into public.deposit_payments (deposit_id, paid_on, amount, method, account, note, created_by)
  values (t.id, p_on, coalesce(f.amount, 0), 'internal', null,
          '押金移轉自 ' || v_from_name, auth.uid());

  update public.deposits set
    transfer_from_id = f.id,
    transferred_by   = auth.uid(),
    transferred_at   = now(),
    note = concat_ws('・', nullif(note, ''),
             '押金移轉自 ' || v_from_name || ' ' || to_char(p_on, 'YYYY-MM-DD'))
  where id = t.id;

  return query select true, '已移轉'::text,
    v_from_name || ' → ' || v_to_name || '，NT$ ' ||
    to_char(coalesce(f.amount, 0), 'FM999,999,999') || '，' ||
    to_char(p_on, 'YYYY-MM-DD') || '。錢沒有實際進出,兩邊備註都已註記'::text;
end $fn$;


/*
 * 撤銷也要跟著改:把那一筆 internal 收款刪掉，
 * received_on / received_amount 由觸發器歸零。
 *
 * 用真的 delete 而不是 soft delete —— 那筆收款從來沒有真的發生過
 * （錢沒有進出），留在回收桶裡只會讓人以為曾經收過。
 */
create or replace function public.undo_deposit_transfer(
  p_id uuid
) returns table(ok boolean, item text, detail text)
language plpgsql security definer set search_path = public as $fn$
declare
  f      public.deposits;
  t      public.deposits;
  me_row public.deposits;
begin
  if current_role_of() not in ('accountant', 'super_admin') then
    return query select false, '權限不足'::text, '只有會計與總管理員能撤銷移轉'::text;
    return;
  end if;

  select * into me_row from public.deposits where id = p_id;
  if me_row.id is null then
    return query select false, '找不到這筆押金'::text, ''::text; return;
  end if;
  if me_row.transfer_from_id is not null then
    t := me_row;
    select * into f from public.deposits where id = me_row.transfer_from_id;
  else
    f := me_row;
    select * into t from public.deposits where id = me_row.transfer_to_id;
  end if;

  if f.id is null or t.id is null or f.transfer_to_id is distinct from t.id
     or t.transfer_from_id is distinct from f.id then
    return query select false, '這筆不是移轉來的'::text,
      '找不到成對的另一半 —— 只有移轉產生的那兩列才能撤銷'::text; return;
  end if;

  if t.returned_on is not null then
    return query select false, '目的那筆已經退款了,不能撤銷'::text,
      coalesce(nullif(t.room,''), '目的') || ' 於 ' || t.returned_on ||
      ' 已退款 —— 錢已經出去了,要調整請走一般退款流程'::text; return;
  end if;

  update public.deposits set
    returned_on = null, returned_method = null, returned_account = null,
    refund_status = 'none',
    transfer_to_id = null, transferred_by = null, transferred_at = null,
    note = concat_ws('・', nullif(note, ''),
             '撤銷移轉 ' || to_char(current_date, 'YYYY-MM-DD'))
  where id = f.id;

  -- 先刪收款（觸發器會把 received_* 歸零），再清移轉欄位
  delete from public.deposit_payments
   where deposit_id = t.id and method = 'internal';

  update public.deposits set
    transfer_from_id = null, transferred_by = null, transferred_at = null,
    note = concat_ws('・', nullif(note, ''),
             '撤銷移轉 ' || to_char(current_date, 'YYYY-MM-DD'))
  where id = t.id;

  return query select true, '已撤銷移轉'::text,
    coalesce(nullif(f.room,''), '來源') || ' 回到暫收中，' ||
    coalesce(nullif(t.room,''), '目的') || ' 回到尚未收。備註保留兩邊的紀錄'::text;
end $fn$;


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('147_deposit_payments');
  end if;
end $$;


-- ============================================================
-- 驗證
-- ============================================================
do $$
declare n int; m int; k int;
begin
  drop table if exists _chk147;
  create temp table _chk147 (ord int, item text, result text, detail text);

  insert into _chk147 values (1, 'deposit_payments 表',
    case when to_regclass('public.deposit_payments') is not null then '✅' else '❌' end,
    '押金收款明細，一筆一列');

  insert into _chk147 values (2, 'deposits.received_amount',
    case when exists (select 1 from information_schema.columns
                       where table_schema = 'public' and table_name = 'deposits'
                         and column_name = 'received_amount') then '✅' else '❌' end,
    '實收合計，由觸發器維護');

  insert into _chk147 values (3, '觸發器',
    case when exists (select 1 from pg_trigger
                       where tgname = 'trg_dep_payments_sync' and not tgisinternal)
         then '✅' else '❌' end, '明細一改，合計與收滿日跟著走');

  insert into _chk147 values (4, '回收桶已註冊',
    case when exists (select 1 from public.trash_deletable_tables()
                       where tbl = 'deposit_payments') then '✅' else '❌' end,
    '收款記錯是刪掉重記，要救得回來');

  /*
   * ★★ 這一條是整支 migration 最重要的檢查。
   *
   * 回填之後，每一筆「本來就已收」的押金，received_amount 必須等於 amount。
   * 對不上就代表有押金的實收憑空歸零了 —— 而畫面上它會變成「尚未收」,
   * 看起來像有人忘了記帳,不會有人想到是這支 migration 弄的。
   */
  select count(*) into n from public.deposits where received_on is not null;
  select count(*) into m from public.deposits
   where received_on is not null and round(received_amount, 2) = round(coalesce(amount, 0), 2);
  insert into _chk147 values (5, '★★ 已收的押金合計對得上', m || ' / ' || n,
    case when m = n then '✅ 全部對得上'
         else '❌ 有 ' || (n - m) || ' 筆的實收跟應收不一致，下面那張表列出來了' end);

  select count(*) into k from public.deposit_payments where deleted_at is null;
  insert into _chk147 values (6, '回填出來的收款筆數', k || ' 筆',
    '每一筆都標了「由舊欄位轉入」，之後新增的不會有那句備註');

  select count(*) into n from public.deposits
   where received_amount > 0 and received_amount < coalesce(amount, 0);
  insert into _chk147 values (7, '部分收款', n || ' 筆',
    case when n = 0 then '目前沒有（舊模型記不下部分收款，這是預期的）'
         else '★ 不該有 —— 舊資料全是一次收清' end);

  insert into _chk147 values (8, 'attachments.deposit_payment_id',
    case when exists (select 1 from information_schema.columns
                       where table_schema = 'public' and table_name = 'attachments'
                         and column_name = 'deposit_payment_id') then '✅' else '❌' end,
    '收款證明掛在那一筆收款上；退款憑證留在押金上');

  /*
   * ★★ 重建 att_one_parent 時不能把既有的母體欄位弄丟。
   *    弄丟的話「同時掛在兩個母體底下」這種壞資料再也不會被擋，
   *    而它只會在某一天讓同一張圖出現在兩個地方。
   */
  select count(*) into n from information_schema.columns
   where table_schema = 'public' and table_name = 'attachments'
     and column_name in ('request_id','expense_id','deposit_id',
                         'order_payment_id','deposit_payment_id');
  insert into _chk147 values (9, '★ att_one_parent 涵蓋的母體欄位', n || ' 個',
    case when n >= 4 then '✅ 既有的都還在（請款／支出／押金／訂單收款＋押金收款）'
         else '★ 少於預期，檢查一下是不是有欄位被漏掉' end);

  select count(*) into n from public.attachments where deposit_id is not null;
  insert into _chk147 values (10, '既有的押金憑證', n || ' 張',
    '原地不動 —— 分不出哪張是收款單據哪張是退款水單,'
    '畫面上會標「其他憑證（舊）」。新上傳的才分流');
end $$;

select item as "檢查項目", result as "結果", detail as "說明"
from _chk147 order by ord;


-- ★ 對不上的那幾筆（上面第 5 項是 ❌ 才會有內容）
select
  coalesce(nullif(d.room, ''), d.guest_name, '（未填）') as "房源／房客",
  d.amount            as "應收",
  d.received_amount   as "實收",
  d.received_on       as "收滿日",
  (select count(*) from public.deposit_payments p
    where p.deposit_id = d.id and p.deleted_at is null) as "明細筆數"
from public.deposits d
where d.received_on is not null
  and round(d.received_amount, 2) <> round(coalesce(d.amount, 0), 2)
order by 1;
