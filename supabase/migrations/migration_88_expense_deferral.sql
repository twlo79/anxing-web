-- migration_88：支出的遞延認列（母子單）
--
-- ============================================================
-- 【要解決什麼】
--
-- 8/8 付了半年的房租 10,000，但那筆錢應該分兩期認列，
-- 不該讓 8 月的費用暴增然後之後幾個月都是 0。
--
--
-- ============================================================
-- 【為什麼母單的 amount 會變小 —— 這是整支最關鍵的一件事】
--
-- 系統裡**沒有支出認列表**。營收有 revenue_recognitions，支出沒有：
-- 財務儀表板、Excel、月報全部都是直接
--
--     sum(expenses.amount) group by spent_on
--
-- 所以如果母單留著 10,000、又生出 5,000 + 5,000 的子單，
-- 儀表板會算出 8月 10,000 ＋ 9月 5,000 ＋ 10月 5,000 = 20,000。
-- **這筆房租變成兩倍，而且不會報錯。**
--
-- 所以 amount 的語意從「付了多少」收斂為「這一天認列多少」：
--
--     母單.amount       = 實付總額 − 所有子單合計
--     母單.gross_amount = 實付總額（對發票、對銀行用）
--
-- sum(amount) 因此恆等於實付總額 —— **既有報表一行都不用改**。
-- 代價是母單的 amount 可能是 0，畫面上必須把 gross_amount 顯示出來，
-- 否則會計拿 10,000 的發票會搜不到任何一列。
--
--
-- ============================================================
-- 【資料庫負責守住的那條等式】
--
--     母單.amount + 所有子單.amount = 母單.gross_amount
--
-- 這條用觸發器強制，不是靠前端自律。前端也會擋，但前端擋不住
-- API、匯入、或下一個寫程式的人 —— 而這條一旦破掉，
-- 某個月的費用就會靜靜地多出或少掉一筆，沒有任何跡象。
--
--
-- ============================================================
-- 【出款日不再連動改支出日期】
--
-- migration_83 的 gen_expenses_from_pr 有一段「只改日期：同步既有支出」。
-- 業務規則是**出款日填了就不能改**（前端會鎖住），所以那段沒有存在意義，
-- 留著只會在未來某天被觸發，把母單的日期改掉而子單留在原地 ——
-- 母子單就散了。這一支把它拿掉。


-- ============================================================
-- 1. 欄位
-- ============================================================

alter table public.expenses
  -- 子單指回母單。母單自己是 null。
  add column if not exists parent_expense_id uuid references public.expenses(id) on delete cascade,
  -- 實付總額。只有母單有值 —— 子單的錢是從母單拆出來的，沒有自己的付款事實。
  add column if not exists gross_amount numeric,
  add column if not exists deferred boolean not null default false;

create index if not exists exp_parent_idx on public.expenses (parent_expense_id);

comment on column public.expenses.parent_expense_id is
  '遞延認列的子單指回母單。母單為 null。on delete cascade —— 母單刪了子單沒有意義。';
comment on column public.expenses.gross_amount is
  '實付總額。只有遞延的母單有值。amount 是「這一天認列多少」,不是「付了多少」。';
comment on column public.expenses.deferred is
  '這是遞延認列的母單。子單不標記 —— 子單靠 parent_expense_id 辨認。';

/*
 * 一筆支出只能是三種身分之一。列舉出來而不是寫「或」的鬆條件,是因為:
 *
 *   deferred = true 但 gross_amount 是 null  → 等式守衛會直接跳過不驗,
 *                                              母子金額對不上也沒人發現
 *   子單又標成 deferred                       → 變成兩層,等式要遞迴驗,
 *                                              而遞迴驗證寫錯不會報錯
 */
alter table public.expenses drop constraint if exists exp_deferral_chk;
alter table public.expenses add constraint exp_deferral_chk check (
     (parent_expense_id is null     and deferred = false and gross_amount is null)      -- 一般支出
  or (parent_expense_id is null     and deferred = true  and gross_amount is not null)  -- 遞延母單
  or (parent_expense_id is not null and deferred = false and gross_amount is null)      -- 子單
);


-- ============================================================
-- 2. 守住那條等式
--
-- 母單.amount + 所有子單.amount = 母單.gross_amount
--
-- 用 constraint trigger（deferrable initially deferred）——
-- 一般觸發器會在「插入第一張子單」的當下就爆掉，
-- 因為那時候還沒插到第二張，合計當然不等。延到交易結束才驗才是對的。
-- ============================================================

create or replace function public.check_expense_deferral() returns trigger
language plpgsql security definer set search_path = public as $fn$
declare
  pid uuid;
  gross numeric; own numeric; kids numeric;
begin
  -- 找出這次動到的是哪一張母單
  pid := coalesce(
    case when tg_op = 'DELETE' then old.parent_expense_id else new.parent_expense_id end,
    case when tg_op = 'DELETE' then old.id else new.id end);

  select e.gross_amount, e.amount into gross, own
  from expenses e where e.id = pid and e.deferred;

  -- 不是遞延母單就沒有等式要守
  if gross is null then return null; end if;

  select coalesce(sum(amount), 0) into kids
  from expenses where parent_expense_id = pid;

  if round(own + kids) <> round(gross) then
    raise exception
      '遞延認列的金額對不上:母單 % + 子單 % = %,實付總額是 %。'
      '（母單的 amount 是「這一天認列多少」,不是「付了多少」）',
      round(own), round(kids), round(own + kids), round(gross);
  end if;
  return null;
end $fn$;

drop trigger if exists trg_expense_deferral_sum on public.expenses;
create constraint trigger trg_expense_deferral_sum
  after insert or update or delete on public.expenses
  deferrable initially deferred
  for each row execute function public.check_expense_deferral();


-- ============================================================
-- 3. 子單繼承母單的欄位
--
-- 科目、用途、物業、房源、憑證、付款方式…… 全部跟母單一樣。
-- 讓前端一個一個複製的話，總有一天會漏掉新加的欄位，
-- 而漏掉的那一欄不會報錯，只會讓那幾筆子單在報表裡歸錯類。
-- ============================================================

create or replace function public.sync_expense_child() returns trigger
language plpgsql security definer set search_path = public as $fn$
declare p public.expenses;
begin
  if new.parent_expense_id is null then return new; end if;
  select * into p from expenses where id = new.parent_expense_id;
  if not found then return new; end if;

  -- 只繼承「描述這筆錢是什麼」的欄位。
  -- **日期與金額不繼承** —— 那正是子單存在的理由。
  new.item_name      := p.item_name;
  new.account_code   := p.account_code;
  new.purpose_type   := p.purpose_type;
  new.estate_id      := p.estate_id;
  new.property_id    := p.property_id;
  new.voucher_no     := p.voucher_no;
  new.no_voucher     := p.no_voucher;
  new.payment_method := p.payment_method;
  new.pay_account    := p.pay_account;
  new.currency       := p.currency;
  new.fx_rate        := p.fx_rate;
  new.request_id     := p.request_id;
  new.created_by     := coalesce(new.created_by, p.created_by);
  -- source_item_id 不繼承：那一欄是 unique 的（一個請款項目一筆支出）,
  -- 複製過來會直接違反約束。子單靠 parent_expense_id 回溯到請款單。
  new.source_item_id := null;
  new.deferred       := false;
  new.gross_amount   := null;
  return new;
end $fn$;

drop trigger if exists trg_expense_child_sync on public.expenses;
create trigger trg_expense_child_sync
  before insert or update on public.expenses
  for each row execute function public.sync_expense_child();


-- ============================================================
-- 4. 母單的描述欄位改了 → 子單跟著改
-- ============================================================

create or replace function public.propagate_expense_parent() returns trigger
language plpgsql security definer set search_path = public as $fn$
begin
  update expenses c set
    item_name = new.item_name, account_code = new.account_code,
    purpose_type = new.purpose_type, estate_id = new.estate_id, property_id = new.property_id,
    voucher_no = new.voucher_no, no_voucher = new.no_voucher,
    payment_method = new.payment_method, pay_account = new.pay_account,
    currency = new.currency, fx_rate = new.fx_rate, request_id = new.request_id
  where c.parent_expense_id = new.id;
  return null;
end $fn$;

drop trigger if exists trg_expense_propagate on public.expenses;
create trigger trg_expense_propagate
  after update on public.expenses
  for each row
  when (old.parent_expense_id is null and (
        old.item_name is distinct from new.item_name
     or old.account_code is distinct from new.account_code
     or old.purpose_type is distinct from new.purpose_type
     or old.estate_id is distinct from new.estate_id
     or old.property_id is distinct from new.property_id
     or old.voucher_no is distinct from new.voucher_no
     or old.no_voucher is distinct from new.no_voucher
     or old.payment_method is distinct from new.payment_method
     or old.pay_account is distinct from new.pay_account))
  execute function public.propagate_expense_parent();


-- ============================================================
-- 5. 拿掉「出款日連動改支出日期」
--
-- 逐字保留 migration_83 的其餘部分,只刪掉那一段 elsif。
-- 業務規則是出款日填了就不能改（前端鎖住）,所以那段不會被用到;
-- 留著的話萬一哪天有人繞過前端改了 purchased_on,
-- 母單日期會被改掉而子單留在原地,母子單就散了。
-- ============================================================

create or replace function public.gen_expenses_from_pr()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if new.status <> 'approved' or new.purchased_on is null then
    return new;
  end if;

  if old.purchased_on is null then
    -- 第一次確認出款 → 產生項目支出
    insert into public.expenses (
      spent_on, item_name, amount, amount_original, currency, fx_rate,
      account_code, purpose_type, estate_id, property_id,
      payment_method, pay_account, voucher_no, no_voucher,
      note, source_item_id, created_by
    )
    select new.purchased_on, i.item_name, i.amount,
           coalesce(i.amount_original, i.amount), new.currency, new.fx_rate,
           i.account_code, i.purpose_type, i.estate_id, i.property_id,
           new.payment_method,
           new.payout_account,          -- 我方付款帳號,之前漏帶,支出頁的付款帳號一直是空的
           -- 一張請款單可能拆成多筆支出，憑證號碼會重複帶。
           -- 這是對的：同一張發票本來就對應多個項目，之後對帳靠這個號碼把它們串回去。
           new.voucher_no, coalesce(new.no_voucher, false),
           i.note, i.id, new.requester_id
      from public.purchase_request_items i
     where i.request_id = new.id
    on conflict (source_item_id) do nothing;

    new.expense_generated_at := now();
  end if;
  -- 【刻意沒有 elsif】出款日填了就不能改（見檔頭第 5 節）。

  -- 手續費：冪等,多呼叫不會出事。
  perform public.sync_pr_fee_expense(new);

  return new;
end $function$;


-- ============================================================
-- 驗證
--
-- 包在 exception 裡：驗證失敗只發警告，不要把上面的 schema 變更
-- 整包回滾掉（migration_76 就是那樣一夜白做）。
-- ============================================================

do $$
declare n int; c text;
begin
  select count(*) into n from information_schema.columns
   where table_schema = 'public' and table_name = 'expenses'
     and column_name in ('parent_expense_id', 'gross_amount', 'deferred');
  if n = 3 then raise notice '✅ expenses 的遞延欄位齊了';
  else raise warning '❌ 遞延欄位只有 % 個', n; return; end if;

  -- 母單刪除要帶走子單
  select count(*) into n from pg_constraint
   where conrelid = 'public.expenses'::regclass
     and confrelid = 'public.expenses'::regclass and confdeltype = 'c';
  if n = 1 then raise notice '✅ 母單→子單 是 on delete cascade';
  else raise warning '❌ 母子外鍵不是 cascade,刪母單會留下孤兒子單'; end if;

  -- 等式的守衛要是 constraint trigger 且延後驗
  select count(*) into n from pg_trigger
   where tgname = 'trg_expense_deferral_sum' and tgdeferrable and tginitdeferred;
  if n = 1 then raise notice '✅ 金額等式由 deferrable 觸發器守著';
  else raise warning '❌ 觸發器不存在或不是 deferrable —— 插第一張子單時就會爆'; end if;

  select pg_get_constraintdef(oid) into c from pg_constraint where conname = 'exp_deferral_chk';
  if c like '%gross_amount IS NOT NULL%' then
    raise notice '✅ 約束擋住「標了遞延卻沒有實付總額」';
  else raise warning '❌ exp_deferral_chk 太鬆,等式守衛會被跳過:%', c; end if;

  select count(*) into n from pg_trigger where tgname = 'trg_expense_child_sync';
  if n = 1 then raise notice '✅ 子單會繼承母單欄位';
  else raise warning '❌ 繼承觸發器不存在'; end if;

  select count(*) into n from pg_trigger where tgname = 'trg_expense_propagate';
  if n = 1 then raise notice '✅ 母單改描述欄位會傳到子單';
  else raise warning '❌ 傳遞觸發器不存在'; end if;

  -- 連動改日期那段真的拿掉了嗎
  c := pg_get_functiondef('public.gen_expenses_from_pr()'::regprocedure);
  if position('set spent_on = new.purchased_on' in c) = 0 then
    raise notice '✅ 出款日不再連動改支出日期';
  else raise warning '❌ 連動改日期那段還在,母子單會被拆散'; end if;

  -- 原本的項目支出邏輯不能被改壞 —— 這是這一支最大的風險
  if position('source_item_id' in c) > 0 and position('voucher_no' in c) > 0
     and position('sync_pr_fee_expense' in c) > 0 then
    raise notice '✅ 項目支出與手續費邏輯都還在';
  else raise warning '❌ gen_expenses_from_pr 被改壞了!'; end if;

  -- 既有資料一筆都不該是遞延
  select count(*) into n from public.expenses where deferred or parent_expense_id is not null;
  if n = 0 then raise notice '✅ 既有支出沒有被動到（0 筆遞延）';
  else raise warning 'ℹ 已經有 % 筆遞延資料', n; end if;

exception when others then
  raise warning '驗證區出錯（schema 變更不受影響）:%', sqlerrm;
end $$;


-- ── 現況 ───────────────────────────────────────────

select count(*) filter (where deferred)                   as 遞延母單,
       count(*) filter (where parent_expense_id is not null) as 子單,
       count(*)                                           as 支出總筆數,
       sum(amount)::bigint                                as 認列總額
from public.expenses;


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    raise notice '%', (select public.record_migration('88_expense_deferral'));
  else
    raise notice '尚未建立 schema_migrations（migration_70），這支沒有被記錄';
  end if;
end $$;
