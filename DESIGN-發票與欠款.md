# 設計:應繳日修正、跨月欠款、發票管理

> 草案,尚未實作。文末有幾個問題需要你回答才能動工。
> 2026-07-28

---

## 一、應繳日不要差一天(一行修正)

**現況** `src/app/(app)/contracts/page.tsx:474`

```ts
const dd = new Date(base.getFullYear(), base.getMonth(), day);
dd.setDate(dd.getDate() - 1);   // ← 刪掉這行
```

驗算:首繳 2026-09-01、`pay_day = 1` → 算出 9/1 後減一天 = **8/31**,與畫面的「第 1 期 2026/9 應繳 2026/8/31」吻合。

**改後**:應繳 2026/9/1。

風險極低,但要確認一件事:**這個「前一天」當初是刻意的嗎?**(commit #83 的訊息寫「應繳日=起始日前一天(A)」,像是某個房東的收租習慣)。如果只有部分契約適用,那就不是刪掉,而是要變成可設定。

---

## 二、跨月欠款區塊

**現況**:主畫面只看本月(`load()` 用 `.eq('checkin', curFirst)`),所以上個月沒收到的租金**完全不會顯示**。畫面上的「本月未收 $1,058,229」只是本月。

**新增查詢**

```ts
const { data: arrears } = await supabase
  .from('orders')
  .select('id, order_key, property_raw, guest_name, amount, checkin, contract_id, source')
  .in('source', ['longterm', 'company', 'office'])
  .eq('paid', false)
  .lt('checkin', curFirst)        // 早於本月 = 已到期未收
  .order('checkin');
```

**顯示**(新卡片,放在現有四張卡下方)

```
跨月欠款  3 間・共 7 期・$486,000
┌──────────────────────────────────────────────┐
│ 15B3  薛康      欠 3 期  2026/4,5,6   $96,000 │
│ 5B3   克拉克    欠 2 期  2026/5,6     $70,000 │
│ 7B3   傑太日煙  欠 2 期  2026/5,6    $320,000 │
└──────────────────────────────────────────────┘
```

每列點下去直接開該契約的收款視窗。

**細節**
- 房源名優先用 `display_name`,沒有才用 `room`
- 期別顯示連續月份時合併(`2026/4~6`),不連續才逐月列(`2026/4, 6`)
- 依「最舊欠款月份」排序,欠最久的在最上面
- 金額合計獨立於「本月未收」,兩者不重疊(本月未收看的是本月、欠款看的是本月之前)

**待確認**:已終止的契約(`active = false`)如果還有未收款,要不要列進來?我傾向要,但加上灰色「已終止」標記。

---

## 三、發票管理

### 3-1 為什麼另建一張表,而不是在 `orders` 加欄位

`orders` 已經一表五用(短租 / 長租月租單 / 訂單加費 / 契約加費 / 移房分段),再塞發票欄位會更難維護。而且**發票期別不一定等於收款期別** —— 青宇 6B2 是年繳(收款 1 期涵蓋 12 個月),但發票要每月開一張。

### 3-2 資料表 —— 做成通用的「定期事項」

**設計取捨:通用化形狀,不通用化邏輯。**

發票不是唯一的定期事項。從現有資料看,至少還有:契約到期續約提醒(`end_date`)、押金退還(`deposit_returned` 有欄位但無提醒)。與其為每一種各建一張表,不如共用骨架 ——「某契約、每月某號、要做某事、逐期記錄完成狀態與一個編號」。

但**觸發條件不做成可設定的規則引擎**。發票的「確定入帳才可開立」依賴 `orders.paid`,續約看 `end_date`,兩者性質不同;做成通用規則引擎會讓複雜度爆炸,而實際只有三四種。留一個小 enum,新增種類時在程式裡寫死判斷即可。

```sql
-- 定期事項設定(契約層級)
create table if not exists recurring_tasks (
  id           uuid primary key default gen_random_uuid(),
  contract_id  uuid not null references contracts(id) on delete cascade,
  kind         text not null,        -- 'invoice' | 'renewal' | 'deposit_return'
  enabled      boolean not null default true,
  day_of_month integer,              -- 每月幾號(renewal 之類可為 null)
  gate         text not null default 'none',
     -- 'none'       到日期就提醒
     -- 'after_paid' 該期 orders.paid = true 才提醒(發票的「確定入帳才可開立」)
  note         text,                 -- 固定備註,每期自動帶入(如 PO 號)
  created_at   timestamptz not null default now(),
  unique (contract_id, kind)
);

-- 每期實例
create table if not exists recurring_task_logs (
  id         uuid primary key default gen_random_uuid(),
  task_id    uuid not null references recurring_tasks(id) on delete cascade,
  order_id   uuid references orders(id) on delete set null,  -- 對應的月租單(用於 gate 判定)
  ym         text not null,          -- 期別 YYYYMM
  due_date   date,                   -- 應完成日
  done_at    date,                   -- 實際完成日(null = 未完成)
  ref_no     text,                   -- 編號:發票號碼 / 續約合約編號
  amount     numeric,
  note       text,
  created_at timestamptz not null default now(),
  unique (task_id, ym)
);

create index on recurring_tasks (contract_id) where enabled;
create index on recurring_task_logs (task_id);
create index on recurring_task_logs (due_date) where done_at is null;
```

`kind` 決定 UI 上的用詞:

| kind | 按鈕 | `ref_no` 欄位名 | gate |
|---|---|---|---|
| `invoice` | 開發票 | 發票號碼 | `after_paid` 或 `none` |
| `renewal` | 續約 | 新合約編號 | `none` |
| `deposit_return` | 退押金 | 匯款單號 | `none` |

先只實作 `invoice`,另外兩種等有需要再開。

**發票一律按月**,與 `cadence` 脫鉤 —— 這樣「年繳每月開」不需要任何特例。

> 註:若最後決定只做發票、不做通用化,把上面兩張表改名為 `contract_invoices` 並拿掉 `kind`
> 即可,其餘欄位不變。兩者的實作成本差異很小,差別只在未來加第二種提醒時要不要再跑 migration。

### 3-3 狀態判定

| 狀態 | 條件 | 顯示 |
|---|---|---|
| 等待入帳 | `policy = after_paid` 且該期 `orders.paid = false` | 灰 |
| 待開立 | 已到 `invoice_day`,且(`advance` 或該期已入帳) | 綠,可按「開立」 |
| 逾期未開 | 已過 `invoice_day` 超過 N 天仍未開立 | 紅 |
| 已開立 | `issued_at` 有值 | 顯示發票號碼 |

### 3-4 UI

**編輯契約視窗** 新增「發票」區塊:

```
☑ 需要開立發票
   開立日   每月 [ 5 ] 號
   開立時機 ( ) 確定入帳才可開立   ( ) 先開立
   固定備註 [ PO4701105619            ]   ← 每期自動帶入
```

**契約列表** 操作欄新增「開發票」按鈕(僅 `invoice_enabled` 顯示),按鈕上帶待開張數 badge。

**開發票視窗**(逐期列出):

```
開發票 — 7B3 傑太日煙          固定備註 PO4701105619
每月 20 號開立・先開立

2026/7   應開 7/20   ● 待開立    [發票號碼____] [備註____] [ 開立 ]
2026/6   應開 6/20   ✓ 已開立 6/20   AB-12345678   PO4701105619
2026/5   應開 5/20   ✓ 已開立 5/21   AB-12345677   PO4701105619
```

**主畫面** 新增卡片「本月待開發票 N 張」,點開列出房源與應開日。

### 3-5 那五位對象的設定對照

| 開立日 | 承租人 | 房號 | `kind` | `day_of_month` | `gate` | `note` |
|---|---|---|---|---|---|---|
| 5 號 | 薛康 | 15B3 | `invoice` | 5 | `after_paid` | — |
| 5 號 | 尹雪美 | 15B5 | `invoice` | 5 | `after_paid` | — |
| 15 號 | 克拉克 | 5B3 | `invoice` | 15 | `after_paid` | — |
| 17 號 | 青宇 | 6B2 | `invoice` | 17 | `after_paid` | — |
| 20 號 | 傑太日煙 | 7B3 | `invoice` | 20 | `none` | `PO4701105619` |

**青宇「年繳每月開」不需要特殊設定**:因為發票一律按月產生,而年繳的 12 個月 `orders` 在收款時就全部標記為已收,所以每個月到 17 號都會自動亮「待開立」。這正是要的行為。

---

## 需要你回答的問題

1. **應繳日的「前一天」當初是刻意的嗎?** 是所有契約都不要,還是只有部分?
2. **發票號碼有格式要驗證嗎?**(例:`AB-12345678` 兩碼英文 + 8 碼數字)
3. **要不要存統一編號和發票抬頭?** 目前設計沒有,但實際開立通常需要。
4. **開立金額 = 當月租金,還是可能包含水電等加費?** 若含加費,金額要能手動調整。
5. **「確定入帳」= `orders.paid` 打勾嗎?** 還是有另一道實際到帳確認的程序?
6. **提醒只在頁面上顯示就夠嗎?** 還是要 email / LINE 主動通知?(後者工程量差很多)
7. **歷史發票要補建嗎?** 還是從下一期開始記錄就好?

---

## 建議實作順序

| 階段 | 內容 | 相依 |
|---|---|---|
| 1 | 應繳日修正(刪一行) | 無 —— 可立即做 |
| 2 | 跨月欠款區塊 | 無 —— 純前端查詢 |
| 3 | 發票資料表 + 契約設定欄位 | 要先跑 migration |
| 4 | 開發票視窗 + 列表按鈕 | 依賴 3 |
| 5 | 本月待開發票卡片 | 依賴 3、4 |

階段 1、2 不動資料庫,可以先出。3 以後要先確認上面那些問題。
