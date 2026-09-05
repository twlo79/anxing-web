每日同步 Airbnb 評價到安幸 ERP（https://justwork.estia.com.tw）。

## 前置

1. 讀 `C:\Users\ASUS\Desktop\anxing-web\.env.sync` 取得 `IMPORT_KEY`。讀不到就中止並回報「找不到 .env.sync，需要在專案根目錄建立，內容一行 IMPORT_KEY=xxx」。
2. 用 Chrome 工具開一個分頁到 `https://www.airbnb.com/performance/quality/overall/reviews`，等待載入。
   **所有 fetch 都必須在這個 airbnb.com 分頁的 context 執行** —— Airbnb API 靠同源 cookie 認證，ERP 端點的 CORS 也只允許 `https://www.airbnb.com` 這個 origin。
3. 若頁面顯示未登入，立即中止並告知使用者需要重新登入 Airbnb，不要繼續，也不要嘗試自己登入。

## ⚠️ 執行方式：一次 navigate 配一個請求

**分頁在背景會被 Chrome 凍結。** 症狀非常有誤導性：

* navigate 之後的**第一個**請求正常（<1s），第二個開始永遠 pending
* 連 `AbortSignal.timeout()` 都不會觸發（計時器一起被凍）
* 逾時的是 CDP 那一層，**請求本身還在 server 上跑** —— 以為沒送出而重送，就會變成兩個並行的寫入

**唯一可靠的做法**：用 `browser_batch` 把 `navigate` 與 `javascript_tool` 兩兩配對，一次 navigate 只做一個請求。跨 reload 的資料用 `sessionStorage` 累積（`window.*` 會被 reload 清掉）。

2026-09-03 踩過：匯入 POST 卡住 6 分鐘、以為 ERP 掛了，實際上是分頁被凍結。

## ⚠️ locale 必須是 zh-TW

所有 Airbnb API 一律帶 `locale=zh-TW`。**這不是偏好問題，是正確性問題**：

- 用 `en` 時 `listingName` 會回英文翻譯（`Modern Minimalist German Design/5 Minutes to Ximen`），與 DB 及訂單 API 裡的中文原名對不上，房源對照會整片失效。
- 用 `en` 時住宿日期是 `Jul 24 – 26, 2026`；ERP 端點的解析器對中文格式 `2026年7月24日至26日` 支援較完整。

2026-07-30 曾因為用了 `en` 造成 50 筆評價的房源對應被洗掉，已修復。不要改回去。

## 步驟一：先取 ERP 狀態（一定要在匯入之前）

```
GET https://justwork.estia.com.tw/api/import/reviews/state
header: x-import-key: <IMPORT_KEY>
```

回傳 `{ dbCount, dbCountAll, recentIds, lastFullReconcile, lastSyncAt }`。

**順序不能顛倒** —— 步驟三會把新評價寫進 DB，寫完就算不出「今天新增幾筆」了。

**兩個數字用途不同，不要混用：**

* `dbCountAll` —— DB 全部評價數，含早期 CSV 匯入的。**要跟 Airbnb 的 `totalCount` 比的是這個。**
* `dbCount` —— 只算 `imported_via='auto'` 的（對帳只刪自動匯入的那些）。拿它跟 `totalCount` 比會得到 55 對 1473，判斷永遠不成立，偵測等於不存在。

## 步驟二：抓最新 50 筆評價（分 5 頁，每頁 10 筆）

```js
async function rv(offset, limit){  // limit 用 10
  const vars={request:{clientName:"web-performance-dash-reviews-search",
    arguments:{metricType:"QUALITY",groupBys:["RATING_CATEGORY"],groupByValues:["overall"]},
    componentArguments:[{componentName:"RECENT_REVIEWS_SECTION",arguments:{offset,limit}}],
    useStubbedData:false}};
  const ext={persistedQuery:{version:1,sha256Hash:"015be4eeaa5e444fa22bc0bf82688aa0f21028c3836b2e442c537a904c9d5e14"}};
  const u="https://www.airbnb.com/api/v3/ReviewsSectionQuery/015be4eeaa5e444fa22bc0bf82688aa0f21028c3836b2e442c537a904c9d5e14"
    +"?operationName=ReviewsSectionQuery&locale=zh-TW&currency=TWD"
    +"&variables="+encodeURIComponent(JSON.stringify(vars))
    +"&extensions="+encodeURIComponent(JSON.stringify(ext));
  const r=await fetch(u,{headers:{"X-Airbnb-Api-Key":"d306zoyjsyarp7ifhu67rjxn52tv0t20"},credentials:"include"});
  return (await r.json()).data.porygon.getPerformanceComponents.components[0];
}
```

**⚠️ `limit` 一定要用 10。** SKILL 舊版寫「上限是 50」已經不成立 —— `limit=50` 現在會永遠 pending（2026-09-03 實測，`limit=10` 是 800ms）。用 `rv(0,10)`、`rv(10,10)`…`rv(40,10)` 湊滿 50 筆，每次配一個 navigate。

結果的 `reviews[]` 每筆有：`id`、`title`(旅客名)、`subtitle`(住宿日期)、`metricUnits[0].valueString`(整體星等)、`comment`(原文)、`listingName`(中文房源名)。另有 `totalCount`。評價依時間新到舊排序。

注意：少數評價的 `listingName` 會是空字串（房源已下架），這是正常的，照送即可。

**這支只有整體星等。** 細節評分、私訊留言、房源 listing_id 都不在裡面 —— 那要步驟二之二。

## 步驟二之二：抓每則評價的詳情

列表端點缺的欄位（ERP 的 `reviews` 表**早就有這些欄位、畫面也早就在渲染**，只是一直沒人送）要另外打詳情端點：

```js
async function detail(reviewId){   // reviewId 是列表回的純數字 id
  const rid = btoa("StayListingReview:" + reviewId);
  const vars = { reviewId: rid, userId: "VXNlcjoyOTg5MTA0NTg=" };  // userId 是本帳號固定值
  const H = "9b32dd76b3eb7502b5eb35037b57d12b264e18011ad62edb2423b86e520dee19";
  const u = "https://www.airbnb.com/api/v3/HostReviewsSingleReviewRefreshedDesignQuery/" + H
    + "?operationName=HostReviewsSingleReviewRefreshedDesignQuery&locale=zh-TW&currency=TWD"
    + "&variables=" + encodeURIComponent(JSON.stringify(vars))
    + "&extensions=" + encodeURIComponent(JSON.stringify({persistedQuery:{version:1,sha256Hash:H}}));
  const r = await fetch(u,{headers:{"X-Airbnb-Api-Key":"d306zoyjsyarp7ifhu67rjxn52tv0t20"},credentials:"include"});
  return (await r.json()).data.presentation.hostReviews.ratingStatsAndReview;
}
```

從回傳的 `d` 取：

| 要送的欄位 | 來源 |
|---|---|
| `listingId` | `d.review.staySupplyListing.id` → base64 解出 `StaySupplyListing:<數字>`，**只送數字** |
| `nights` | `d.review.reservation.numberOfNights` |
| `lang` | `d.review.commentLanguage`（原文語言，`en`／`zh-TW`…）|
| `localized` | `d.review.localizedComment.localizedString`（**Airbnb 官方中文翻譯**）|
| `privateFb` | `d.review.privateFeedback`（只有房東看得到的留言）|
| `privateFbLoc` | `d.review.localizedPrivateFeedback.localizedString` |
| `cats` | `d.categoryStatsWithTagStats` → `{CHECKIN:4, CLEANLINESS:4, ACCURACY:4, COMMUNICATION:5, LOCATION:5, VALUE:4}` |
| `tags` | 同上 → `{CHECKIN:[{label:"入住說明清楚",intent:"POSITIVE"}], ...}` |
| `reply` | `d.review.response`（房東回覆，可能是 null）|

**只對「這次要新增的評價」打詳情** —— 用步驟一的 `recentIds` 做集合差集算出新的那些。既有評價每天重打一次是白費 50 個請求，而且它們的詳情不會變。

每個詳情請求同樣配一個 navigate，間隔 200ms。單筆失敗最多重試 2 次，仍失敗就**把該筆的詳情欄位整組留空**（不要送半套），並在回報裡列出來 —— 缺欄位比錯欄位好救。

## 步驟三：匯入 ERP

POST `https://justwork.estia.com.tw/api/import/reviews`
header：`content-type: application/json`、`x-import-key: <IMPORT_KEY>`

**每批最多 10 筆**（一次送 50 筆會讓分頁凍結期間的請求堆在一起）。body：

```json
{"reviews":[{
  "id":"...", "guest":"...", "stay":"...", "rating":4,
  "comment":"...", "listing":"...",
  "listingId":"947419509809418322", "nights":4,
  "lang":"en", "localized":"位置非常方便！",
  "privateFb":"...", "privateFbLoc":"...",
  "cats":{"CHECKIN":4,"CLEANLINESS":4,"ACCURACY":4,"COMMUNICATION":5,"LOCATION":5,"VALUE":4},
  "tags":{"CHECKIN":[{"label":"入住說明清楚","intent":"POSITIVE"}]},
  "reply":null
}]}
```

前六個欄位對應：`id`←id、`guest`←title、`stay`←subtitle、`rating`←整體星等(數字)、`comment`←comment、`listing`←listingName。其餘來自步驟二之二，**沒有就整個不要放這個鍵**（送 `null` 跟不送效果一樣，但不要送空字串）。

端點會自己解析住宿日期、對照房源、且**不會覆蓋已翻成中文的留言、也不會把既有的房源對應洗成 null**。回傳含 `upserted`、`inserted`、`updated`、`unmatched`、`unresolved`、`resolvedByOrder`、`needTranslation`。

**`listingId` 是房源對照的第一層。** 沒送的話端點只能靠「房客＋退房日」去訂單反查（第二層備援），回傳的 `resolvedByOrder` 就是靠備援救回來的筆數 —— **這個數字應該要接近 0**。持續偏高代表 `listingId` 沒送對，要先修這裡，不要放著讓備援扛。

## 步驟四：翻譯

`needTranslation` 是 `[{rid, src}]`。**先看 `localized`** —— 步驟二之二已經帶了 Airbnb 官方中文翻譯，端點會優先採用它，所以正常情況下這個清單會是空的。只有詳情抓失敗、或 Airbnb 沒給翻譯時才需要自己翻。

把每筆 `src` 翻成**繁體中文**：

- 原文若已是繁中，跳過不處理。
- 簡體中文要轉成繁體。
- 只翻譯內容，不要加任何前言、說明或引號。保留原意與語氣，不要美化或補充原文沒有的內容。

POST `https://justwork.estia.com.tw/api/import/translate`（同樣兩個 header）
body：`{"items":[{"rid":"...","comment":"翻譯後的繁中"}]}`

端點會擋掉不含中文的譯文，回傳 `updated` 與 `failed`。

## 步驟五：撤評哨兵

用步驟一取回的狀態判斷要不要對帳：

1. `dbCountAll` 為 0（首次執行）→ 跳過對帳。
2. `newCount` = 今天抓到的 50 筆裡，`id` 不在 `recentIds` 中的筆數。
   用**集合差集**，不要用「找某個 id 在第幾個」的位置比對 —— 中間有評價被刪掉時位置會算錯。
3. `newCount >= 50` → 一頁全是新的，代表可能還有更多沒抓到 → **執行全量對帳**。
4. `今天的 totalCount < dbCountAll` → **有評價從 Airbnb 消失了** → **執行全量對帳**。
   （新增的評價會讓 totalCount 變大，所以只要它比 DB 現有的少，就是有東西被撤下。）

   ⚠️ **這條目前每天都會誤觸發。** 2026-09-03 實測 `totalCount` 861 對 `dbCountAll` 1600 —— 差 738 筆不可能是撤評，是兩邊母體根本不同（儀表板 vs 含早期 CSV 的 DB 全量）。照跑會白跑 87 頁再被護欄擋成 `aborted_too_many`，而真的有撤評時反而分不出來。**修法待定，先照規則跑或先問使用者，不要自己改判準。**
5. `lastFullReconcile` 是 30 天前或更早、或為 null → 兜底 → **執行全量對帳**。
6. 其餘情況跳過對帳。

`lastFullReconcile` 由 ERP 的對帳端點自己記錄，這支不需要回寫。

## 步驟六：全量對帳（只在步驟五判定需要時執行）

依序呼叫 `rv(0,10)`、`rv(10,10)`、`rv(20,10)`…直到某頁回傳少於 10 筆。每頁配一個 navigate、間隔 200ms。單頁失敗最多重試 3 次，仍失敗就**中止整個對帳**，不要送出不完整的清單。

861 筆約 87 頁，跑很久。進度存 `sessionStorage`，中斷可續。

收集所有 `id`，然後：

POST `https://justwork.estia.com.tw/api/import/reconcile`（同樣兩個 header）
body：`{"ids":[全部id], "totalCount":<Airbnb的totalCount>, "scope":"auto", "dryRun":true, "maxDelete":5}`

**先跑 dryRun:true。** 回傳的 `rows` 就是「DB 有、Airbnb 沒有」的評價。

- `wouldDelete` 為 0 或 `deleted` 為 0 → 完成，無事發生（端點已記下對帳日期）。
- `wouldDelete` 大於 0 → **先把 `rows` 完整寫成 JSON 檔備份**到 `C:\Users\ASUS\Desktop\anxing-web\sync-backups\removed-reviews-<YYYY-MM-DD>.json`（硬刪除後 DB 不留痕跡，這個備份是唯一的稽核依據）。備份成功後，再用同樣的 body 但 `dryRun:false` 送一次，實際刪除。
- 回傳 4xx 且 error 是 `aborted_incomplete_fetch` / `aborted_ratio_guard` / `aborted_too_many` → 這是護欄擋下了異常，**不要嘗試繞過、不要調高 maxDelete**。直接把錯誤內容回報給使用者。

## 回報

簡短一段，包含：新增幾筆、更新幾筆、翻譯幾筆、有沒有跑對帳、刪除幾筆。

以下情況要明確點出來：

- **`unresolved` 非空** —— 這些房源名稱三層都對不到房源，`property_id` 會是空的。列出名稱，提醒到 `/admin` 補上房源的 `airbnb_listing_id`。
- **`unmatched` 非空** —— 列出那些 listing_id，同樣需要補設定。
- **`resolvedByOrder` 明顯大於 0** —— `listingId` 沒送對，列出來。
- **詳情抓失敗的評價** —— 列出 id，那幾筆的細節評分與私訊留言會是空的。
- **HTTP 非 2xx 或步驟中途失敗** —— 直接回報原始錯誤，不要自行重試繞過，也不要改用 curl / python 等其他方式抓取。

沒有任何異常時就寫一兩句話帶過，不要長篇報告。
