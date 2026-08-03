-- migration_48：契約折讓
--
-- 分成兩層，刻意的：
--
--   ① 契約上的「折讓約定」（本次新增的 concessions 欄位）
--      純文字紀錄，記錄雙方談好的條件。可以有多筆。
--      不影響任何金額，只是備查。
--
--   ② 實際發生的折讓（用既有的 oneoff 機制，不需要新欄位）
--      在收租視窗按「− 折讓」產生一筆負數的一次性收入，
--      掛在契約下、記在指定日期當月。
--
-- 為什麼實際折讓不直接改月租單的金額？
--   LT_{room}_{YYYYMM} 是 gen_contract_orders() 產生的。只要之後編輯一次契約
--   （改租期、改租金），觸發器就會把未收款的月份重新產生 —— 折讓後的金額
--   會被蓋回原價，而且沒有任何提示。用獨立的一筆負數訂單就不會被動到。
--
-- 副作用是好的：oneoff 本來就會流進 revenue_recognitions（整筆記在當月），
-- 所以營收自動變少，不用另外寫連動。

alter table public.contracts
  add column if not exists concessions jsonb not null default '[]'::jsonb;

comment on column public.contracts.concessions is
  '折讓約定（純文字備查，不影響金額）。格式：[{"date":"2026-07-01","amount":20000,"note":"首期折讓"}]。實際折讓請在收租視窗產生 oneoff 負數訂單。';


-- ============================================================
-- 驗證
-- ============================================================
select column_name, data_type, column_default
from information_schema.columns
where table_name = 'contracts' and column_name = 'concessions';

-- 現有的一次性收入類型（折讓會以 fee_type = '折讓' 加入這個集合）
select fee_type, count(*), sum(amount)
from public.orders
where source = 'oneoff' and contract_id is not null
group by fee_type order by 2 desc;
