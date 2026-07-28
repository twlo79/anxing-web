-- 定期事項(發票 / 續約 / 退押金…)
-- 目前只實作 kind='invoice';其餘種類保留擴充,不需再跑 migration。
--
-- 設計原則:通用化「形狀」,不通用化「邏輯」。
--   形狀 = 某契約、每月某號、要做某事、逐期記錄完成狀態與一個編號、可帶固定備註
--   邏輯 = 觸發條件寫死在程式裡(gate 只有小 enum),不做規則引擎

-- ── 1. 契約層級的開票資訊(描述承租人,不屬於「定期事項」本身)────────────
alter table contracts add column if not exists tax_id        text;  -- 統一編號
alter table contracts add column if not exists invoice_title text;  -- 發票抬頭

-- ── 2. 定期事項設定 ──────────────────────────────────────────────────
create table if not exists recurring_tasks (
  id           uuid primary key default gen_random_uuid(),
  contract_id  uuid not null references contracts(id) on delete cascade,
  kind         text not null default 'invoice',   -- invoice | renewal | deposit_return
  enabled      boolean not null default true,
  day_of_month integer,                            -- 每月幾號執行
  gate         text not null default 'after_paid',
     -- 'after_paid' 該期收款已確認才提醒(對應「確定入帳才可開立」)
     -- 'none'       到日期就提醒,不看收款狀態(對應「先開立」)
  note         text,                               -- 固定備註,每期自動帶入(如 PO 號)
  created_at   timestamptz not null default now(),
  unique (contract_id, kind),
  constraint recurring_tasks_kind_chk check (kind in ('invoice','renewal','deposit_return')),
  constraint recurring_tasks_gate_chk check (gate in ('after_paid','none')),
  constraint recurring_tasks_day_chk  check (day_of_month is null or day_of_month between 1 and 31)
);

-- ── 3. 每期實例(僅在實際標記完成時才建立,不預先產生)────────────────────
create table if not exists recurring_task_logs (
  id         uuid primary key default gen_random_uuid(),
  task_id    uuid not null references recurring_tasks(id) on delete cascade,
  ym         text not null,        -- 期別 YYYYMM
  due_date   date,                 -- 應完成日
  done_at    date,                 -- 實際完成日(null = 未完成)
  ref_no     text,                 -- 編號:發票號碼 / 新合約編號 / 匯款單號
  note       text,                 -- 該期備註(預設帶入 recurring_tasks.note)
  created_at timestamptz not null default now(),
  unique (task_id, ym),
  constraint recurring_task_logs_ym_chk check (ym ~ '^\d{6}$')
);

create index if not exists idx_rt_contract on recurring_tasks (contract_id) where enabled;
create index if not exists idx_rtl_task    on recurring_task_logs (task_id);
create index if not exists idx_rtl_ym      on recurring_task_logs (ym);
create index if not exists idx_rtl_pending on recurring_task_logs (due_date) where done_at is null;

-- ── 4. RLS(比照 contracts_rw)──────────────────────────────────────────
alter table recurring_tasks     enable row level security;
alter table recurring_task_logs enable row level security;

drop policy if exists rt_rw  on recurring_tasks;
drop policy if exists rtl_rw on recurring_task_logs;

create policy rt_rw on recurring_tasks for all
  using (current_role_of() = any (array['housekeeper','manager','super_admin']));

create policy rtl_rw on recurring_task_logs for all
  using (current_role_of() = any (array['housekeeper','manager','super_admin']));

-- ── 5. 建立目前已知的五筆開票設定 ────────────────────────────────────────
-- 依房號比對契約。若該房號有多份契約,只套用到 active 的那份。
insert into recurring_tasks (contract_id, kind, day_of_month, gate, note)
select c.id, 'invoice', v.day, v.gate, v.note
from (values
  ('15B3',  5, 'after_paid', null),              -- 薛康     確定入帳才可開立
  ('15B5',  5, 'after_paid', null),              -- 尹雪美   確定入帳才可開立
  ('5B3',  15, 'after_paid', null),              -- 克拉克   確定入帳才可開立
  ('6B2',  17, 'after_paid', null),              -- 青宇     年繳每月開(發票一律按月,故無需特例)
  ('7B3',  20, 'none',       'PO4701105619')     -- 傑太日煙 先開立
) as v(room, day, gate, note)
join contracts c on c.room = v.room and c.active
on conflict (contract_id, kind) do update
  set day_of_month = excluded.day_of_month,
      gate         = excluded.gate,
      note         = excluded.note,
      enabled      = true;

-- 確認結果
select c.room, c.tenant_name, t.day_of_month as 開立日, t.gate as 時機, t.note as 固定備註
from recurring_tasks t join contracts c on c.id = t.contract_id
where t.kind = 'invoice' order by t.day_of_month, c.room;
