-- migration_56：押金獨立成一張表
--
-- 原本押金散在兩個地方，各自有一組 received/returned 的 boolean + 日期：
--   orders.deposit + deposit_received(_at) + deposit_returned(_at) + fx_deposit
--   contracts.deposit + 同一組四個欄位
--
-- 問題是「暫收款」這件事要跨兩張表加總才算得出來，而且 boolean 與日期
-- 可能互相矛盾（勾了已收但日期空白，或有日期卻沒勾）。
--
-- 改成：
--   金額留在來源（orders / contracts），那是契約條件的一部分
--   收退的過程搬到 deposits，由觸發器自動建列
--
-- 暫收 = 有 received_on 且沒有 returned_on。
-- 一個日期問題，不再靠兩個 boolean 互相牽制。

create table if not exists public.deposits (
  id uuid primary key default gen_random_uuid(),

  -- 來源。兩個擇一，來源被刪時設為 null 並標記 orphaned。
  order_id    uuid references public.orders(id)    on delete set null,
  contract_id uuid references public.contracts(id) on delete set null,

  -- 來源資訊的快照。來源刪掉之後還看得出這筆押金是誰的、哪一間 ——
  -- 只留 FK 的話，訂單一刪就變成一筆金額不明歸屬的錢。
  estate_id   uuid references public.estates(id),
  property_id uuid references public.properties(id),
  room        text,
  guest_name  text,

  -- 一筆押金一種幣別。外幣押金原幣退還不換匯，所以不做任何換算。
  currency text    not null default 'TWD',
  amount   numeric not null default 0,

  received_on      date,
  received_method  text,   -- cash | transfer | credit_card | crypto
  received_account text,   -- payment_accounts.code
  returned_on      date,
  returned_method  text,
  returned_account text,

  note text,
  -- 來源訂單/契約已被刪除，或押金金額被改成 0，但錢已經收進來了。
  -- 這種列要留著讓人去處理，不能默默消失 —— 帳上會少一筆暫收款。
  orphaned boolean not null default false,

  created_at timestamptz not null default now(),

  constraint dep_one_source check (
    orphaned or num_nonnulls(order_id, contract_id) = 1
  ),
  -- 沒收到錢就不可能退錢
  constraint dep_return_needs_receive check (
    returned_on is null or received_on is not null
  )
);

comment on table public.deposits is
  '押金收退管理。金額來自 orders/contracts（由觸發器同步），收退日期與方式在這裡維護。暫收 = received_on 有值且 returned_on 為 null。';

-- 一個來源 × 一種幣別只有一列
create unique index if not exists dep_order_cur_idx
  on public.deposits (order_id, currency) where order_id is not null;
create unique index if not exists dep_contract_cur_idx
  on public.deposits (contract_id, currency) where contract_id is not null;

create index if not exists dep_received_idx on public.deposits (received_on);
create index if not exists dep_estate_idx   on public.deposits (estate_id);


-- ============================================================
-- 同步：orders → deposits
-- ============================================================
create or replace function public.sync_order_deposits() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  l jsonb;
  keep text[] := '{}';
  c text;
  a numeric;
begin
  -- 台幣押金
  if coalesce(new.deposit, 0) > 0 then
    keep := keep || 'TWD';
    insert into deposits (order_id, currency, amount, estate_id, property_id, room, guest_name)
    values (new.id, 'TWD', new.deposit, new.estate_id, new.property_id, new.property_raw, new.guest_name)
    on conflict (order_id, currency) where order_id is not null
    do update set amount = excluded.amount, estate_id = excluded.estate_id,
                  property_id = excluded.property_id, room = excluded.room,
                  guest_name = excluded.guest_name, orphaned = false;
  end if;

  -- 外幣押金（fx_deposit: [{"cur":"USD","amt":300}, ...]）
  for l in select * from jsonb_array_elements(coalesce(new.fx_deposit, '[]'::jsonb)) loop
    c := nullif(l->>'cur', '');
    a := coalesce((l->>'amt')::numeric, 0);
    if c is not null and a > 0 then
      keep := keep || c;
      insert into deposits (order_id, currency, amount, estate_id, property_id, room, guest_name)
      values (new.id, c, a, new.estate_id, new.property_id, new.property_raw, new.guest_name)
      on conflict (order_id, currency) where order_id is not null
      do update set amount = excluded.amount, estate_id = excluded.estate_id,
                    property_id = excluded.property_id, room = excluded.room,
                    guest_name = excluded.guest_name, orphaned = false;
    end if;
  end loop;

  -- 金額被改成 0 或幣別被移除。還沒收錢的直接清掉；
  -- 已經收了的留著標記 orphaned —— 錢在我們手上，紀錄不能無聲消失。
  delete from deposits
   where order_id = new.id and not (currency = any(keep)) and received_on is null;

  update deposits set orphaned = true
   where order_id = new.id and not (currency = any(keep)) and received_on is not null;

  return new;
end $$;

drop trigger if exists trg_sync_order_deposits on public.orders;
create trigger trg_sync_order_deposits
  after insert or update of deposit, fx_deposit, estate_id, property_id, property_raw, guest_name
  on public.orders
  for each row execute function public.sync_order_deposits();


-- ============================================================
-- 同步：contracts → deposits
-- ============================================================
create or replace function public.sync_contract_deposits() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if coalesce(new.deposit, 0) > 0 then
    insert into deposits (contract_id, currency, amount, estate_id, room, guest_name)
    values (new.id, 'TWD', new.deposit, new.estate_id, new.room, new.tenant_name)
    on conflict (contract_id, currency) where contract_id is not null
    do update set amount = excluded.amount, estate_id = excluded.estate_id,
                  room = excluded.room, guest_name = excluded.guest_name, orphaned = false;
  else
    delete from deposits where contract_id = new.id and received_on is null;
    update deposits set orphaned = true
     where contract_id = new.id and received_on is not null;
  end if;
  return new;
end $$;

drop trigger if exists trg_sync_contract_deposits on public.contracts;
create trigger trg_sync_contract_deposits
  after insert or update of deposit, estate_id, room, tenant_name
  on public.contracts
  for each row execute function public.sync_contract_deposits();


-- ============================================================
-- 來源被刪除
--
-- FK 的 on delete set null 會把 order_id 清掉，但不會標記 orphaned，
-- 結果是一筆沒有來源也沒有標記的孤兒列。所以要在刪除前先處理。
-- ============================================================
create or replace function public.mark_deposits_orphaned() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_table_name = 'orders' then
    delete from deposits where order_id = old.id and received_on is null;
    update deposits set orphaned = true,
           note = concat_ws('・', note, '來源訂單已刪除 ' || to_char(now(), 'YYYY-MM-DD'))
     where order_id = old.id;
  else
    delete from deposits where contract_id = old.id and received_on is null;
    update deposits set orphaned = true,
           note = concat_ws('・', note, '來源契約已刪除 ' || to_char(now(), 'YYYY-MM-DD'))
     where contract_id = old.id;
  end if;
  return old;
end $$;

drop trigger if exists trg_orders_dep_orphan on public.orders;
create trigger trg_orders_dep_orphan before delete on public.orders
  for each row execute function public.mark_deposits_orphaned();

drop trigger if exists trg_contracts_dep_orphan on public.contracts;
create trigger trg_contracts_dep_orphan before delete on public.contracts
  for each row execute function public.mark_deposits_orphaned();


-- ============================================================
-- RLS：會計、主管、總經理。押金是錢的進出，比照支出頁。
-- ============================================================
alter table public.deposits enable row level security;

drop policy if exists dep_read  on public.deposits;
drop policy if exists dep_write on public.deposits;

create policy dep_read on public.deposits for select
  using (current_role_of() in ('accountant','manager','super_admin'));

create policy dep_write on public.deposits for all
  using (current_role_of() in ('accountant','manager','super_admin'))
  with check (current_role_of() in ('accountant','manager','super_admin'));


-- ============================================================
-- 遷移既有資料
--
-- 觸發器只在之後的異動才會跑，現有的押金要手動灌一次。
-- 舊資料沒有「入款方式」，那幾欄留空白等人補。
-- ============================================================
insert into public.deposits (order_id, currency, amount, estate_id, property_id, room, guest_name,
                             received_on, returned_on)
select o.id, 'TWD', o.deposit, o.estate_id, o.property_id, o.property_raw, o.guest_name,
       case when o.deposit_received then coalesce(o.deposit_received_at::date, o.checkin) end,
       case when o.deposit_returned then coalesce(o.deposit_returned_at::date, o.checkout) end
  from public.orders o
 where coalesce(o.deposit, 0) > 0
on conflict do nothing;

insert into public.deposits (order_id, currency, amount, estate_id, property_id, room, guest_name,
                             received_on, returned_on)
select o.id, l->>'cur', (l->>'amt')::numeric, o.estate_id, o.property_id, o.property_raw, o.guest_name,
       case when o.deposit_received then coalesce(o.deposit_received_at::date, o.checkin) end,
       case when o.deposit_returned then coalesce(o.deposit_returned_at::date, o.checkout) end
  from public.orders o, jsonb_array_elements(coalesce(o.fx_deposit, '[]'::jsonb)) l
 where nullif(l->>'cur','') is not null and coalesce((l->>'amt')::numeric, 0) > 0
on conflict do nothing;

insert into public.deposits (contract_id, currency, amount, estate_id, room, guest_name,
                             received_on, returned_on)
select c.id, 'TWD', c.deposit, c.estate_id, c.room, c.tenant_name,
       case when c.deposit_received then coalesce(c.deposit_received_at::date, c.start_date) end,
       case when c.deposit_returned then coalesce(c.deposit_returned_at::date, c.end_date) end
  from public.contracts c
 where coalesce(c.deposit, 0) > 0
on conflict do nothing;


-- ============================================================
-- 舊欄位保留但停止使用。
-- 直接 drop 的話，萬一遷移漏了什麼就救不回來了。
-- 確認押金頁跑順一陣子之後再另開一支 migration 清掉。
-- ============================================================
comment on column public.orders.deposit_received    is '【已淘汰】改用 deposits.received_on。保留供對帳。';
comment on column public.orders.deposit_returned    is '【已淘汰】改用 deposits.returned_on。保留供對帳。';
comment on column public.contracts.deposit_received is '【已淘汰】改用 deposits.received_on。保留供對帳。';
comment on column public.contracts.deposit_returned is '【已淘汰】改用 deposits.returned_on。保留供對帳。';


-- ============================================================
-- 驗證
-- ============================================================
select count(*) as 押金筆數,
       count(*) filter (where received_on is not null and returned_on is null) as 暫收中,
       count(*) filter (where received_on is null) as 尚未收,
       count(*) filter (where orphaned) as 孤兒
from public.deposits;

-- 暫收款總額（依幣別）
select currency, sum(amount) as 暫收金額
from public.deposits
where received_on is not null and returned_on is null
group by currency order by 2 desc;

-- 遷移完整性：來源有押金卻沒建列的（應為 0）
select count(*) as 訂單漏遷_應為0
from public.orders o
where coalesce(o.deposit,0) > 0
  and not exists (select 1 from public.deposits d where d.order_id = o.id and d.currency = 'TWD');

select count(*) as 契約漏遷_應為0
from public.contracts c
where coalesce(c.deposit,0) > 0
  and not exists (select 1 from public.deposits d where d.contract_id = c.id);
