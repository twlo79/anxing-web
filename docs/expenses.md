# 請款與支出模組 — 設計

> 2026-07-30。定案後的規格，實作前請先確認。

---

## 一、範圍

兩個新頁面：

- **`/purchases` 請款填寫** —— 同仁送單、主管兩層核可、核可後填採購日
- **`/expenses` 支出** —— 支出總表（目前是空殼），可獨立新增，也接收請款連動過來的資料

一張請款單含**多個項目**；每個項目在採購完成後各自產生**一筆**支出。

---

## 二、狀態機

```
draft ──送出──┬─ 總額 < 3000 ──────────────────────> approved（兩票全免）
              └─ 總額 ≥ 3000 ──> pending
                                    │
                          manager 一票 ┐
                                       ├─ 兩票到齊 ──> approved
                       super_admin 一票 ┘
                          任一方駁回 ─────────────> rejected（既有票數清空）

rejected ──申請人修改後重送──> 回到送出判斷
approved ──填入採購日──────> 產生支出
```

**兩票並行，沒有先後。** manager 一票、super_admin 一票，誰先核都行，兩票到齊才進 `approved`。

**低於 3000 兩票全免**，送出直接 `approved`。門檻看**整張單總額**，不是單一項目 —— 看項目會留下拆單規避的空間（5 項各 2,900 總共 14,500 全部免核）。

**核可不可逆。** 進 `approved` 之後不能編輯、不能刪除，唯一還能改的是 `purchased_on`（採購日）。

**採購日只有在 `approved` 才能有值** —— 這條寫成資料表的 CHECK 約束，不是只靠前端把按鈕藏起來。未核可就不可能採購。

**駁回必填原因，且會清空既有票數。** 單子退回 `rejected`，申請人改完重新送審，兩票重新來過。沒有駁回機制的話，一張金額打錯的單會卡死 —— 不能編輯、不能刪除、又不該核可。

---

## 三、權限

| | 請款單 | 核可 | 採購日 | 支出 |
|---|---|---|---|---|
| **housekeeper**（管家） | 建立；編輯／刪除**自己**的 `draft`、`rejected`；只看得到自己送的 | ✗ | ✗ | **完全看不到** |
| **accountant**（會計） | 檢視全部；也能自己送單 | **✗ 不可核可** | **✓** | 檢視、新增、編輯；只能刪自建的 |
| **manager**（主管） | 檢視全部；也能自己送單 | **✓ 一票** | ✓ | 檢視、新增、編輯；只能刪自建的 |
| **super_admin** | 全部 | **✓ 一票** | ✓ | 全部（含刪除連動支出） |

⚠️ **來自請款單的支出不可刪除**，只有 super_admin 例外。兩票核可是為了管錢，若那筆錢的紀錄一個人就能刪掉，這道關卡等於白設。而且刪除是靜默的 —— 請款單仍顯示已核可、有採購日，支出卻不見了，兩邊對不上而系統不會叫；加上 `gen_expenses_from_pr()` 只在採購日「從無到有」時才建立，刪掉後重填也救不回來。獨立新增的支出維持可刪。

核可綁**角色**不綁人：一位 `manager` 一票、一位 `super_admin` 一票。人員異動只要改角色，不用改程式。

會計另外唯讀開放：營收報表、短租訂單與收款、契約訂單與收款。

⚠️ **副作用：David 是 super_admin，所以也能投第二票。** 如果要讓 CEO 專責，得另外開一個 `ceo` 角色，成本是全表 RLS 重新檢查。目前不做。

⚠️ **自己送的單不能自己核。** 主管送的單那一票要由**其他**主管投。這條同時寫在 RLS policy 和 `pr_guard_votes()` 觸發器裡。

⚠️ **會計不得投票是用觸發器擋的，不是 RLS。** RLS 只能決定「哪些列可以改」，管不到「改了哪些欄位」—— 會計為了填採購日必須能 update 該列，所以擋投票這件事只能在觸發器做。

---

## 四、資料表

```sql
-- ── 會計科目主檔 ────────────────────────────────────────────
create table if not exists public.account_codes (
  code   text primary key,
  name   text not null,
  sort   int  not null default 0,
  active boolean not null default true
);

insert into public.account_codes (code, name, sort) values
  ('repair',    '修繕維護',      10),
  ('cleaning',  '清潔費',        20),
  ('supplies',  '備品消耗品',    30),
  ('utility',   '水電瓦斯',      40),
  ('internet',  '網路第四台',    50),
  ('rent',      '租金支出',      60),   -- migration_90 由「房租支出」正名
  ('mgmtfee',   '管理費',        70),
  ('insurance', '保險費',        80),
  ('salary',    '薪資勞務',      90),
  ('transport', '差旅交通',     100),
  ('marketing', '廣告行銷',     110),
  ('office',    '辦公用品',     120),
  ('tax',       '規費稅捐',     130),
  ('service',   '專業服務費',   140),
  ('other',     '其他',         900)
on conflict (code) do nothing;

-- migration_90 之後多了 kind 欄（expense / income / both），
-- 上面 15 個（加上 migration_46 的 travel、entertain、welfare 共 18～20 個）
-- 全部是 expense。收入方向從 sort 1000 起跳：
--   ('rent_income', '租金收入', 1000, true, 'income')
--
-- both 代表同一個科目兩邊都用（例如清潔費：跟房客收是收入，付清潔公司是支出）。
-- 支出頁與請款單的下拉會濾掉 kind='income'，資料庫也有觸發器擋
-- （check_account_kind_expense），因為前端擋不住 API 與匯入。

-- ── 請款單 ──────────────────────────────────────────────────
create table if not exists public.purchase_requests (
  id            uuid primary key default gen_random_uuid(),
  req_no        text unique not null,              -- PR-202607-001
  requester_id  uuid not null references auth.users(id),
  status        text not null default 'draft',
  total_amount  numeric not null default 0,        -- 由項目加總,觸發器維護

  -- 收款方(廠商)資訊。付款方式為 transfer 時才需要填。
  payment_method text,                             -- cash | transfer | credit_card
  payee_bank_code text,
  payee_account   text,
  payee_company   text,
  payee_tax_id    text,

  note          text,
  submitted_at  timestamptz,

  manager_approved_by uuid references auth.users(id),
  manager_approved_at timestamptz,
  ceo_approved_by     uuid references auth.users(id),
  ceo_approved_at     timestamptz,
  rejected_by         uuid references auth.users(id),
  rejected_at         timestamptz,
  reject_reason       text,

  purchased_on         date,                       -- 採購日,核可後才可填
  expense_generated_at timestamptz,                -- 防重複產生支出

  created_at timestamptz not null default now(),
  constraint pr_status_chk check (status in
    ('draft','pending_manager','pending_ceo','approved','rejected')),
  constraint pr_pay_chk check (payment_method is null or payment_method in
    ('cash','transfer','credit_card'))
);

create index if not exists pr_status_idx    on public.purchase_requests (status);
create index if not exists pr_requester_idx on public.purchase_requests (requester_id);

-- ── 請款項目 ────────────────────────────────────────────────
create table if not exists public.purchase_request_items (
  id           uuid primary key default gen_random_uuid(),
  request_id   uuid not null references public.purchase_requests(id) on delete cascade,
  item_name    text not null,
  amount       numeric not null default 0,
  account_code text references public.account_codes(code),

  -- 用途:房源 或 安幸辦公室
  purpose_type text not null default 'property',   -- property | office
  property_id  uuid references public.properties(id),

  note text,
  sort int not null default 0,
  constraint pri_purpose_chk check (
    (purpose_type = 'office'   and property_id is null) or
    (purpose_type = 'property' and property_id is not null)
  )
);

create index if not exists pri_request_idx on public.purchase_request_items (request_id);

-- ── 支出 ────────────────────────────────────────────────────
create table if not exists public.expenses (
  id           uuid primary key default gen_random_uuid(),
  spent_on     date not null,
  item_name    text not null,
  amount       numeric not null default 0,
  account_code text references public.account_codes(code),

  purpose_type text not null default 'property',
  property_id  uuid references public.properties(id),

  voucher_no   text,                               -- 憑證(發票/收據)號碼
  payment_method text,                             -- cash | transfer | credit_card
  pay_account  text,                               -- 我方付款帳號,如 8088 0513

  note text,
  -- 來源請款項目。獨立新增的支出為 null。
  -- 設 unique 是為了讓「同一個請款項目只能產生一筆支出」在資料庫層就成立,
  -- 不靠應用層自律。重跑連動時撞到唯一鍵就會被擋下。
  source_item_id uuid unique references public.purchase_request_items(id) on delete set null,

  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  constraint exp_purpose_chk check (
    (purpose_type = 'office'   and property_id is null) or
    (purpose_type = 'property' and property_id is not null)
  ),
  constraint exp_pay_chk check (payment_method is null or payment_method in
    ('cash','transfer','credit_card'))
);

create index if not exists exp_spent_idx   on public.expenses (spent_on desc);
create index if not exists exp_account_idx on public.expenses (account_code);
create index if not exists exp_prop_idx    on public.expenses (property_id);

notify pgrst, 'reload schema';
```

### 總額觸發器

```sql
create or replace function public.sync_pr_total() returns trigger
language plpgsql security definer as $$
begin
  update public.purchase_requests p
     set total_amount = coalesce((
       select sum(amount) from public.purchase_request_items where request_id = p.id
     ), 0)
   where p.id = coalesce(new.request_id, old.request_id);
  return null;
end $$;

drop trigger if exists trg_sync_pr_total on public.purchase_request_items;
create trigger trg_sync_pr_total
  after insert or update or delete on public.purchase_request_items
  for each row execute function public.sync_pr_total();
```

`total_amount` 一律由觸發器算，前端不寫。免核門檻靠它判斷，讓前端自己送總額等於把規則交給呼叫端。

---

## 五、連動：請款 → 支出

在 `approved` 狀態下填入 `purchased_on` 時觸發，逐項產生支出：

| 支出欄位 | 來源 |
|---|---|
| `spent_on` | 請款單的 `purchased_on` |
| `item_name` / `amount` / `account_code` | 請款項目 |
| `purpose_type` / `property_id` | 請款項目 |
| `payment_method` | 請款單表頭 |
| `pay_account` | 留空，由主管在支出頁補（請款單存的是**收款方**帳號，不是我方付款帳號） |
| `voucher_no` | 留空，拿到發票再補 |
| `source_item_id` | 請款項目 id |

產生後寫入 `expense_generated_at`。`source_item_id` 的唯一約束保證同一項目不會產生第二筆 —— 改採購日只會更新既有支出的 `spent_on`，不會再長出一筆。

---

## 六、頁面

### `/purchases` 請款填寫

三塊，由上而下：

1. **待核可佇列** —— 兩張卡：「待主管核可」「待 CEO 核可」，各顯示筆數與金額合計。點卡片即套用篩選。管家看不到這塊。
2. **工具列** —— 狀態／申請人／期間／用途 篩選 ＋ `⬇ 下載 Excel` ＋ `+ 填寫請款`
3. **請款單列表** —— 單號／申請人／項目數／總額／狀態／送出日／採購日／操作

操作欄依狀態與角色顯示：`編輯`（draft/rejected 且是自己的）、`核可`／`駁回`（對應關卡的角色）、`填採購日`（approved 且未產生支出）、`刪除`（draft 且是自己的）。

請款單表單：表頭（付款方式、收款方資訊、備註）＋ 可增減的項目列（項目名稱／金額／會計科目／用途／備註），底部即時顯示總額與「此單免核可／需兩關核可」。

### `/expenses` 支出

1. **統計** —— 總支出 ＋ 會計科目分項 ＋ 房源分項（沿用 `/reviews` 的卡片版型）
2. **工具列** —— 期間／科目／用途／支付方式 篩選 ＋ `⬇ 下載 Excel` ＋ `+ 填寫支出`
3. **支出列表** —— 支出日／項目／金額／科目／用途／憑證號／支付方式／備註／操作（編輯、刪除）

來自請款的支出在列表上標記來源單號，可回連。

**排序與匯出照既有慣例**：用 `src/lib/sortable.tsx` 的 `SortTh`／`sortRows`；資料量大時走伺服器端分頁＋伺服器端排序，匯出要重新向伺服器要完整結果（見 `/shortterm` 的作法），不能直接匯出當前頁。

---

## 七、實作順序

1. 跑 SQL（含 RLS policy），確認 `notify pgrst` 有執行
2. `/expenses` 先做 —— 它不依賴請款，可以獨立驗證
3. `/purchases` 表單與狀態機
4. 核可流程與 RLS 驗證（用真實帳號逐角色測，別只信 policy 寫得對）
5. 連動邏輯
6. 側邊選單加入口（依 `profiles.role` 過濾，管家不顯示支出）

---

## 八、開帳號

目前只有三個帳號：David（super_admin）、Property manager（housekeeper）、月（housekeeper）。**沒有任何 manager 角色的帳號。**

需要新增：

| 姓名 | 角色 | 用途 |
|---|---|---|
| Jessica | `manager` | 第一關核可 |
| Jim | `super_admin` | 第二關核可 |

用 `/admin` 頁的人員管理建立（走 `api/admin/staff-account`，service role）。**建帳號要設密碼，這步請你自己操作，我不經手密碼。**

Jim 設成 `super_admin` 代表他也能看到所有資料與設定，不只是核可。若不希望如此，就得走第三節提到的新增 `ceo` 角色那條路。
