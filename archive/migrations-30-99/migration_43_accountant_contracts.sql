-- migration_43：讓會計能編輯契約
--
-- 補上 accountant 對 contracts 的寫入權限。
-- 這同時也修好收租視窗的「押金已收 / 已退」—— 那兩個欄位寫的是 contracts,
-- 不是 orders,所以 migration_41 沒有涵蓋到。
--
-- ⚠️ 改契約會連帶重算月租單
--
-- contracts 上有 contracts_sync 觸發器：改租期或金額時,
-- gen_contract_orders() 會重新產生 LT_{room}_{YYYYMM} 這些月租單。
-- 也就是說編輯契約不只是改一筆資料,而是會動到收款排程。
--
-- 這件事本身有保護:觸發器只覆寫 imported_via='contract' 且 paid=false 的列,
-- 已經收過款的月份不會被動到。所以最壞情況是「未來還沒收的月份被重排」,
-- 不會憑空改掉已入帳的紀錄。
--
-- 即便如此,這是本次三個角色調整裡影響面最大的一個 ——
-- orders 限制在收款欄位、invoices 是會計本職,唯獨這個會改到收款排程。

drop policy if exists contracts_accountant_write on public.contracts;
create policy contracts_accountant_write on public.contracts
  for all
  using (current_role_of() = 'accountant')
  with check (current_role_of() = 'accountant');


-- ============================================================
-- 驗證
-- ============================================================
select policyname, cmd from pg_policies
where schemaname = 'public' and tablename = 'contracts'
order by cmd, policyname;

-- 再跑一次盤點:會計「只有 SELECT、沒有寫入」的表。空結果代表都補齊了。
select tablename,
       string_agg(distinct cmd, ', ') as 會計目前可做的操作
from pg_policies
where schemaname = 'public'
  and (coalesce(qual, '') || coalesce(with_check, '')) like '%accountant%'
group by tablename
having not bool_or(cmd in ('ALL', 'INSERT', 'UPDATE', 'DELETE'))
order by tablename;
