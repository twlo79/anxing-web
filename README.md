# 安幸上工 — 內部管理網站

Next.js 14 (App Router) + Supabase(Auth + PostgreSQL + RLS)。
短租/長租訂單、收款、營收認列、Airbnb 評價與清潔記錄的一站式後台。

---

## 快速開始

```bash
npm install
npm run dev      # http://localhost:3000
```

`.env.local` 需要:

| 變數 | 用途 | 可公開 |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase 專案 URL | ✅ |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | 前端 anon key(安全性由 RLS 保護) | ✅ |
| `SUPABASE_SERVICE_KEY` | 匯入 / 管理 API 用的 service role key | ❌ 僅伺服器 |
| `IMPORT_KEY` | `/api/import/*` 的共享密鑰(header `x-import-key`) | ❌ |

---

## 目錄結構

```
src/
  middleware.ts                  未登入一律導向 /login;/api/import/* 除外
  lib/supabase.ts                createBrowserClient
  app/
    login/page.tsx
    (app)/layout.tsx             側邊選單(依 profiles.role 過濾)
    (app)/shortterm/page.tsx     短租訂單與收款(orders)
    (app)/contracts/page.tsx     契約訂單與收款(contracts + orders)
    (app)/revenues/page.tsx      營收報表(revenue_recognitions)+ xlsx 匯出
    (app)/expenses/page.tsx      支出(佔位)
    (app)/reviews/page.tsx       Airbnb 評價(reviews)
    (app)/cleaning/page.tsx      清潔記錄(cleaning_records)
    (app)/admin/page.tsx         設定:人員 / 物業 / 房源 / 帳號
    api/admin/staff-account/     建立/停權/改密碼/改角色(service role)
    api/import/*                 外部資料匯入端點
  data/*.json                    一次性 seed 資料
migration_28_auto_renew.sql
migration_29_watch.sql
```

---

## 角色與權限

角色存於 `profiles.role`,RLS 全部透過 `current_role_of()` 判斷:

```sql
create function current_role_of() returns text
  language sql stable security definer as $$
  select role from profiles where id = auth.uid() and active $$;
```

| 角色 | 選單 | 資料權限重點 |
|---|---|---|
| `housekeeper` 管家 | 短租、契約、評價、清潔 | 可讀寫 `orders` / `contracts` / `contract_payments`;**看不到** `revenue_recognitions`、`revenue_snapshots` |
| `manager` 主管 | + 營收、支出 | 可寫 `orders`/`reviews`/`cleaning_records`/營收表 |
| `super_admin` | + 設定 | 全部,含 `estates`/`properties`/`staff`/`profiles` 的寫入 |

所有 public schema 的表都已啟用 RLS。

---

## 資料庫架構

### ER 圖

```mermaid
erDiagram
    estates   ||--o{ properties        : estate_id
    estates   ||--o{ orders            : estate_id
    estates   ||--o{ contracts         : estate_id
    properties||--o{ orders            : property_id
    properties||--o{ reviews           : property_id
    properties||--o{ cleaning_records  : property_id
    properties||--o{ staff_properties  : property_id
    staff     ||--o{ cleaning_records  : staff_id
    staff     ||--o{ staff_properties  : staff_id
    contracts ||--o{ orders            : contract_id
    contracts ||--o{ contract_payments : contract_id
    orders    ||--o{ revenue_recognitions : order_id
    orders    ||--o{ contract_payments : order_id
    orders    ||--o{ orders            : parent_order_id
    profiles  ||..|| staff             : auth_uid
```

### 三層核心關係

```
主體層          交易層                     報表層
estates  ──┐
           ├─► orders ───(trigger)───► revenue_recognitions   (即時,依月切分)
properties ┘      ▲
                  │ (trigger 產生 LT_ 月租單)
contracts ────────┘

                                        revenue_snapshots      (歷史月份快照,無 FK)
```

### 外鍵一覽

| 子表.欄位 | → 父表.欄位 | on delete |
|---|---|---|
| `properties.estate_id` | `estates.id` | NO ACTION |
| `orders.estate_id` | `estates.id` | NO ACTION |
| `orders.property_id` | `properties.id` | NO ACTION |
| `contracts.estate_id` | `estates.id` | NO ACTION |
| `contract_payments.contract_id` | `contracts.id` | **CASCADE** |
| `contract_payments.order_id` | `orders.id` | NO ACTION |
| `revenue_recognitions.order_id` | `orders.id` | **CASCADE** |
| `reviews.property_id` | `properties.id` | NO ACTION |
| `cleaning_records.property_id` | `properties.id` | NO ACTION |
| `cleaning_records.staff_id` | `staff.id` | NO ACTION |
| `staff_properties.staff_id` | `staff.id` | **CASCADE** |
| `staff_properties.property_id` | `properties.id` | **CASCADE** |

> 未建 FK 但邏輯上相關:`orders.contract_id → contracts.id`、`orders.parent_order_id → orders.id`(加費/移房子單)、`orders.move_group`(同一次移房的群組 id)、`profiles.id` 與 `staff.auth_uid` 皆指向 `auth.users.id`。

### 唯一鍵(冪等匯入的依據)

| 表 | 唯一鍵 |
|---|---|
| `orders` | `order_key` |
| `reviews` | `airbnb_review_id` |
| `cleaning_records` | `record_key` |
| `properties` | `airbnb_listing_id` |
| `estates` | `name` |
| `staff` | `name` |
| `contract_payments` | (`contract_id`, `period_start`) |
| `staff_properties` | (`staff_id`, `property_id`) — 複合主鍵 |

### 查詢索引

| 表 | 索引欄位 |
|---|---|
| `orders` | `checkin`, `checkout`, `estate_id`, `source` |
| `revenue_recognitions` | `ym`, `order_id` |
| `revenue_snapshots` | `ym`, `estate_name` |
| `reviews` | `property_id`, `checkout_date`, `overall_rating` |
| `cleaning_records` | `record_date`, `property_id`, `staff_id`, `overall_rating`, `note`(gin_trgm) |

---

## 各表說明

### `estates` 物業
`id, name*, manager, sort, active, created_at`
最上層。`manager` 是文字欄位(非 FK),評價報表用它做「主管排行」。

### `properties` 房源
`id, name, estate_id→estates, airbnb_listing_id*, name_aliases text[], active, created_at`
`airbnb_listing_id` 是 Airbnb 匯入時對應房源的主要鍵;抓不到時退回 `name` 的模糊比對(`normUnit()` 正規化房號)。

### `staff` 人員 / `profiles` 帳號
- `staff`: `id, name*, aliases text[], staff_type, role, email, auth_uid, active, sort`
- `profiles`: `id (= auth.users.id), name, role, active`

`staff` 是人員名冊(清潔記錄用 `name`/`aliases` 比對),`profiles` 是登入帳號。兩者透過 `staff.auth_uid = profiles.id` 對應,由 `/api/admin/staff-account` 維護(建立帳號、改密碼、停權、改角色會同時更新兩張表)。

### `contracts` 契約
`id, name, type(longterm|company|office), estate_id→estates, room, property_raw, tenant_name, phone,
start_date, end_date, cadence(monthly|quarterly|halfyear|yearly), monthly_rent, amount_per_period, deposit,
first_payment_date, pay_day, account, note, paid, deposit_received(_at), deposit_returned(_at),
active, auto_renew, watch, display_name, created_at`

`watch` = 釘選到「本月已收/未收」清單;`display_name` = 自訂顯示名;`auto_renew` = 到期後自動續產月租單。

### `orders` 訂單(全站交易中心)
`id, order_key*, source, estate_id→estates, property_id→properties, property_raw, guest_name,
checkin, checkout, nights, amount, deposit, deposit_received(_at), deposit_returned(_at),
fx_revenue jsonb, fx_deposit jsonb, account, note, fee_type, paid, paid_at,
contract_id, parent_order_id, move_group, imported_via, created_at`

`source` 值:

| 值 | 意義 | 產生方式 |
|---|---|---|
| `airbnb` | Airbnb(含 co-host 搭檔收款) | 自動匯入 |
| `agoda` | Agoda | 匯入 |
| `private` | 直客短租 | 手動 / 匯入 |
| `oneoff` | 一次性收入(取消費、加費) | 觸發 / 手動 |
| `longterm` / `company` / `office` | 長租 / 公司戶 / 辦公室月租 | **由 contracts 觸發器產生** |

`imported_via`:`contract`(觸發器產生,可被覆寫)/ `auto`(爬蟲)/ `excel` / `manual` / `extend`(手動展延)。

`order_key` 命名規則:`LT_{room}_{YYYYMM}` 月租、`CFEE_…` 契約加費、`FEE_…` 訂單加費、`MOVE_…` 移房子單、`OO_/PV_…` 手動一次性/直客。

### `revenue_recognitions` 營收認列(由觸發器維護,勿手改)
`id, order_id→orders(CASCADE), ym, period_start, period_end, source, estate_id, property_id,
estate_name, property_raw, guest_name, checkin, checkout, total_amount, total_nights,
month_nights, month_amount, fee_type, created_at`

一張 `orders` 依住宿區間切成多個月份列,金額按住宿天數比例攤分。營收報表頁直接查這張表。

### `revenue_snapshots` 歷史營收快照
`id, ym, source, estate_name, property_raw, guest_name, checkin, checkout,
total_amount, month_amount, month_nights, total_nights, note, created_at`
無外鍵,系統上線前的歷史月份資料,由 `/api/import/snapshots` 全刪重建。

### `reviews` Airbnb 評價
`id, airbnb_review_id*, property_id→properties, listing_name_raw, guest_name,
checkin_date, checkout_date, nights, overall_rating,
comment, comment_original, comment_language,
rating_checkin / _cleanliness / _accuracy / _communication / _location / _value,
detail_comments jsonb, host_reply, source_url, imported_via, scraped_at`

`detail_comments` 內含 `private_feedback`、`private_feedback_localized`、`tags`。重新匯入時**已翻成中文的 `comment` 不會被覆蓋**。

### `cleaning_records` 清潔記錄
`id, record_key*, record_date, staff_name, staff_id→staff, staff_type,
property_id→properties, property_raw, estate_name, overall_rating, note, doc_url, source, created_at`
`staff_name` 先用 `staff.name` / `staff.aliases` 對應;房源用 `normUnit()` 模糊比對。評分可從 note 的「N 星」解析。

### `contract_payments` 契約期款
`id, contract_id→contracts(CASCADE), order_id→orders, period_start, period_end, amount, confirmed, confirmed_at`
唯一鍵 (`contract_id`, `period_start`)。目前前端未使用,收款狀態實際記在 `orders.paid` / `paid_at`。

### `staff_properties` 人員 × 房源
複合主鍵 (`staff_id`, `property_id`),雙向 CASCADE。目前前端未使用。

---

## 自動化(觸發器與函式)

```
contracts  ──[contracts_sync: AFTER INSERT/UPDATE/DELETE]──► gen_contract_orders(ct)
                                                              └─ 依 start_date~end_date 逐月
                                                                 upsert orders(LT_{room}_{YYYYMM})
                                                                 只覆寫 imported_via='contract' 且 paid=false 的列

orders     ──[orders_recognize: AFTER INSERT/UPDATE/DELETE]──► trg_orders_recog()
                                                              └─ 先刪舊 recognitions,再 gen_recognitions(o)
                                                                 依月切分攤 amount * n/nights
                                                                 source=oneoff 則整筆記在 checkin 當月
```

**重要:刪除或改寫契約時,已收款(`paid=true`)與匯入來源的訂單不會被觸發器動到**,這是保護人工欄位(收款、押金、外幣、移房)的設計。

其他 RPC / 工具函式:

| 函式 | 用途 |
|---|---|
| `review_stats(p_from, p_to)` | 各物業評價數與平均分 |
| `manager_stats(p_from, p_to)` | 主管別 1–5 星分布 |
| `cleaning_staff_stats(p_from, p_to)` | 清潔人員件數 / 平均分 / 低分數 |
| `monthly_revenue(p_year, p_month)` | 單月營收明細 |
| `monthly_revenue_summary(p_year, p_month)` | 單月營收彙總(物業 × 來源) |
| `rebuild_recognitions()` | 全量重建 `revenue_recognitions` |
| `rebuild_contract_orders()` | 全量重建契約月租單 |
| `current_role_of()` | RLS 用,取目前登入者角色 |

DB 擴充:`pg_trgm`(房號模糊比對)。

---

## 匯入 API

全部需要 header `x-import-key: $IMPORT_KEY`,並使用 `SUPABASE_SERVICE_KEY` 繞過 RLS。

| 端點 | 方法 | 說明 |
|---|---|---|
| `/api/import/reviews` | POST | Airbnb 評價;以 `airbnb_review_id` upsert,回傳 `needTranslation` 清單。CORS 限 `airbnb.com` |
| `/api/import/translate` | GET / POST | 列出待翻譯留言 / 寫回中文翻譯(只接受含中文的內容) |
| `/api/import/airbnb-orders` | POST | Airbnb 訂單;`code`→`order_key` 去重,既有列只更新金額/日期,保留人工欄位 |
| `/api/import/orders` | POST | 通用訂單 upsert(Excel / Make) |
| `/api/import/cleaning` | POST | 清潔記錄 upsert(`record_key`) |
| `/api/import/snapshots` | POST | 歷史營收快照,全刪重建 |
| `/api/import/contracts-seed` | POST | 正隆契約 seed |
| `/api/import/contracts-general` | POST | 一般契約 seed(longterm/company/office) |
| `/api/import/shortterm-seed` | POST | 短租訂單 seed(先清空短租類再灌) |
| `/api/admin/staff-account` | POST | `create` / `password` / `role` / `ban` / `delete_account`,呼叫者須為 `super_admin` |

> `seed` 類端點是**破壞性**的(先 delete 再 insert),正式環境請勿隨意呼叫。

---

## 部署(Vultr)

```bash
# Ubuntu 24.04, Node 20+
npm install && npm run build
npm i -g pm2 && pm2 start npm --name anxing -- start
# Nginx 反代 + certbot 上 SSL
```

> ⚠️ `npm start` 實際監聽 **3001**(`package.json` 的 `next start -p 3001`),但 `DEPLOY.md` 的 Nginx 範例寫 `proxy_pass http://127.0.0.1:3000`。重建主機時要對齊。

CI:`.github/workflows/deploy.yml` — push 到 `main` 會 SSH 進 Vultr 執行 `git pull && npm install && npm run build && pm2 restart`,**任何 commit(含只改文件)都會觸發重建與重啟**。詳見 `DEPLOY.md`。

---

## 帳號管理

建議走 **設定 → 人員** 頁(`/admin`),由 `/api/admin/staff-account` 一次建立 `auth.users` + `profiles` 並回寫 `staff`。

手動作法:Supabase Dashboard → Authentication → Add user,再到 SQL Editor:

```sql
insert into profiles (id, name, role)
values ('<user_uuid>', '名字', 'housekeeper');  -- housekeeper | manager | super_admin
```

---

## 功能現況

| 模組 | 狀態 |
|---|---|
| 登入 / 角色選單 | ✅ |
| 短租訂單與收款(含加費、移房、外幣、押金) | ✅ |
| 契約訂單與收款(自動產生月租單、展延、關注) | ✅ |
| 營收報表(月度認列、xlsx 匯出) | ✅ |
| 評價查詢(篩選、細節抽屜、負評警示、自動翻譯) | ✅ |
| 清潔記錄(人員統計) | ✅ |
| 設定(人員/物業/房源/帳號) | ✅ |
| 支出 | 🚧 佔位頁 |
