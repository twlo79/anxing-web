# 待決定 / 待處理事項

> 最後更新:2026-08-05（這個檔案**有**進版控 —— 之前那句「沒有加入版控」是錯的）

---

## 待開發（2026-08-05 記錄）

### A. 通知設定分頁

現在推播只有「請款核可」一種,開關還藏在請款頁最上方 —— 使用者找不到,也不知道還有什麼可以通知。

要決定的:

* 哪些事件可訂閱(請款待核可、押金待退、契約到期、房務排班異動、每日同步失敗…)
* 每個人自己選,還是總經理統一設定
* 放在權限管理底下,還是獨立一頁(每個角色都要看得到自己的)

### ~~B. 財務儀表板~~（2026-08-05 完成，見 `/dashboard`）

開放給會計 / 主管 / 總經理。圖表全部手寫 SVG,沒有新增任何相依。

還沒做、之後可以加的:

* **入住率** —— 需要「每間房每月可售天數」,那個數字目前系統裡沒有
* **每間房月營收(RevPAR)** —— 同上
* **跟去年同期比** —— 目前只比得了「區間對半切」,因為資料才一年多
* **辦公室費用分攤到各物業** —— 分攤比例要人決定,亂攤比不攤更誤導

### C. 統一篩選列與日期顯示（2026-08-05 起，逐頁改）

各頁的篩選各長各的,行為也不一致:

* 有的有「清除」按鈕,有的沒有
* 日期篩選有的是起訖兩欄、有的是月份下拉;有的預設本月、有的預設全部
* 列表上的日期格式也不統一(`2026-08-05` / `08-05` / `8/5`)

**已做**：`lib/filters.tsx`（FilterBar / FilterSelect / FilterDateRange / FilterSearch / FilterClear / FilterCount）
與 `lib/period.ts` 的顯示格式（`fmtDate` = `YYYY/MM/DD`）。

**已改用的頁面**：契約、財務儀表板

**還沒改的**：短租、請款、支出、押金、評價、清潔、房務
—— 一次全改沒辦法逐頁驗證，所以逐頁換。換的時候順手把該頁的日期顯示改成 `fmtDate`。

**`<input type="date">` 的顯示格式改不了**（dd/mm/yyyy vs yyyy/mm/dd）——
那是瀏覽器與作業系統的地區設定，網頁無法覆寫。要 yyyy/mm/dd 的話：
Chrome → 設定 → 語言 → 把「中文（繁體）」移到最上面 → 重新啟動。
送出的值一律是 ISO 的 `YYYY-MM-DD`，不受顯示影響，所以純粹是視覺問題。

### D. 刪除一律改成封存

**用詞統一**:現在「刪除」「撤銷」「作廢」混用,同一個動作在不同頁面叫不同名字。一律叫「刪除」。

**行為改成軟刪除**:按下去不是真的消失,而是移到封存區,可以還原。

要決定的:

* `archived_at` 欄位 vs 獨立封存表
* 哪些表要有(至少支出、請款單、訂單、契約、押金)
* 封存的誰看得到、能不能還原、多久之後真的清掉
* 列表預設隱藏封存的,要有「顯示已封存」開關

> `migration_72` 的 `data_audit` 已經把刪除的整列存下來了,短期內資料救得回來。
> 但那是**稽核用**的,不是給使用者自己還原的介面 —— 兩件事,不要混為一談。

---

## 1. ⚠ RLS:管家對 `orders` 的權限過寬 —— 等你決定顆粒度

**現況**

```sql
create policy orders_housekeeper on orders for all
  using      (current_role_of() = 'housekeeper')
  with check (current_role_of() = 'housekeeper');
```

沒有任何列層級限制 —— **任何管家可以修改或刪除任何一張訂單**,包含其他物業的長租收款金額。`contracts_rw`、`cp_rw` 也是相同情況。

**為什麼還沒動**

要收緊就得知道「哪位管家負責哪些房源」,但資料庫裡沒有這個對應關係:

- `staff_properties`(staff × property 關聯表)已建好但**是空的**,前端也完全沒用到
- `estates.manager` 只是一個文字姓名欄位,不是外鍵

猜錯的後果是管家上班時打不開自己該處理的訂單,比權限太寬更立即影響營運,所以停在這裡等決定。

**需要你回答:權限要切到什麼顆粒度?**

| 選項 | 作法 | 前置作業 |
|---|---|---|
| A. 按物業 | 管家只能碰自己負責的 estate 底下所有房源 | 用 `estates.manager` 對上 `staff.name` 即可建 |
| B. 按房源 | 逐間指派 | 要先把 `staff_properties` 填起來 |
| C. 全部共用 | 維持現狀,記錄成刻意為之 | 順便刪掉沒用到的 `staff_properties` |

C 完全合理 —— 小團隊互相代班很常見。

**連帶注意**:`gen_contract_orders` / `trg_contracts_sync` 目前**不是** `SECURITY DEFINER`(以呼叫者身分寫入 `orders`)。現在能運作是因為管家對 orders 全開;**一旦收緊 policy,契約同步會壞掉**。改 RLS 時要一併把這兩個函式設為 SECURITY DEFINER(`gen_recognitions` / `trg_orders_recog` 已經是了)。

---

## 2. 2F-1 / 2F-2 / 2F-3 的收款記錄仍是 0 期

程式已修(PR #1),不會再發生;但既有的空白沒有回補。

| 房號 | 承租人 | 月租 | 應已收 | 目前 |
|---|---|---|---|---|
| 2F-1 | 愛皮旅行社 | 32,000 | 16 期(202501–202604) | 0 |
| 2F-3 | 五月星科技 | 6,334 | 18 期(202409–202602) | 0 |
| 2F-2 | 美商炒飯吧 | 72,571 | 待確認 | 0 |

2F-2 的 seed 來源資料有問題:`first_payment_date` 是 2023-01-07,但租期起是 2026-04-01,首繳日比合約早三年。照公式會標成 6 期全收,但 `paid_through` 只到 2026-04-30,推測應該只有 1 期。**這筆要對實際帳目確認。**

修復腳本 `repair_2F.sql` 已備妥(分預覽 / 寫入 / 驗證三步,用 `begin/commit` 包住)。
**你說訂單會重新給我,所以先擱著** —— 若重新匯入涵蓋這三間,就不需要跑修復。

---

## 3. 其他已知問題(來自 2026-07-28 的程式碼檢視,尚未處理)

### 正確性

- **契約展延用 `setTimeout(400)` 等觸發器**(`contracts/page.tsx`)。中途失敗會留下「`end_date` 已改、金額沒改」的半套狀態。應包成單一 RPC 在同一交易內完成。
- **收款狀態有兩個真相來源**:`contracts.paid`(整份契約一個 boolean)vs `orders.paid`(每月一列),永遠不會自動同步。建議廢掉前者。
- **「刪除此期起」的實際刪除範圍是 `>= startYm`**,但 UI 以「批」呈現,容易誤刪該批之後的所有月份。
- **本月收租以 `property_raw`(房號字串)當 key**(`contracts/page.tsx:47-49`)。目前房號無跨物業重複所以沒出事,但 `orders` 已有 `contract_id`,應該改用它。
- **日期解析本地 / UTC 混用**:`revenues:28` 用 `Z`、`contracts:153` 用本地。台灣無日光節約所以目前安全。

### 效能(資料量還小,尚不痛)

- **營收報表每月硬上限 `.limit(3000)`**(`revenues/page.tsx:65`),超過會**靜默截斷**不報錯。目前單月最多 34 列,離上限很遠。
- **短租頁把全部符合的訂單抓到瀏覽器算加總**(`shortterm:94-111`),且與分頁查詢並行,每次改篩選發兩組查詢。應改 RPC。
- **營收頁 24 個月序列化查詢**(`revenues:79-82`,`for` 迴圈內 `await`)。改 `.in('ym', [...])` 一次拿。
- 缺少索引:`orders.parent_order_id`、`orders.contract_id`、`orders.move_group`、`orders.order_key text_pattern_ops`(前綴 LIKE 用不到現有的預設 collation 索引)、`contracts.estate_id`。
- 多張表 `reltuples = -1`,代表從未 `ANALYZE` 過。

### 安全

- **PostgREST filter 字串注入**:`shortterm:87`、`reviews:139` 把使用者輸入直接拼進 `.or()`。RLS 仍在所以不會越權,但可回傳非預期結果。
- **seed 端點與爬蟲共用同一把 `IMPORT_KEY`**。`shortterm-seed` 第一件事是 `delete from orders where source in (...)`。爬蟲那把 key 跑在 airbnb.com 的瀏覽器擴充裡,外洩即可清庫。建議 seed 改成本機腳本,或至少獨立 key + 正式環境擋掉。

### 架構

- **Migration 只有第 28、29 號在版控**,1~27 不存在。無法重建環境、無法 review schema 變更。建議 `supabase db pull` 建 baseline。
- **`orders` 一表五用**(短租 / 長租月租單 / 訂單加費 / 契約加費 / 移房分段),靠 `source` + `imported_via` + `order_key` 前綴 + `parent_order_id` + `move_group` 區分。最小改動收益最大的一刀:把加費拆成 `order_fees` 子表。
- **`order_key` 用 `Date.now()` + 亂數**,手動建立的訂單無法冪等,重複送出會產生重複列。
- **CI 沒有建置檢查**,`deploy.yml` 直接在正式機 `npm run build`,失敗會停在不一致狀態。建議在 GitHub Actions 先 build 再 rsync。
- `contract_payments`、`staff_properties` 兩張表建好但完全沒用;`monthly_revenue()` 等 4 個 RPC 也沒被前端呼叫。
- `contracts/page.tsx` 539 行、`reviews/page.tsx` 746 行,單檔什麼都做。

---

## 已完成(2026-07-28)

- README 重寫,含 ER 圖與完整資料表關係(`67e931f`)
- PR #1 `f4a83eb` — LIKE 萬用字元誤配 + `Math.round`→`Math.floor`
- PR #2 `70a1d5c` — next 14.2.15 → 14.2.35(安全性修補)
- PR #3 `77a6c0a` — `.gitignore` 整理、移除 token 交付建議、Nginx 埠號 3000→3001
