-- migration_89：關注支出（★）
--
-- ============================================================
-- 【要解決什麼】
--
-- 有些支出要事後追蹤 —— 大額的、有爭議的、要跟廠商對的。
-- 現在只能記在腦子裡或另外開 Excel。
--
-- 打星之後可以在支出頁篩選，也會出現在財務儀表板上。
--
--
-- ============================================================
-- 【母子單一起連動 —— 為什麼寫在資料庫】
--
-- 遞延認列的一筆錢會拆成母單 + N 張子單（migration_88）。
-- 使用者的規則：**打其中任何一個，整組都要跟著亮**。
--
--     母單打星 → 所有子單跟著
--     子單打星 → 母單跟著，母單再帶動其他兄弟
--     取消同理
--
-- 寫在前端的話，只有「從支出頁點星星」那條路會同步。
-- 從儀表板、從匯入、從 API 改的都不會 —— 而不同步不會報錯，
-- 只會讓篩選出來的清單少幾張子單，看起來像資料不見了。
--
--
-- 【遞迴防護】
-- 母單改 → 更新子單 → 子單的觸發器又想去更新母單 → 無限迴圈。
-- 兩個觸發器都加 WHEN 條件（值真的變了才跑），而且更新前先比對，
-- 值一樣就不寫 —— 沒有 UPDATE 就沒有下一輪觸發，遞迴自然終止。


-- ============================================================
-- 1. 欄位
-- ============================================================

alter table public.expenses
  add column if not exists starred boolean not null default false;

-- 篩選「只看關注」會一直用到,而且關注的通常只佔一小部分 —— 部分索引最省。
create index if not exists exp_starred_idx on public.expenses (starred) where starred;

comment on column public.expenses.starred is
  '關注支出。遞延的母子單會一起連動 —— 打其中一個,整組都亮。';


-- ============================================================
-- 2. 母單 → 子單
-- ============================================================

create or replace function public.star_down_to_children() returns trigger
language plpgsql security definer set search_path = public as $fn$
begin
  -- 先比對再寫。值一樣就不 UPDATE —— 沒有 UPDATE 就不會觸發下一輪,
  -- 這是遞迴防護的第二道（第一道是觸發器的 WHEN 條件）。
  update expenses
     set starred = new.starred
   where parent_expense_id = new.id
     and starred is distinct from new.starred;
  return null;
end $fn$;

drop trigger if exists trg_expense_star_down on public.expenses;
create trigger trg_expense_star_down
  after update of starred on public.expenses
  for each row
  when (old.starred is distinct from new.starred and new.parent_expense_id is null)
  execute function public.star_down_to_children();


-- ============================================================
-- 3. 子單 → 母單
--
-- 只更新母單就好 —— 母單的觸發器會接著把其他兄弟帶起來。
-- 這裡直接去更新兄弟的話，兩個方向會同時跑，順序不確定。
-- ============================================================

create or replace function public.star_up_to_parent() returns trigger
language plpgsql security definer set search_path = public as $fn$
begin
  update expenses
     set starred = new.starred
   where id = new.parent_expense_id
     and starred is distinct from new.starred;
  return null;
end $fn$;

drop trigger if exists trg_expense_star_up on public.expenses;
create trigger trg_expense_star_up
  after update of starred on public.expenses
  for each row
  when (old.starred is distinct from new.starred and new.parent_expense_id is not null)
  execute function public.star_up_to_parent();


-- ============================================================
-- 4. 新子單要繼承母單的星
--
-- 遞延明細改了會全刪重建（見 DeferralPanel）。不繼承的話，
-- 每次改明細,那組單的星星就會掉光,而且沒有任何跡象。
--
-- 併進 migration_88 的 sync_expense_child()，逐字保留其餘部分，
-- 只多一行 starred。分成兩個 before insert 觸發器的話,
-- 執行順序按名稱排,以後改名就會踩到。
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
  -- 關注跟著母單（migration_89）—— 改遞延明細時星星不該掉光
  new.starred        := p.starred;
  -- source_item_id 不繼承：那一欄是 unique 的（一個請款項目一筆支出）,
  -- 複製過來會直接違反約束。子單靠 parent_expense_id 回溯到請款單。
  new.source_item_id := null;
  new.deferred       := false;
  new.gross_amount   := null;
  return new;
end $fn$;


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
   where table_schema = 'public' and table_name = 'expenses' and column_name = 'starred';
  if n = 1 then raise notice '✅ expenses.starred 已建立';
  else raise warning '❌ starred 欄位不存在'; return; end if;

  select count(*) into n from pg_indexes
   where schemaname = 'public' and indexname = 'exp_starred_idx';
  if n = 1 then raise notice '✅ 關注的部分索引已建立';
  else raise warning '❌ exp_starred_idx 不存在'; end if;

  -- 兩個方向的觸發器都要有 WHEN 條件,否則會無限遞迴
  select count(*) into n from pg_trigger
   where tgname in ('trg_expense_star_down', 'trg_expense_star_up') and tgqual is not null;
  if n = 2 then raise notice '✅ 母子連動的兩個觸發器都有 WHEN 條件（遞迴防護）';
  else raise warning '❌ 連動觸發器只有 % 個有 WHEN 條件,可能無限遞迴', n; end if;

  -- 新子單要繼承星
  c := pg_get_functiondef('public.sync_expense_child()'::regprocedure);
  if position('new.starred' in c) > 0 then
    raise notice '✅ 新子單會繼承母單的關注';
  else raise warning '❌ sync_expense_child 沒有繼承 starred,改遞延明細時星星會掉光'; end if;

  -- migration_88 的繼承邏輯不能被改壞 —— 這一支重寫了那個函式
  if position('source_item_id' in c) > 0 and position('gross_amount' in c) > 0
     and position('parent_expense_id is null' in c) > 0 then
    raise notice '✅ 原本的子單繼承邏輯仍在';
  else raise warning '❌ sync_expense_child 被改壞了!'; end if;

  -- 既有資料沒有被動到
  select count(*) into n from public.expenses where starred;
  raise notice 'ℹ 目前有 % 筆關注支出', n;

exception when others then
  raise warning '驗證區出錯（schema 變更不受影響）:%', sqlerrm;
end $$;


-- ── 母子連動的實測 ─────────────────────────────────
--
-- 這一段會實際打一次星再還原。只讀系統目錄驗證不到「連動真的會跑」——
-- 觸發器是程序碼,要跑過才知道（migration_65 就是這樣漏掉的）。
-- 整段包在 exception 裡,而且結尾一定還原,不留任何痕跡。

do $$
declare pid uuid; kid uuid; n int;
begin
  select e.id into pid from public.expenses e
   where e.deferred and exists (select 1 from public.expenses c where c.parent_expense_id = e.id)
   limit 1;
  if pid is null then
    raise notice '（目前沒有遞延母子單可測,略過連動實測）';
    return;
  end if;
  select id into kid from public.expenses where parent_expense_id = pid limit 1;

  -- 子單打星 → 母單與兄弟都要跟著
  update public.expenses set starred = true where id = kid;
  select count(*) into n from public.expenses
   where (id = pid or parent_expense_id = pid) and starred;
  if n = 1 + (select count(*) from public.expenses where parent_expense_id = pid) then
    raise notice '✅ 子單打星,整組都跟著亮了';
  else raise warning '❌ 子單打星沒有連動,只有 % 筆亮起來', n; end if;

  -- 還原
  update public.expenses set starred = false where id = pid;
  select count(*) into n from public.expenses
   where (id = pid or parent_expense_id = pid) and starred;
  if n = 0 then raise notice '✅ 母單取消,整組都跟著暗了（已還原）';
  else raise warning '❌ 取消沒有連動,還有 % 筆亮著', n; end if;

exception when others then
  raise warning '連動實測出錯:%', sqlerrm;
end $$;


-- ── 記錄執行 ───────────────────────────────────────
do $$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    raise notice '%', (select public.record_migration('89_expense_starred'));
  else
    raise notice '尚未建立 schema_migrations（migration_70），這支沒有被記錄';
  end if;
end $$;
