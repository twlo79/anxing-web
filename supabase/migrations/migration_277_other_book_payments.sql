/*
 * migration_277_other_book_payments.sql　2026-09-18
 * 其他收支帳：支出的「實支明細」
 *
 * 【怎麼跑】整份貼進 Supabase SQL Editor，看最後那張自檢表。
 *          ★ 看不到自檢的表格＝整支回滾了，不是「跑成功但沒輸出」。
 *
 * ══════════════════════════════════════════════════════════
 * 【使用者 2026-09-17 / 09-18】
 *   「愛皮 洪鯊 金額改成 應支 與 實支 / 點進去 可以編輯 實際支出 /
 *     有一個看板區 明細區 與 編輯區 / 看板區 應支 實支 差距 /
 *     明細區 日期 金額 付費方式 / 編輯區 輸入 日期 金額 付費方式 帳號」
 *   「多一欄檢視 有抽屜 > 可以進去 編輯 與 實支 編輯」
 *
 * ══════════════════════════════════════════════════════════
 * 【★★★ 應支不存，實支才存】
 *
 *     應支 ＝ `expenses.amount`（本來就有的那一欄）
 *     實支 ＝ 這張表加起來
 *
 * 一筆支出可以分好幾次付，所以實支是**一筆一列**，不是一個欄位。
 * 存成欄位的話「什麼時候付的、付去哪個帳戶」全部沒地方放，
 * 而那正是使用者要的「明細區」。
 *
 * ★ 差距（應支 − 實支）**不存** —— 它是算出來的。
 *   存進欄位的話維護它的只有前端一段程式，第二個寫入者一出現就永遠是錯的
 *   （README:推導值存成欄位，`bank_transactions.balance` 踩過）。
 *
 * ══════════════════════════════════════════════════════════
 * 【★★★ 代墊那幾筆不寫進這張表】
 *
 * 安幸代墊的支出（`expenses.advance_id` 有值），它的實支是
 * **安幸在暫付頁按「收回」時記的那個數字**（`advance_payments.refunded_amount`）。
 *
 * 同一筆錢**只有一個人寫**。兩邊各記一次的話會不一致，
 * 而且不會有任何地方報錯（README:一份資料存在兩個地方，
 * `deposits.amount` 與 `lines` 踩過）。
 *
 * ★ 所以底下有一條 check 擋住「代墊的支出被寫進這張表」——
 *   擋在資料庫，不是只擋在畫面。
 *
 * ══════════════════════════════════════════════════════════
 * 【跑兩次結果一樣】`if not exists` ＋ `drop policy if exists`。
 * ══════════════════════════════════════════════════════════
 */

begin;

-- ══════ ① 誰用得了其他收支帳（唯一的一份定義）══════

create or replace function public.other_book_roles()
returns text[] language sql immutable
as $fn$ select array['accountant', 'super_admin']::text[] $fn$;

comment on function public.other_book_roles() is
  '看得到／改得了其他收支帳(愛皮、洪鯊)的角色。'
  '★ 跟側欄 layout.tsx 的 /otherbooks roles 是同一份,兩邊要一致。'
  '★★ 這一份是唯一的定義 —— policy 與自檢都走它,不要在別的地方再打一次。';

create or replace function public.can_use_other_book()
returns boolean language sql stable security definer
set search_path = public
as $fn$
  select coalesce(
    (select p.role from public.profiles p where p.id = auth.uid())
      = any(public.other_book_roles()),
    false)
$fn$;

grant execute on function public.other_book_roles() to authenticated;
grant execute on function public.can_use_other_book() to authenticated;

-- ══════ ② 表 ══════

create table if not exists public.other_book_payments (
  id          uuid primary key default gen_random_uuid(),
  expense_id  uuid not null references public.expenses(id) on delete cascade,
  /* 付款日。★ 不可空 —— 一筆沒有日期的付款在明細裡排不進任何位置 */
  paid_on     date not null,
  amount      numeric not null,
  /* 現金 / 匯款 / 信用卡 / 加密貨幣 */
  method      text,
  /* 從哪個帳戶付的 */
  account     text,
  note        text,
  created_by  uuid references public.profiles(id) on delete set null,
  /* ★ clock_timestamp() 不是 now() —— now() 是交易開始時間（README） */
  created_at  timestamptz not null default clock_timestamp()
);

comment on table public.other_book_payments is
  '其他收支帳的「實支明細」:一筆支出實際付了幾次、每次多少(migration_277)。'
  '★ 應支是 expenses.amount,實支是這張表加起來,差距**不存**(算出來的)。'
  '★★★ 代墊的支出不寫進來 —— 它的實支在 advance_payments.refunded_amount,'
  '  由安幸的暫付頁按「收回」時寫。同一筆錢只有一個人寫。';

do $do$ begin
  alter table public.other_book_payments
    add constraint obp_amount_chk check (amount > 0);
exception when duplicate_object then null;
end $do$;

/*
 * ★★★ 代墊的支出不可以被寫進來。
 *
 *   擋在畫面上是不夠的 —— 那一層被繞過（或哪天有人寫了第二條路）之後，
 *   愛皮的實支就會同時有兩個來源，而**兩邊各自看起來都正常**，
 *   只有相減的時候差一截。
 *
 * ★ 用觸發器不用 check:check 不能查別的表。
 */
create or replace function public.obp_block_lent()
returns trigger language plpgsql
security definer set search_path = public
as $fn$
declare v_adv uuid;
begin
  select e.advance_id into v_adv from public.expenses e where e.id = new.expense_id;
  if v_adv is not null then
    raise exception '這筆是安幸代墊的支出 —— 它的實支要在「暫收付管理 → 暫付」按收回，不在這裡記';
  end if;
  return new;
end $fn$;

drop trigger if exists trg_obp_block_lent on public.other_book_payments;
create trigger trg_obp_block_lent
  before insert or update on public.other_book_payments
  for each row execute function public.obp_block_lent();

create index if not exists obp_expense_idx
  on public.other_book_payments (expense_id, paid_on);

/*
 * ★★★ `create table` 之後**一定**接 `enable row level security` ＋ `create policy`。
 *   RLS 開了而沒有 policy ＝ 查詢回成功、0 列，畫面上是一個很正常的
 *   「還沒有付款紀錄」而沒有任何錯誤（README 2026-09-02，migration_206 踩過）。
 */
alter table public.other_book_payments enable row level security;

drop policy if exists obp_read on public.other_book_payments;
create policy obp_read on public.other_book_payments
  for select using (public.can_use_other_book());

drop policy if exists obp_insert on public.other_book_payments;
create policy obp_insert on public.other_book_payments
  for insert with check (public.can_use_other_book());

drop policy if exists obp_update on public.other_book_payments;
create policy obp_update on public.other_book_payments
  for update using (public.can_use_other_book())
             with check (public.can_use_other_book());

drop policy if exists obp_delete on public.other_book_payments;
create policy obp_delete on public.other_book_payments
  for delete using (public.can_use_other_book());

do $do$ begin
  if to_regprocedure('public.record_migration(text)') is not null then
    perform public.record_migration('277_other_book_payments');
  end if;
end $do$;

commit;


-- ══════════════════════════════════════════════════════════
-- 自檢
-- ★★ 這張表在 commit 後面 —— 看不到它 = 整支回滾了。
-- ══════════════════════════════════════════════════════════

with pol as (
  select policyname::text as name,
         coalesce(qual, '')::text || ' ' || coalesce(with_check, '')::text as body,
         cmd::text as cmd
    from pg_policies where schemaname = 'public' and tablename = 'other_book_payments'
)

select * from (

  select 1 as ord, '① 表建好了沒' as "檢查",
         case when to_regclass('public.other_book_payments') is not null
              then 'other_book_payments ✅　欄位 '
                   || (select count(*)::text from information_schema.columns
                        where table_schema = 'public'   -- ★ 一定要帶（README）
                          and table_name = 'other_book_payments')
              else '❌ 沒建起來' end as "結果",
         case when to_regclass('public.other_book_payments') is null
              then '❌ 表不在 —— 下面全部不算數' else '✅' end as "判定"

  union all
  select 2, '② RLS 開了而且有 policy 嗎',
         case when to_regclass('public.other_book_payments') is null then '★ 表不在'
              else (case when (select relrowsecurity from pg_class
                                where oid = 'public.other_book_payments'::regclass)
                         then 'RLS ✅' else 'RLS ❌' end)
                   || '　policy ' || (select count(*)::text from pol) || ' 條：'
                   || coalesce((select string_agg(name || '(' || cmd || ')', '　' order by name) from pol), '無')
         end,
         case when to_regclass('public.other_book_payments') is null then '❌ 表不在'
              when not (select relrowsecurity from pg_class
                         where oid = 'public.other_book_payments'::regclass)
              then '❌ RLS 沒開'
              when (select count(*) from pol) < 4
              then '❌ 少於 4 條（讀／新增／修改／刪除）—— 缺的那個動作會全部被擋，'
                   || '而症狀是「回成功、0 列」'
              else '✅ RLS 開著，四個動作都有 policy' end

  union all
  /*
   * ★★★ 這一列**去讀那支函式吐出來的清單**，不是在這裡再打一次那兩個角色 ——
   *   再打一次的話是比我寫的跟我寫的，永遠會綠（README 2026-09-17）。
   */
  select 3, '③ 誰用得了其他收支帳',
         coalesce(array_to_string(public.other_book_roles(), '、'), '★ 函式不存在'),
         case when to_regprocedure('public.other_book_roles()') is null
              then '❌ 函式不見了'
              when 'cleaner' = any(public.other_book_roles())
                or 'housekeeper' = any(public.other_book_roles())
              then '❌ **房務或管家在名單裡** —— 側欄那一項只給會計與總經理'
              else '✅ ' || array_to_string(public.other_book_roles(), '、') end

  union all
  select 4, '④ 四條 policy 真的走那支函式嗎',
         coalesce((select string_agg(name || '：' ||
                     case when body ~ '\mcan_use_other_book\M' then '有' else '**沒有**' end,
                     '　' order by name) from pol), '★ 沒有 policy'),
         case when not exists (select 1 from pol) then '❌ 一條 policy 都沒有'
              when exists (select 1 from pol where body !~ '\mcan_use_other_book\M')
              then '❌ 有 policy 沒走那支函式 —— 名單改了它不會跟'
              else '✅ 四條都走同一份名單' end

  union all
  /*
   * ★★★ 代墊的擋住了沒。這是整支最重要的一條 ——
   *   沒擋的話同一筆錢會有兩個來源，而兩邊各自看起來都正常。
   */
  select 5, '★★★ ⑤ 代墊的支出擋得住嗎',
         coalesce((select t.tgname::text || '（' ||
                     case when p.prosecdef then 'definer' else 'invoker' end || '）'
                     from pg_trigger t
                     join pg_class c on c.oid = t.tgrelid
                     join pg_namespace n on n.oid = c.relnamespace
                     join pg_proc p on p.oid = t.tgfoid
                    where not t.tgisinternal and n.nspname = 'public'
                      and c.relname = 'other_book_payments'
                      and t.tgname::text = 'trg_obp_block_lent'), '（觸發器不在）'),
         case when not exists (select 1 from pg_trigger t
                                join pg_class c on c.oid = t.tgrelid
                                join pg_namespace n on n.oid = c.relnamespace
                               where not t.tgisinternal and n.nspname = 'public'
                                 and c.relname = 'other_book_payments'
                                 and t.tgname::text = 'trg_obp_block_lent')
              then '❌ 不在 —— 代墊的實支會變成兩個來源'
              when coalesce((select pg_get_functiondef(p.oid) from pg_proc p
                              join pg_namespace n on n.oid = p.pronamespace
                             where n.nspname = 'public' and p.prokind in ('f','p')
                               and p.proname::text = 'obp_block_lent'), '')
                   not like '%advance_id%'
              then '❌ 觸發器沒在看 advance_id'
              else '✅ 代墊的寫不進來，只能在暫付頁按收回' end

  union all
  /*
   * ★ 母體要判定。現在有幾筆其他帳的支出、其中幾筆是代墊 ——
   *   全部都是代墊的話，這張表暫時一筆都不會有，那是對的。
   */
  select 6, '★★ ⑥ 母體：其他帳這個月有幾筆支出',
         coalesce((select count(*)::text || ' 筆支出，其中代墊 '
                     || count(*) filter (where e.advance_id is not null)::text || ' 筆'
                     from public.expenses e
                    where coalesce(e.book, 'anxing') <> 'anxing'), '（查不到）'),
         case when (select count(*) from public.expenses e
                     where coalesce(e.book, 'anxing') <> 'anxing') = 0
              then '⚠ 其他帳一筆支出都沒有 —— 上面驗的只是表的形狀'
              else '✅ 有東西可以檢查' end

  union all
  select 7, '⑦ 現在有幾筆實支明細',
         case when to_regclass('public.other_book_payments') is null then '★ 表不在'
              else (select count(*)::text || ' 筆' from public.other_book_payments) end,
         case when to_regclass('public.other_book_payments') is null then '❌ 表不在'
              when (select count(*) from public.other_book_payments) = 0
              then '⚠ 剛建好，0 筆是對的 —— 推上去之後在列上按「檢視」記第一筆'
              else '✅' end

  union all
  select 8, '⑧ 這一支有沒有被記錄',
         coalesce((select max(name) from public.schema_migrations
                    where name = '277_other_book_payments'), '（沒記到）'),
         case when exists (select 1 from public.schema_migrations
                            where name = '277_other_book_payments')
              then '✅' else '❌ record_migration 沒寫進去' end

) v(ord, "檢查", "結果", "判定") order by v.ord;
