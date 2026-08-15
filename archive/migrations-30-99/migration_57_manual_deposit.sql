-- migration_57：押金可以手動新增
--
-- migration_56 的押金一律由 orders / contracts 觸發器產生。實務上有些押金
-- 不掛在任何一張單下 —— 舊約的押金、代收的、還沒開單就先收的訂金。
-- 這些現在只能等有人補一張訂單才記得起來，等於逼人為了記帳去造假資料。
--
-- 手動列與連動列的差別只有一個：金額與房源姓名可以直接改。
-- 連動列的那些欄位是來源的快照，改了下次同步就被蓋回去。

alter table public.deposits
  add column if not exists is_manual boolean not null default false;

comment on column public.deposits.is_manual is
  '手動建立，不掛在任何訂單/契約下。金額與房源姓名可直接編輯（連動列的是來源快照，改了會被同步蓋回）。';


-- ============================================================
-- 放寬「必須恰好一個來源」
--
-- 三種合法情況：
--   連動列  → 有 order_id 或 contract_id，恰好一個
--   手動列  → 兩個都沒有，is_manual = true
--   孤兒列  → 來源被刪掉了，orphaned = true
-- ============================================================
alter table public.deposits drop constraint if exists dep_one_source;
alter table public.deposits add constraint dep_one_source check (
  num_nonnulls(order_id, contract_id) = 1
  or is_manual
  or orphaned
);


-- ============================================================
-- 手動列不該被同步觸發器碰到。
--
-- 目前的觸發器都用 order_id / contract_id 過濾，手動列兩個都是 null
-- 所以本來就掃不到 —— 這裡只是把前提寫下來，之後改觸發器時別破壞它。
-- ============================================================


-- ============================================================
-- 驗證
-- ============================================================
select
  count(*) filter (where is_manual)                                  as 手動建立,
  count(*) filter (where not is_manual and not orphaned)             as 來源連動,
  count(*) filter (where orphaned)                                   as 孤兒,
  count(*)                                                           as 總筆數
from public.deposits;

-- 不該存在：既非手動、又沒有來源、也沒標孤兒
select count(*) as 無主押金_應為0
from public.deposits
where not is_manual and not orphaned
  and order_id is null and contract_id is null;
