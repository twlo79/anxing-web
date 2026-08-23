-- migration_140：採購需求單
--
-- ============================================================
-- 【它取代什麼】（2026-08-17 使用者指定）
--
-- 現在是 Google 表單。填完躺在試算表裡，而請款在 ERP ——
-- 會計要在兩個系統之間手動搬，而搬的過程沒有痕跡:
-- 哪些還沒處理、這張請款單是為了哪個需求開的、
-- 同一張需求分兩次買第二次買了什麼 —— 全部只有經手人知道。
--
-- 規格見 docs/採購需求.md。
--
--
-- ============================================================
-- 【狀態掛在「項目」，不掛在「單」】
--
-- 一張需求單可以分幾次買。狀態放在單上的話，
-- 「買了三項還剩兩項」只能表達成一個含糊的 partial ——
-- 而那五項各自到哪了看不出來。
--
-- 單的 status 由項目**推導**（觸發器維護），不讓人手動改 ——
-- 手動改就會跟項目對不上，而那不會報錯。

-- ── 需求單 ─────────────────────────────────────────
create table if not exists public.purchase_demands (
  id            uuid primary key default gen_random_uuid(),
  demand_no     text unique,
  requester_id  uuid not null references public.profiles(id),
  requested_on  date not null default (now() at time zone 'Asia/Taipei')::date,
  note          text,
  /*
   * open      還沒有任何項目被請款
   * partial   有些請款了、有些還沒
   * done      全部請款或取消
   * cancelled 整張作廢
   *
   * **由觸發器推導**（trg_demand_rollup）。手動改會跟項目對不上。
   */
  status        text not null default 'open'
                check (status in ('open', 'partial', 'done', 'cancelled')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table public.purchase_demands is
  '採購需求單。**不審核** —— 它只是「我需要這個」的登記，'
  '真正把關的是請款單的兩票核可，錢在那裡才出去。'
  'status 由項目推導（trg_demand_rollup），不要手動改。';

-- ── 需求項目 ───────────────────────────────────────
create table if not exists public.purchase_demand_items (
  id              uuid primary key default gen_random_uuid(),
  demand_id       uuid not null references public.purchase_demands(id) on delete cascade,
  item_name       text not null,
  spec            text,
  qty             numeric not null default 1 check (qty > 0),
  /*
   * 用途是**物業**不是房源（使用者指定）——
   * 採購幾乎都是整棟共用的（清潔用品、備品、工具），
   * 選到房號反而要每次想「那算哪一間的」。
   */
  estate_id       uuid not null references public.estates(id),
  /** 詢價單價。參考用,不是最終金額 —— 實際金額在請款單上填 */
  unit_price_est  numeric,
  note            text,
  status          text not null default 'pending'
                  check (status in ('pending', 'quoted', 'requested', 'done', 'cancelled')),
  /*
   * 被哪一**列**請款項目領走。
   *
   * 【為什麼指到 item 不是 request】
   * 勾選是以項目為單位的 —— 一張請款單可能只領走五項裡的兩項。
   * 指到單的話「這一項在請款單上是哪一列」就查不到,而對帳要的正是那個。
   *
   * on delete set null:請款單被刪掉時這一項要回到待辦,不是跟著消失。
   */
  request_item_id uuid references public.purchase_request_items(id) on delete set null,
  created_at      timestamptz not null default now()
);

create index if not exists pdi_demand_idx on public.purchase_demand_items (demand_id);
create index if not exists pdi_status_idx on public.purchase_demand_items (status)
  where status in ('pending', 'quoted');
create index if not exists pdi_reqitem_idx on public.purchase_demand_items (request_item_id)
  where request_item_id is not null;

comment on column public.purchase_demand_items.request_item_id is
  '被哪一列請款項目領走。指到 item 不是 request —— 勾選以項目為單位,'
  '一張請款單可能只領走五項裡的兩項。刪請款單時設回 null,那一項回到待辦。';


-- ── 單號 ───────────────────────────────────────────
/*
 * `DM-YYYYMM-NNN`。跟請款單的 `PR-` 同一個形狀 ——
 * 兩種單並排在畫面上時,前兩個字就分得出來。
 *
 * 流水號按**月**重來。全域流水的話三年後會變成 DM-202608-1247，
 * 那個數字沒有人記得住,而月內序號「這個月第 3 張」是講得出口的。
 */
create or replace function public.gen_demand_no() returns trigger
language plpgsql as $fn$
declare ym text; n int;
begin
  if new.demand_no is not null then return new; end if;
  ym := to_char(coalesce(new.requested_on, current_date), 'YYYYMM');
  select coalesce(max(substring(demand_no from 12)::int), 0) + 1 into n
    from public.purchase_demands
   where demand_no like 'DM-' || ym || '-%';
  new.demand_no := 'DM-' || ym || '-' || lpad(n::text, 3, '0');
  return new;
end $fn$;

drop trigger if exists trg_demand_no on public.purchase_demands;
create trigger trg_demand_no before insert on public.purchase_demands
  for each row execute function public.gen_demand_no();


-- ── 單的狀態由項目推導 ─────────────────────────────
create or replace function public.demand_rollup(p_demand uuid) returns void
language plpgsql as $fn$
declare n_total int; n_open int; n_done int;
begin
  select count(*),
         count(*) filter (where status in ('pending', 'quoted')),
         count(*) filter (where status in ('requested', 'done', 'cancelled'))
    into n_total, n_open, n_done
    from public.purchase_demand_items where demand_id = p_demand;

  update public.purchase_demands d
     set status = case
           when d.status = 'cancelled' then 'cancelled'   -- 整張作廢過就不再回頭
           when n_total = 0            then 'open'
           when n_open = 0             then 'done'
           when n_done > 0             then 'partial'
           else 'open' end,
         updated_at = now()
   where d.id = p_demand;
end $fn$;

create or replace function public.trg_demand_rollup() returns trigger
language plpgsql as $fn$
begin
  perform public.demand_rollup(coalesce(new.demand_id, old.demand_id));
  return coalesce(new, old);
end $fn$;

drop trigger if exists trg_pdi_rollup on public.purchase_demand_items;
create trigger trg_pdi_rollup
  after insert or update or delete on public.purchase_demand_items
  for each row execute function public.trg_demand_rollup();


-- ── 已請款的項目不能改 ─────────────────────────────
/*
 * 靠觸發器擋，不是靠前端。
 *
 * 改了品名或數量之後跟請款單對不上，而**那不會報錯** ——
 * 只會在某次對帳時發現「請款單上寫 6 瓶，需求單上寫 12 瓶」，
 * 而那時已經沒有人記得是誰改的。
 *
 * 只擋內容,不擋 status 與 request_item_id —— 那兩個正是流程要動的。
 */
create or replace function public.trg_pdi_lock() returns trigger
language plpgsql as $fn$
begin
  if old.request_item_id is not null
     and (new.item_name is distinct from old.item_name
          or new.qty is distinct from old.qty
          or new.estate_id is distinct from old.estate_id
          or new.spec is distinct from old.spec) then
    raise exception '這一項已經轉成請款單（%），內容不能再改。要改請先取消那張請款單。',
      old.request_item_id;
  end if;
  return new;
end $fn$;

drop trigger if exists trg_pdi_lock on public.purchase_demand_items;
create trigger trg_pdi_lock before update on public.purchase_demand_items
  for each row execute function public.trg_pdi_lock();


-- ── 請款單被駁回 → 那幾項退回待辦 ──────────────────
/*
 * 【這是最容易漏的一條】（使用者確認:全部退回）
 *
 * 不做的話，被駁回的那幾項會**靜靜地卡在 requested**，
 * 永遠不再出現在會計的待辦裡 —— 而需求還在，東西還是沒買。
 *
 * 沒有人會發現，因為畫面上那張需求單看起來是「已請款」。
 */
create or replace function public.trg_pr_reject_demands() returns trigger
language plpgsql as $fn$
begin
  if new.status = 'rejected' and coalesce(old.status, '') <> 'rejected' then
    update public.purchase_demand_items i
       set status = 'pending', request_item_id = null
      from public.purchase_request_items ri
     where ri.request_id = new.id and i.request_item_id = ri.id;
  end if;
  return new;
end $fn$;

drop trigger if exists trg_pr_reject_demands on public.purchase_requests;
create trigger trg_pr_reject_demands
  after update on public.purchase_requests
  for each row execute function public.trg_pr_reject_demands();


-- ── 第五種通知：採購需求 ───────────────────────────
/*
 * 前四種是 orders / approvals / reviews / cleaning（migration_92）。
 * 採購需求不屬於任何一種 —— 硬塞進「審核」的話，
 * 關掉審核通知的人會連請款核可也收不到。
 *
 * 預設 true —— 這是新功能,沒有「維持現狀」的問題,
 * 而收不到的話會計不知道有需求進來。
 */
alter table public.notification_prefs
  add column if not exists purchasing boolean not null default true;

comment on column public.notification_prefs.purchasing is
  '採購需求通知（migration_140）。有人提出新的採購需求時通知會計以上。'
  '預設 true —— 新功能沒有維持現狀的問題,而收不到的話會計不知道有需求進來。';


-- ── RLS ────────────────────────────────────────────
alter table public.purchase_demands      enable row level security;
alter table public.purchase_demand_items enable row level security;

/*
 * 【「只看自己的」一定要寫進 policy】
 *
 * cleaner 與 housekeeper 的 RLS 相同（migration_131）——
 * 前端篩選擋不住打網址。而採購需求裡有物業、數量、詢價，
 * 那是不需要讓每個人都看到的營運資訊。
 */
drop policy if exists pd_own   on public.purchase_demands;
drop policy if exists pd_read  on public.purchase_demands;
drop policy if exists pd_write on public.purchase_demands;

create policy pd_own on public.purchase_demands for all
  using (requester_id = auth.uid()) with check (requester_id = auth.uid());
create policy pd_read on public.purchase_demands for select
  using (current_role_of() in ('accountant', 'manager', 'super_admin'));
create policy pd_write on public.purchase_demands for all
  using (current_role_of() in ('accountant', 'manager', 'super_admin'))
  with check (current_role_of() in ('accountant', 'manager', 'super_admin'));

drop policy if exists pdi_own   on public.purchase_demand_items;
drop policy if exists pdi_read  on public.purchase_demand_items;
drop policy if exists pdi_write on public.purchase_demand_items;

create policy pdi_own on public.purchase_demand_items for all
  using (exists (select 1 from public.purchase_demands d
                  where d.id = demand_id and d.requester_id = auth.uid()))
  with check (exists (select 1 from public.purchase_demands d
                       where d.id = demand_id and d.requester_id = auth.uid()));
create policy pdi_read on public.purchase_demand_items for select
  using (current_role_of() in ('accountant', 'manager', 'super_admin'));
create policy pdi_write on public.purchase_demand_items for all
  using (current_role_of() in ('accountant', 'manager', 'super_admin'))
  with check (current_role_of() in ('accountant', 'manager', 'super_admin'));


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('140_purchase_demands');
  end if;
end $$;


-- ============================================================
-- 驗證
-- ============================================================
do $$
declare v_user uuid; v_estate uuid; d1 uuid; i1 uuid; i2 uuid; n int; s text;
begin
  drop table if exists _chk140;
  create temp table _chk140 (ord int, item text, result text, detail text);

  insert into _chk140
  select 1, '資料表 ' || t, case when to_regclass('public.' || t) is not null
                                 then '✅' else '❌' end, ''
  from unnest(array['purchase_demands', 'purchase_demand_items']) t;

  insert into _chk140 values (1, 'notification_prefs.purchasing',
    case when exists (select 1 from information_schema.columns
                       where table_schema = 'public' and table_name = 'notification_prefs'
                         and column_name = 'purchasing') then '✅' else '❌' end,
    '第五種通知');

  insert into _chk140
  select 1, '觸發器 ' || t, case when exists (
      select 1 from pg_trigger where tgname = t and not tgisinternal)
    then '✅' else '❌' end, ''
  from unnest(array['trg_demand_no', 'trg_pdi_rollup', 'trg_pdi_lock',
                    'trg_pr_reject_demands']) t;

  /*
   * 實測一遍。**不測的話「狀態會不會跟著項目走」只能用讀的**，
   * 而那正是這支最容易寫錯的地方。
   */
  select id into v_user from public.profiles limit 1;
  select id into v_estate from public.estates limit 1;

  if v_user is null or v_estate is null then
    insert into _chk140 values (9, '★ 實測', '⚠ 跳過', '沒有 profiles 或 estates 可用');
  else
    insert into public.purchase_demands (requester_id, note)
    values (v_user, '_自檢') returning id into d1;

    select demand_no into s from public.purchase_demands where id = d1;
    insert into _chk140 values (5, '★ 單號自動產生', coalesce(s, '❌ null'),
      '格式 DM-YYYYMM-NNN,流水號按月重來');

    insert into public.purchase_demand_items (demand_id, item_name, qty, estate_id)
    values (d1, '_自檢A', 2, v_estate) returning id into i1;
    insert into public.purchase_demand_items (demand_id, item_name, qty, estate_id)
    values (d1, '_自檢B', 3, v_estate) returning id into i2;

    select status into s from public.purchase_demands where id = d1;
    insert into _chk140 values (6, '★★ 兩項都待處理 → 單是 open',
      case when s = 'open' then '✅' else '❌ ' || s end, '');

    update public.purchase_demand_items set status = 'requested' where id = i1;
    select status into s from public.purchase_demands where id = d1;
    insert into _chk140 values (6, '★★ 一項請款 → 單是 partial',
      case when s = 'partial' then '✅' else '❌ ' || s end,
      '狀態由項目推導 —— 這條錯了整張單的進度就是假的');

    update public.purchase_demand_items set status = 'requested' where id = i2;
    select status into s from public.purchase_demands where id = d1;
    insert into _chk140 values (6, '★★ 全部請款 → 單是 done',
      case when s = 'done' then '✅' else '❌ ' || s end, '');

    -- 已請款的不能改內容
    begin
      update public.purchase_demand_items
         set request_item_id = i1, qty = 99 where id = i1;
      insert into _chk140 values (7, '★★ 已請款的項目擋修改', '❌ 沒擋住',
        '改了會跟請款單對不上,而那不會報錯');
    exception when others then
      insert into _chk140 values (7, '★★ 已請款的項目擋修改', '✅ 擋住了',
        '只擋內容,status 與 request_item_id 照樣改得動');
    end;

    delete from public.purchase_demands where id = d1;
    select count(*) into n from public.purchase_demand_items where demand_id = d1;
    insert into _chk140 values (8, '★ 刪單連帶刪項目',
      case when n = 0 then '✅' else '❌ 還剩 ' || n end, 'on delete cascade');
  end if;

  insert into _chk140
  select 10, '　policy：' || polname,
         case polcmd when 'r' then 'SELECT' when '*' then 'ALL' else polcmd::text end,
         left(pg_get_expr(polqual, polrelid), 80)
    from pg_policy
   where polrelid in ('public.purchase_demands'::regclass,
                      'public.purchase_demand_items'::regclass)
   order by polname;

  insert into _chk140 values (12, '★ 下一步', '前端尚未實作',
    '房務管理的採購需求分頁、請款頁的待辦區塊、第五種通知的設定開關');
end $$;

select item as "檢查項目", result as "結果", detail as "說明"
from _chk140 order by ord, item;
