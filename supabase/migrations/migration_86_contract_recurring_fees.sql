-- migration_86：契約的固定加費
--
-- ============================================================
-- 【要解決什麼】
--
-- 管理費、停車費、冰箱租金這類費用每一期都會發生。現在只能在收租視窗
-- 一期一期手動按「+ 加費」—— 年繳的契約要按 4 次，月繳的要按 24 次，
-- 而且漏掉某一期不會有任何跡象。
--
-- 設定一次，每一期自動長出來。
--
--
-- ============================================================
-- 【停用的規則 —— 這是整支最重要的部分】
--
-- 房客把冰箱退掉了，之後不該再收。規則只有一條：
--
--     還沒收款的  →  自動刪掉（連同它的營收認列）
--     已經收款的  →  原封不動留著
--
-- 已收款的**不退費、不沖銷**。錢已經收了就是收了，
-- 下一期起不再產生就好 —— 這是使用者明確要的處理方式。
--
-- 操作上是「設結束期別」，不是把設定刪掉：
--
--     結束期別 = 2026-07  →  2026-08 起不再產生，未收的自動消失
--
-- 為什麼不讓人一期一期去刪：租期還有 20 期就要刪 20 次，
-- 很容易刪到已收款的那幾期，而且**刪完設定還在，下次重整又長回來**。
--
--
-- ============================================================
-- 【營收怎麼跟著消失】
--
-- 不用寫任何程式。revenue_recognitions.order_id 是 on delete cascade，
-- 費用單被刪掉的那一刻，它的營收認列跟著消失。
--
--
-- ============================================================
-- 【為什麼不沿用 recurring_charges】
--
-- 那張表是「物業／房源」層級的（洗衣機、垃圾代收費），沒有 contract_id，
-- 產生的費用單也不掛契約。契約加費要跟著契約走：
--
--     契約刪掉    → 加費設定與費用單一起消失（on delete cascade）
--     租期縮短    → 超出租期、未收款的自動清掉
--     收租視窗    → 要能按期別把它列出來
--
-- 硬塞進同一張表要加一堆「這欄只有契約用得到」的欄位，
-- 而且兩種產生規則（跟著月份 vs 跟著租期）會纏在同一個函式裡。


-- ============================================================
-- 1. 設定表
-- ============================================================

create table if not exists public.contract_recurring_charges (
  id          uuid primary key default gen_random_uuid(),
  contract_id uuid not null references public.contracts(id) on delete cascade,
  -- 會計科目（管理費／停車費／設備費…）。營收報表按這個分組。
  fee_type    text not null,
  -- 項目。設備費底下才需要分冰箱／洗烘衣機／電視,管理費這種留 null。
  item_name   text,
  amount      numeric not null default 0,
  start_ym    text not null check (start_ym ~ '^[0-9]{6}$'),
  -- null = 跟著租期到底
  end_ym      text check (end_ym ~ '^[0-9]{6}$'),
  active      boolean not null default true,
  note        text,
  created_at  timestamptz not null default now(),
  check (end_ym is null or end_ym >= start_ym)
);

create index if not exists crc_contract_idx on public.contract_recurring_charges (contract_id);

comment on table public.contract_recurring_charges is
  '契約的固定加費（管理費、停車費、設備費…）。每一期自動產生一筆 oneoff 費用單。'
  '要停止收費請設 end_ym,不要刪設定 —— 刪設定會連同已收款的費用單一起消失。';

alter table public.contract_recurring_charges enable row level security;
drop policy if exists crc_read  on public.contract_recurring_charges;
drop policy if exists crc_write on public.contract_recurring_charges;
create policy crc_read on public.contract_recurring_charges for select
  using (current_role_of() in ('accountant', 'manager', 'super_admin'));
create policy crc_write on public.contract_recurring_charges for all
  using (current_role_of() in ('accountant', 'manager', 'super_admin'))
  with check (current_role_of() in ('accountant', 'manager', 'super_admin'));


-- ============================================================
-- 2. 產生費用單
--
-- 鍵是 CRC_{設定id}_{年月}，一個設定一個月最多一列。
-- imported_via = 'contract_fee' —— 跟手動加費（'manual'）分得開，
-- 手動加的那幾筆不該被這個函式清掉。
-- ============================================================

create or replace function public.gen_contract_fee_orders(rc public.contract_recurring_charges)
returns integer
language plpgsql security definer set search_path = public as $fn$
declare
  ct public.contracts;
  ms date; last_ms date; ymtxt text; n int := 0;
begin
  select * into ct from contracts where id = rc.contract_id;
  if not found or ct.start_date is null or ct.end_date is null then
    -- 契約不存在或沒有租期 —— 未收款的先清掉，免得留下沒有母體的費用單
    delete from orders
     where imported_via = 'contract_fee'
       and left(order_key, length('CRC_' || rc.id || '_')) = 'CRC_' || rc.id || '_' and paid = false;
    return 0;
  end if;

  /*
   * 【為什麼不用 LIKE】
   * LIKE 的 `_` 是萬用字元，而鍵前綴 'CRC_' 本身就有底線。
   * 這個專案為此吃過虧 —— lib/ltKey.ts 的註解記著曾經因此把
   * 2F-1/2F-2/2F-3 的收款記錄整批清空。一律用 left() 比對。
   */

  -- 停用：未收款的清掉，已收款的留著。**這一條就是「冰箱退掉了」的處理。**
  if not rc.active then
    delete from orders
     where imported_via = 'contract_fee'
       and left(order_key, length('CRC_' || rc.id || '_')) = 'CRC_' || rc.id || '_' and paid = false;
    return 0;
  end if;

  -- 產生範圍 = 設定的起訖 ∩ 契約的租期。
  -- 夾在租期內是必要的:租期縮短之後,超出的期別不該還在收管理費。
  ms := greatest(to_date(rc.start_ym || '01', 'YYYYMMDD'),
                 date_trunc('month', ct.start_date)::date);
  last_ms := date_trunc('month', ct.end_date - 1)::date;
  if rc.end_ym is not null then
    last_ms := least(last_ms, to_date(rc.end_ym || '01', 'YYYYMMDD'));
  end if;

  -- 超出範圍、未收款的清掉（改了起訖期別或縮短租期會用到）。
  -- paid = false 是這整支的核心約束 —— 收過的錢不因為設定改了而消失。
  delete from orders
   where imported_via = 'contract_fee'
     and left(order_key, length('CRC_' || rc.id || '_')) = 'CRC_' || rc.id || '_'
     and paid = false
     and (checkin < ms or checkin > last_ms);

  while ms <= last_ms loop
    ymtxt := to_char(ms, 'YYYYMM');
    insert into orders (order_key, source, estate_id, property_raw, guest_name,
      checkin, checkout, nights, amount, deposit, fee_type, item_name, note,
      imported_via, contract_id, paid)
    values ('CRC_' || rc.id || '_' || ymtxt, 'oneoff', ct.estate_id, ct.room, ct.tenant_name,
      ms, ms, 0, rc.amount, 0, rc.fee_type, rc.item_name, coalesce(rc.note, '契約固定加費'),
      'contract_fee', ct.id, false)
    on conflict (order_key) do update
      set fee_type = excluded.fee_type,
          item_name = excluded.item_name,
          estate_id = excluded.estate_id,
          property_raw = excluded.property_raw,
          guest_name = excluded.guest_name,
          -- 金額只改未收款的 —— 錢收了之後金額是既成事實。
          -- 這跟 gen_contract_orders 對月租單的處理一致。
          amount = case when orders.paid then orders.amount else excluded.amount end
      where orders.imported_via = 'contract_fee';
    n := n + 1;
    ms := (ms + interval '1 month')::date;
  end loop;

  return n;
end $fn$;


-- ============================================================
-- 3. 觸發器
--
-- 設定變動 → 重產自己
-- 契約變動 → 重產它底下所有的加費設定（租期改了要跟著夾）
-- ============================================================

create or replace function public.trg_crc_sync() returns trigger
language plpgsql security definer set search_path = public as $fn$
begin
  if tg_op = 'DELETE' then
    -- 刪設定：未收款的費用單跟著清掉。已收款的留下來 ——
    -- 前端刪除前會把「有幾筆已收款」講出來，這裡不再擋。
    delete from orders
     where imported_via = 'contract_fee'
       and left(order_key, length('CRC_' || old.id || '_')) = 'CRC_' || old.id || '_' and paid = false;
    return old;
  end if;
  perform public.gen_contract_fee_orders(new);
  return new;
end $fn$;

drop trigger if exists trg_crc_sync on public.contract_recurring_charges;
create trigger trg_crc_sync
  after insert or update or delete on public.contract_recurring_charges
  for each row execute function public.trg_crc_sync();


create or replace function public.regen_contract_fees(p_contract uuid)
returns integer
language plpgsql security definer set search_path = public as $fn$
declare r public.contract_recurring_charges; n int := 0;
begin
  for r in select * from contract_recurring_charges where contract_id = p_contract loop
    perform public.gen_contract_fee_orders(r);
    n := n + 1;
  end loop;
  return n;
end $fn$;

-- 契約的租期或房號改了 → 加費要跟著重夾。
-- 只在真的相關的欄位變動時跑，避免每次存檔都全部重產。
create or replace function public.trg_contract_refees() returns trigger
language plpgsql security definer set search_path = public as $fn$
begin
  perform public.regen_contract_fees(new.id);
  return new;
end $fn$;

drop trigger if exists trg_contracts_refees on public.contracts;
create trigger trg_contracts_refees
  after update of start_date, end_date, room, estate_id, tenant_name, active
  on public.contracts
  for each row
  when (old.start_date is distinct from new.start_date
     or old.end_date   is distinct from new.end_date
     or old.room       is distinct from new.room
     or old.estate_id  is distinct from new.estate_id
     or old.tenant_name is distinct from new.tenant_name)
  execute function public.trg_contract_refees();


-- ============================================================
-- 驗證
--
-- 包在 exception 裡：驗證失敗只發警告，不要把上面的 schema 變更
-- 整包回滾掉（migration_76 就是那樣一夜白做）。
-- ============================================================

do $$
declare n int; c text;
begin
  select count(*) into n from information_schema.tables
   where table_schema = 'public' and table_name = 'contract_recurring_charges';
  if n = 1 then raise notice '✅ contract_recurring_charges 已建立';
  else raise warning '❌ 表不存在'; return; end if;

  -- 契約刪了,加費設定要跟著走（migration_81 的立場:不要留看不見的資料）
  select count(*) into n from pg_constraint
   where conrelid = 'public.contract_recurring_charges'::regclass
     and confrelid = 'public.contracts'::regclass and confdeltype = 'c';
  if n = 1 then raise notice '✅ 契約→加費設定 是 on delete cascade';
  else raise warning '❌ 外鍵不是 cascade'; end if;

  -- 產生函式裡「只刪未收款」的保護還在嗎 —— 這是整支最重要的一條
  c := pg_get_functiondef('public.gen_contract_fee_orders(public.contract_recurring_charges)'::regprocedure);
  if position('paid = false' in c) > 0 then
    raise notice '✅ 清理只針對未收款的費用單';
  else raise warning '❌ 保護不見了!停用設定會刪到已收款的費用單'; end if;

  -- 手動加費不能被這個函式碰到
  if position('contract_fee' in c) > 0 then
    raise notice '✅ 只處理 imported_via=contract_fee,手動加費不受影響';
  else raise warning '❌ 沒有用 imported_via 區隔,可能刪到手動加費'; end if;

  -- 契約改租期會連動
  select count(*) into n from pg_trigger where tgname = 'trg_contracts_refees';
  if n = 1 then raise notice '✅ 契約改租期會連動重夾加費';
  else raise warning '❌ 契約連動觸發器不存在'; end if;

  -- 認列的 cascade（第 5 點靠這個,不是靠程式）
  select count(*) into n from pg_constraint
   where conrelid = 'public.revenue_recognitions'::regclass
     and confrelid = 'public.orders'::regclass and confdeltype = 'c';
  if n = 1 then raise notice '✅ 費用單刪除時營收認列會自動消失';
  else raise warning '❌ revenue_recognitions 不是 cascade,刪費用單不會清營收'; end if;

exception when others then
  raise warning '驗證區出錯（schema 變更不受影響）:%', sqlerrm;
end $$;


-- ── 現況（目前應該是 0 筆）───────────────────────────

select coalesce(c.display_name, c.tenant_name) as 契約,
       rc.fee_type as 科目, rc.item_name as 項目, rc.amount as 金額,
       rc.start_ym as 起, coalesce(rc.end_ym, '—') as 迄, rc.active as 啟用,
       (select count(*) from public.orders o
         where o.imported_via = 'contract_fee'
           and o.left(order_key, length('CRC_' || rc.id || '_')) = 'CRC_' || rc.id || '_')            as 已產生,
       (select count(*) from public.orders o
         where o.imported_via = 'contract_fee'
           and o.left(order_key, length('CRC_' || rc.id || '_')) = 'CRC_' || rc.id || '_' and o.paid)  as 已收款
from public.contract_recurring_charges rc
join public.contracts c on c.id = rc.contract_id
order by 1, 2, 3;


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    raise notice '%', (select public.record_migration('86_contract_recurring_fees'));
  else
    raise notice '尚未建立 schema_migrations（migration_70），這支沒有被記錄';
  end if;
end $$;
