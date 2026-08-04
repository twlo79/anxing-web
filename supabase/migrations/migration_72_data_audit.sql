-- migration_72：編輯紀錄（誰改了什麼）
--
-- 【為什麼需要】
-- 2026-08-04 有人問「支出之前比較多筆，是不是被刪了」，而我們查不出來。
-- migration 全掃過、baseline 也排除了，最後只能說「可能有人從畫面刪的，
-- 但沒有紀錄」。錢的紀錄沒有刪除軌跡，這件事本身就是問題。
--
-- 【記什麼】
--   刪除 / 新增  → 整列存下來（刪掉之後資料就沒了，整列才還原得回來）
--   修改        → 只存變動的欄位，格式 {"amount": [1200, 1500]}
--                 存整列會讓表爆掉，而且要人自己比對哪裡不同
--
-- 【記哪些表】
--   expenses / purchase_requests / purchase_request_items   錢真的花出去的那條線
--   deposits                                                代收代付的錢
--   orders / contracts                                      營收的源頭
--
-- 【自動匯入的雜訊怎麼處理】
-- Airbnb 訂單每天自動同步幾百筆，房務排班每月匯入一次 —— 那些都不是
-- 「使用者登入後做的事」，全記下來只會把真正該看的東西淹掉。
--
-- 判斷方式：auth.uid() 是 null 就代表不是人在操作（服務金鑰、排程、觸發器）。
--   UPDATE  auth.uid() 是 null → 不記
--   DELETE  一律記，不管是誰
--           刪除很罕見而且永遠重要。自動化程序刪東西更該留下痕跡。
--
-- 另外跳過契約重產月租單造成的連帶增刪 —— 那是系統在算，不是人在決定。

create table if not exists public.data_audit (
  id          bigserial primary key,
  at          timestamptz not null default now(),
  user_id     uuid,                     -- null = 系統/排程（見上方說明）
  table_name  text not null,
  record_id   uuid,
  label       text,                     -- 人看得懂的識別，免得還要回頭 join
  action      text not null check (action in ('insert', 'update', 'delete')),
  changes     jsonb not null default '{}'::jsonb
);

comment on table public.data_audit is
  '編輯紀錄。刪除與新增存整列,修改只存變動欄位。'
  'user_id 為 null 代表不是使用者操作(自動匯入、排程、觸發器連帶)。';

create index if not exists idx_data_audit_at     on public.data_audit (at desc);
create index if not exists idx_data_audit_table  on public.data_audit (table_name, at desc);
create index if not exists idx_data_audit_record on public.data_audit (record_id);
create index if not exists idx_data_audit_user   on public.data_audit (user_id, at desc);

alter table public.data_audit enable row level security;

-- 只有總經理看得到。編輯紀錄會露出金額與人名，開太廣反而造成尷尬。
drop policy if exists data_audit_read on public.data_audit;
create policy data_audit_read on public.data_audit
  for select using (current_role_of() = 'super_admin');

-- 沒有 insert/update/delete policy —— 寫入只走 SECURITY DEFINER 的觸發器。
-- 稽核紀錄本身不該被任何人從前端改掉，那樣就失去意義了。


-- ── 觸發器 ─────────────────────────────────────────
create or replace function public.data_audit_log() returns trigger
language plpgsql security definer set search_path = public as $fn$
declare
  uid     uuid := auth.uid();
  diff    jsonb := '{}'::jsonb;
  k       text;
  old_j   jsonb;
  new_j   jsonb;
  lbl     text;
  rec     record;
begin
  rec := coalesce(new, old);

  -- 人看得懂的識別。每張表挑最能一眼認出是哪一筆的欄位。
  lbl := case tg_table_name
    when 'expenses'              then to_jsonb(rec)->>'item_name'
    when 'purchase_requests'     then to_jsonb(rec)->>'req_no'
    when 'purchase_request_items' then to_jsonb(rec)->>'item_name'
    when 'deposits'              then coalesce(to_jsonb(rec)->>'guest_name', to_jsonb(rec)->>'room')
    when 'orders'                then coalesce(to_jsonb(rec)->>'guest_name', to_jsonb(rec)->>'order_key')
    when 'contracts'             then coalesce(to_jsonb(rec)->>'name', to_jsonb(rec)->>'tenant_name')
    else null end;

  -- 金額附在識別後面，列表上不用點開就看得出輕重
  if (to_jsonb(rec) ? 'amount') then
    lbl := coalesce(lbl, '') || ' $' || coalesce((to_jsonb(rec)->>'amount'), '0');
  end if;

  if tg_op = 'DELETE' then
    -- 契約重產月租單時會先把未收的那幾期刪掉再重建，一次可能 24 筆。
    -- 那是系統在算，不是人在決定要刪什麼，記下來只會把真正的刪除淹掉。
    --
    -- 代價：有人手動刪掉一筆未收的月租單也會被跳過。
    -- 可以接受 —— 那筆的來源契約還在，重整就會長回來，不是不可逆的損失。
    if tg_table_name = 'orders'
       and (to_jsonb(old)->>'imported_via') = 'contract'
       and (to_jsonb(old)->>'paid') = 'false' then
      return old;
    end if;

    -- 其餘的刪除一律記，不管是不是人操作的。
    -- 自動化程序刪東西更需要留下痕跡 —— 那種最難事後追。
    insert into data_audit (user_id, table_name, record_id, label, action, changes)
    values (uid, tg_table_name, old.id, lbl, 'delete', to_jsonb(old));
    return old;
  end if;

  -- 以下是 INSERT / UPDATE：不是人操作的就不記。
  -- Airbnb 每天同步幾百筆訂單，那些不是「使用者登入後的行為」，
  -- 全記下來只會把真正要看的東西淹掉。
  if uid is null then return new; end if;

  if tg_op = 'INSERT' then
    insert into data_audit (user_id, table_name, record_id, label, action, changes)
    values (uid, tg_table_name, new.id, lbl, 'insert', to_jsonb(new));
    return new;
  end if;

  -- UPDATE：只挑真的變了的欄位
  old_j := to_jsonb(old);
  new_j := to_jsonb(new);
  for k in select jsonb_object_keys(new_j) loop
    if old_j -> k is distinct from new_j -> k then
      diff := diff || jsonb_build_object(k, jsonb_build_array(old_j -> k, new_j -> k));
    end if;
  end loop;

  -- 沒有實際變動就不寫。前端的樂觀更新常送出一模一樣的值，
  -- 不擋的話這張表會被無意義的列塞滿。
  if diff = '{}'::jsonb then return new; end if;

  insert into data_audit (user_id, table_name, record_id, label, action, changes)
  values (uid, tg_table_name, new.id, lbl, 'update', diff);
  return new;
end $fn$;


-- ── 掛上去 ─────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array[
    'expenses', 'purchase_requests', 'purchase_request_items',
    'deposits', 'orders', 'contracts'
  ]
  loop
    execute format('drop trigger if exists trg_data_audit_%1$s on public.%1$I', t);
    execute format(
      'create trigger trg_data_audit_%1$s after insert or update or delete on public.%1$I
         for each row execute function public.data_audit_log()', t);
    raise notice '已掛上 %', t;
  end loop;
end $$;


-- ============================================================
-- 驗證 —— 實際寫一次再回滾
--
-- 只 select 驗證不到觸發器跑不跑得動（migration_65 就是這樣漏掉的）。
-- ============================================================
do $$
declare
  max0 bigint; n0 int; n1 int; eid uuid; c jsonb;
  is_user boolean := auth.uid() is not null;
begin
  select coalesce(max(id), 0), count(*) into max0, n0 from data_audit;

  if not is_user then
    raise notice '注意:在 SQL Editor 執行時 auth.uid() 是 null,';
    raise notice '依設計「新增與修改」不會被記錄,只驗刪除那條路徑。';
    raise notice '新增/修改要從網站上實際操作一次才驗得到。';
  end if;

  -- 建一筆假支出
  insert into expenses (spent_on, item_name, amount, purpose_type)
  values (current_date, '__稽核測試__', 999, 'office')
  returning id into eid;

  if is_user then
    select count(*) into n1 from data_audit;
    if n1 <> n0 + 1 then
      raise exception 'INSERT 沒有被記錄（before=% after=%）', n0, n1;
    end if;

    -- 改金額 → 只該記 amount 這一個欄位
    update expenses set amount = 1234 where id = eid;
    select changes into c from data_audit order by id desc limit 1;
    if not (c ? 'amount') then
      raise exception 'UPDATE 沒記到 amount,實際記了:%', c;
    end if;
    if (c ? 'item_name') then
      raise exception 'UPDATE 記到了沒變的欄位,diff 判斷有問題:%', c;
    end if;
  end if;

  -- 刪掉 → 整列要存下來。這條路徑不分是不是使用者,一定要過。
  delete from expenses where id = eid;
  select changes into c from data_audit order by id desc limit 1;
  if c is null or (c->>'item_name') is distinct from '__稽核測試__' then
    raise exception 'DELETE 沒有存下整列,實際:%', c;
  end if;

  raise notice '觸發器正常%', case when is_user then ':新增/修改/刪除都記到了' else '（刪除路徑已驗證）' end;

  -- 清掉測試產生的紀錄。用 id 不是 count —— 兩者不是同一個東西。
  delete from data_audit where id > max0;
end $$;

select count(*) as 目前紀錄數 from public.data_audit;


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    raise notice '%', (select public.record_migration('72_data_audit'));
  else
    raise notice '尚未建立 schema_migrations（migration_70），這支沒有被記錄';
  end if;
end $$;
