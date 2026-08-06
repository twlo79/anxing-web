-- migration_84：短租訂單的分次收款
--
-- ============================================================
-- 【為什麼不能沿用契約那一套】
--
-- 契約收租是「一期一個勾」—— orders.paid 一個布林，收了就打勾。
-- 月租金額固定、一次收一整期，那樣就夠了。
--
-- 短租不行。一筆訂單常常分兩三次收（訂金 → 尾款），
-- 只有布林的話「收了訂金 3,000」跟「一毛都沒收」在畫面上長得一模一樣，
-- 而這兩件事對催款的人來說完全不同。
--
-- 所以短租走一筆收款一列（order_payments），狀態是算出來的：
--
--     合計 = 0        未收款
--     0 < 合計 < 應收  部分收款
--     合計 >= 應收     已收款
--
--
-- 【為什麼 orders 要多一個 paid_amount】
--
-- 列表一頁 50 筆。每筆都去查 order_payments 就是 50 次往返，
-- 而且沒辦法用「收款狀態」排序或篩選。
--
-- 所以合計由觸發器維護在 orders.paid_amount 上。
-- **它是衍生資料，任何時候都應該等於 sum(order_payments.amount)** ——
-- 底下有驗證查詢可以隨時對帳。
--
-- 狀態本身**不存欄位**。存了就會有「合計改了但狀態沒跟上」那種 bug，
-- 而那種 bug 不會報錯，只會讓收款清單少一筆或多一筆。
--
--
-- 【orders.paid 還是會維護】
--
-- 舊的 paid / paid_at 沒有廢掉，由同一個觸發器跟著更新：
--
--     paid    = 收滿了沒
--     paid_at = 最後一次收款日
--
-- 契約頁、營收報表、Excel 都還在讀 paid，斷掉的話那些地方會全部變成未收款。
--
--
-- 【平台代收的來源不記收款】
-- Airbnb / Agoda 的錢是平台結算給我們的，不是一筆一筆跟客人收的。
-- 這件事**只在前端擋**（見 lib/order-payment.ts 的 EXEMPT_SOURCES），
-- 資料庫不擋 —— 萬一哪天真的要記一筆 Airbnb 的補款，不該被 schema 綁死。


-- ============================================================
-- 1. orders 上的收款合計
-- ============================================================

alter table public.orders
  add column if not exists paid_amount numeric not null default 0;

comment on column public.orders.paid_amount is
  '已收款合計,由 order_payments 的觸發器維護。衍生資料 —— '
  '任何時候都應該等於 sum(order_payments.amount)。不要手動改。';


-- ============================================================
-- 2. 收款紀錄
-- ============================================================

create table if not exists public.order_payments (
  id         uuid primary key default gen_random_uuid(),
  order_id   uuid not null references public.orders(id) on delete cascade,
  paid_on    date not null,
  amount     numeric not null,
  -- payment_accounts.code。for_income = true 的才會出現在畫面的下拉裡。
  account    text references public.payment_accounts(code),
  note       text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  -- 只收正數。要沖銷請刪掉那一列 ——
  -- 允許負數的話「部分收款」會出現一堆互相抵銷的列，對帳時看不出到底收了多少。
  constraint op_amount_chk check (amount > 0)
);

-- on delete cascade：訂單刪了，它的收款紀錄沒有任何意義。
-- 這跟 migration_81 的立場一致 —— 不要留看不見卻還在的資料。
create index if not exists op_order_idx on public.order_payments (order_id);
create index if not exists op_paid_on_idx on public.order_payments (paid_on desc);

comment on table public.order_payments is
  '短租訂單的分次收款。一筆收款一列。orders.paid_amount / paid / paid_at 由觸發器同步。';


-- ============================================================
-- 3. RLS：比照押金 —— 會計、主管、總經理
--
-- 收款是錢的進出，跟押金同一個層級。房務、清潔那些角色看不到。
-- ============================================================

alter table public.order_payments enable row level security;

drop policy if exists op_read  on public.order_payments;
drop policy if exists op_write on public.order_payments;

create policy op_read on public.order_payments for select
  using (current_role_of() in ('accountant', 'manager', 'super_admin'));

create policy op_write on public.order_payments for all
  using (current_role_of() in ('accountant', 'manager', 'super_admin'))
  with check (current_role_of() in ('accountant', 'manager', 'super_admin'));


-- ============================================================
-- 4. 同步 orders 上的三個欄位
--
-- 一律「整筆重算」而不是加減 —— 加減會累積誤差，
-- 而且刪除、修改、批次匯入各要一套邏輯。重算只有一套，永遠對。
-- ============================================================

create or replace function public.sync_order_paid() returns trigger
language plpgsql security definer set search_path = public as $fn$
declare
  oid uuid; tot numeric; last_on date; due numeric;
begin
  oid := coalesce(new.order_id, old.order_id);

  select coalesce(sum(amount), 0), max(paid_on)
    into tot, last_on
  from order_payments where order_id = oid;

  select amount into due from orders where id = oid;

  update orders o set
    paid_amount = tot,
    -- 應收 <= 0（0 元訂單、折讓）沒有錢要收，視為已收款；
    -- 標成未收款會讓它們永遠掛在待收清單上，而實際上沒有人欠任何錢。
    paid    = case when coalesce(due, 0) <= 0 then true else tot >= due end,
    paid_at = last_on
  where o.id = oid;

  return coalesce(new, old);
end $fn$;

drop trigger if exists trg_order_payments_sync on public.order_payments;
create trigger trg_order_payments_sync
  after insert or update or delete on public.order_payments
  for each row execute function public.sync_order_paid();


-- ============================================================
-- 5. 訂單金額改了，狀態要跟著重算
--
-- 收了 3,000、應收從 10,000 改成 3,000 → 那筆就收滿了。
-- 沒有這一段的話畫面會一直停在「部分收款」，而且沒有任何跡象。
--
-- 【為什麼要 when (old.amount is distinct from new.amount)】
-- sync_order_paid() 自己會 update orders。如果這個觸發器對所有 update 都開，
-- 就會變成 orders → sync → orders → sync 的無限遞迴。
-- 綁在「金額真的變了」上，sync 那次 update（只動 paid/paid_amount/paid_at）
-- 不會再觸發它，遞迴自然終止。
-- ============================================================

create or replace function public.resync_order_paid_on_amount() returns trigger
language plpgsql security definer set search_path = public as $fn$
declare tot numeric;
begin
  -- 沒有收款紀錄的訂單完全不碰 —— 契約月租單、Airbnb 訂單都走舊的 paid 邏輯，
  -- 在這裡改到它們會把契約頁的收租狀態洗掉。
  if not exists (select 1 from order_payments where order_id = new.id) then
    return new;
  end if;

  select coalesce(sum(amount), 0) into tot from order_payments where order_id = new.id;

  update orders o set
    paid_amount = tot,
    paid = case when coalesce(new.amount, 0) <= 0 then true else tot >= new.amount end
  where o.id = new.id;

  return new;
end $fn$;

drop trigger if exists trg_orders_resync_paid on public.orders;
create trigger trg_orders_resync_paid
  after update of amount on public.orders
  for each row
  when (old.amount is distinct from new.amount)
  execute function public.resync_order_paid_on_amount();


-- ============================================================
-- 6. 既有資料：已經標成已收款的短租訂單補一列收款紀錄
--
-- 【為什麼要補而不是只填 paid_amount】
--
-- 只填 paid_amount 的話，模型就不一致了：
-- paid_amount 說收了 10,000，order_payments 卻是空的。
-- 之後有人補記一筆 3,000，觸發器整筆重算 → paid_amount 變成 3,000，
-- 原本那 10,000 憑空消失，而且不會報錯。
--
-- 所以補的是真的資料列。日期用 paid_at，沒有就退回 checkin
-- （總比 today() 好 —— 那會把 2023 年的收款寫成今天）。
--
-- 只補短租會用到的來源。契約月租單與 Airbnb/Agoda 不碰：
-- 前者走契約頁的舊邏輯，後者是平台代收，兩邊都不該有收款紀錄。
-- ============================================================

do $$
declare n int; amt bigint;
begin
  select count(*), coalesce(sum(amount), 0)::bigint into n, amt
  from public.orders
  where source in ('private', 'oneoff', 'partner')
    and paid = true and amount > 0
    and not exists (select 1 from public.order_payments p where p.order_id = orders.id);
  raise notice '待補收款紀錄:% 筆,合計 $%', n, amt;

  insert into public.order_payments (order_id, paid_on, amount, account, note)
  select o.id, coalesce(o.paid_at, o.checkin), o.amount, o.account, '舊資料補登（migration_84）'
  from public.orders o
  where o.source in ('private', 'oneoff', 'partner')
    and o.paid = true and o.amount > 0
    and not exists (select 1 from public.order_payments p where p.order_id = o.id);
  get diagnostics n = row_count;
  raise notice '已補 % 列（paid_amount 由觸發器同步）', n;
end $$;


-- ============================================================
-- 驗證
--
-- 包在 exception 裡：驗證失敗只發警告，不要把上面的 schema 變更
-- 整包回滾掉（migration_76 就是那樣一夜白做）。
-- ============================================================

do $$
declare n int;
begin
  select count(*) into n from information_schema.tables
   where table_schema = 'public' and table_name = 'order_payments';
  if n = 1 then raise notice '✅ order_payments 已建立';
  else raise warning '❌ order_payments 不存在'; return; end if;

  select count(*) into n from information_schema.columns
   where table_schema = 'public' and table_name = 'orders' and column_name = 'paid_amount';
  if n = 1 then raise notice '✅ orders.paid_amount 已建立';
  else raise warning '❌ orders.paid_amount 不存在'; end if;

  -- 外鍵要是 cascade：訂單刪了收款紀錄不該留下（migration_81 的教訓）
  select count(*) into n from pg_constraint
   where conrelid = 'public.order_payments'::regclass
     and confrelid = 'public.orders'::regclass and confdeltype = 'c';
  if n = 1 then raise notice '✅ 訂單→收款紀錄 是 on delete cascade';
  else raise warning '❌ 外鍵不是 cascade,刪訂單會留下孤兒收款紀錄'; end if;

  -- 遞迴防護：amount 觸發器必須有 WHEN 條件，否則會無限迴圈
  select count(*) into n from pg_trigger
   where tgname = 'trg_orders_resync_paid' and tgqual is not null;
  if n = 1 then raise notice '✅ 金額觸發器有 WHEN 條件（遞迴防護）';
  else raise warning '❌ 金額觸發器缺 WHEN 條件!可能無限遞迴'; end if;

  -- 合計對不對得起來 —— 這是整支最重要的一條
  select count(*) into n from public.orders o
   where o.paid_amount is distinct from
         coalesce((select sum(p.amount) from public.order_payments p where p.order_id = o.id), 0);
  if n = 0 then raise notice '✅ 所有訂單的 paid_amount 都等於收款明細合計';
  else raise warning '❌ 有 % 筆訂單的 paid_amount 對不上明細', n; end if;

  -- 收滿卻沒標已收款、或反過來
  select count(*) into n from public.orders o
   where exists (select 1 from public.order_payments p where p.order_id = o.id)
     and o.amount > 0
     and o.paid is distinct from (o.paid_amount >= o.amount);
  if n = 0 then raise notice '✅ paid 旗標與金額一致';
  else raise warning '❌ 有 % 筆的 paid 旗標與金額對不上', n; end if;

exception when others then
  raise warning '驗證區出錯（schema 變更不受影響）:%', sqlerrm;
end $$;


-- ── 現況 ───────────────────────────────────────────

select
  case
    when o.source in ('airbnb', 'agoda', 'airbnb_cancelled') then '平台代收'
    when coalesce(o.amount, 0) <= 0        then '已收款（0元或折讓）'
    when coalesce(o.paid_amount, 0) <= 0   then '未收款'
    when o.paid_amount >= o.amount         then '已收款'
    else '部分收款'
  end as 狀態,
  count(*) as 筆數,
  sum(o.amount)::bigint      as 應收,
  sum(o.paid_amount)::bigint as 已收
from public.orders o
where o.source in ('airbnb', 'agoda', 'private', 'oneoff', 'partner', 'airbnb_cancelled')
group by 1 order by 2 desc;


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    raise notice '%', (select public.record_migration('84_order_payments'));
  else
    raise notice '尚未建立 schema_migrations（migration_70），這支沒有被記錄';
  end if;
end $$;
