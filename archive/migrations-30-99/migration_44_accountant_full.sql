-- migration_44：會計權限全開
--
-- 取代 migration_41 的欄位限制做法。
-- 決策依據:David 指定「權限都開給會計」。實務上會計就是帳務的主要操作者,
-- 每卡一次就補一張表的做法既慢又會一直漏,不如一次對齊 manager 的權限。
--
-- ⚠️ 這支同時解決「會計編輯契約存不進去」的問題。
--
-- 原因是 migration_41 的守衛只判斷「當下角色是會計」,沒有區分這次更新
-- 是使用者直接改的、還是別的觸發器連鎖進來的：
--     改 contracts → contracts_sync → gen_contract_orders()
--                  → 重新產生月租單(寫 amount / checkin 等欄位)
--                  → 撞上守衛白名單 → 例外 → 整筆契約更新失敗
-- 而錯誤訊息講的是 orders 的欄位,使用者只看到「契約存不進去」,
-- 完全看不出關聯。守衛拆掉後這條路就通了。

-- ============================================================
-- 1. 拆掉欄位層級的守衛
-- ============================================================
drop trigger if exists trg_orders_guard_accountant on public.orders;
drop function if exists public.orders_guard_accountant();


-- ============================================================
-- 2. orders：從「只能 UPDATE 收款欄位」改成完整權限
-- ============================================================
drop policy if exists orders_accountant_write  on public.orders;
drop policy if exists orders_accountant_insert on public.orders;
drop policy if exists orders_accountant_delete on public.orders;
drop policy if exists orders_accountant_all    on public.orders;
create policy orders_accountant_all on public.orders
  for all
  using (current_role_of() = 'accountant')
  with check (current_role_of() = 'accountant');


-- ============================================================
-- 3. 其餘還卡著的表
--
--   account_codes            會計科目 —— 本來就是會計的職掌
--   estates / properties     物業與房源主檔
--   purchase_request_items   請款單的項目明細
-- ============================================================
drop policy if exists account_codes_accountant_all on public.account_codes;
create policy account_codes_accountant_all on public.account_codes
  for all using (current_role_of() = 'accountant') with check (current_role_of() = 'accountant');

drop policy if exists estates_accountant_all on public.estates;
create policy estates_accountant_all on public.estates
  for all using (current_role_of() = 'accountant') with check (current_role_of() = 'accountant');

drop policy if exists properties_accountant_all on public.properties;
create policy properties_accountant_all on public.properties
  for all using (current_role_of() = 'accountant') with check (current_role_of() = 'accountant');

drop policy if exists pri_accountant_all on public.purchase_request_items;
create policy pri_accountant_all on public.purchase_request_items
  for all using (current_role_of() = 'accountant') with check (current_role_of() = 'accountant');


-- ============================================================
-- 4. revenue_recognitions 維持唯讀 —— 這不是漏掉,是刻意的
--
-- 這張表完全由 trg_orders_recog 觸發器維護:每次訂單異動就先刪光該訂單的
-- 認列列、再重新產生。手動寫進去的值會在下一次訂單異動時被清掉。
--
-- 也就是說開放寫入不會讓會計「能改營收」,只會讓他改完之後某個時間點
-- 數字自己變回去,而且沒有任何提示。那不是權限,是陷阱。
-- 要調整營收請改訂單,報表會跟著重算。
--
-- 若仍然要開放,取消下面兩行的註解:
-- drop policy if exists rr_accountant_all on public.revenue_recognitions;
-- create policy rr_accountant_all on public.revenue_recognitions
--   for all using (current_role_of() = 'accountant') with check (current_role_of() = 'accountant');


-- ============================================================
-- 5. 驗證
-- ============================================================
-- 守衛應已消失
select count(*) as 守衛觸發器_應為0
from pg_trigger where tgname = 'trg_orders_guard_accountant';

-- 會計仍然只有 SELECT 的表(預期只剩 revenue_recognitions)
select tablename, string_agg(distinct cmd, ', ') as 會計可做的操作
from pg_policies
where schemaname = 'public'
  and (coalesce(qual, '') || coalesce(with_check, '')) like '%accountant%'
group by tablename
having not bool_or(cmd in ('ALL', 'INSERT', 'UPDATE', 'DELETE'))
order by tablename;
