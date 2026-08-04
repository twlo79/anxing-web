# archive — 封存區

這裡放**已經完成任務、但不該直接刪掉**的東西。

刪掉和封存的差別在於：這些檔案是某些歷史資料的唯一說明。哪天營收數字對不起來、要回頭確認「當初是怎麼匯進去的」，答案在這裡。git 歷史也查得到，但要知道去哪一個 commit 翻才行。

**這裡的東西不會被編譯、不會被 Next.js 當成路由、不參與 build。**
搬回去才會生效 —— 而搬回去之前請先讀完下面那一段為什麼它被搬走。

---

## `seed-2026-07/` — 一次性匯入

2026 年 7 月上線時，把舊系統的資料一次搬進來用的。

```
data/    general_contracts.json    一般契約
         zl_contracts.json         正隆契約
         shortterm_orders.json     短租訂單（504 KB）
         snapshots.json            營收快照（839 KB）
routes/  contracts-general/  contracts-seed/  shortterm-seed/  snapshots/
```

**為什麼收起來**

資料早就匯完了，這四支端點的任務結束了。但它們**沒有防重跑機制** —— 沒有「已執行過就拒絕」的判斷，也沒有 `on conflict` 保護。帶著正確的 `x-import-key` 呼叫第二次，就會產生一整批重複的訂單與營收。

一個只會用一次、卻能造成大範圍損害的端點，留在線上是純風險，沒有對應的好處。順帶省下 1.3 MB 的 build 產物。

**真的要重跑的話**

先確認為什麼要重跑 —— 通常「重跑 seed」不是對的解法，補單筆資料才是。若確定要：

1. 把 `routes/<名稱>/` 搬回 `src/app/api/import/`
2. 把 `data/*.json` 搬回 `src/data/`
3. `npm run build` 確認過再部署
4. **跑之前先確認目標表是空的**，或自己加去重條件
5. 跑完再搬回這裡

---

## `migrations-pre-30/` — 版控之前的 migration

```
migration_28_auto_renew.sql   contracts.auto_renew
migration_29_watch.sql        contracts.watch / display_name
```

30 號之前的 migration 沒有系統性進版控（見 README 的〈已知缺口〉），這兩支是唯二留下來的，而且掉在專案根目錄，不在 `supabase/migrations/` 裡。

線上早就跑過了 —— 那三個欄位現在都存在，`supabase/schema-baseline.sql` 裡查得到。**不要再跑一次**（雖然都是 `add column if not exists`，重跑不會壞，但也沒有意義）。

留著是因為它們解釋了那三個欄位的來歷：`auto_renew` 是契約到期後自動續產月租單，`watch` 是把契約釘選到「本月已收/未收」清單。這種「為什麼有這個欄位」的資訊，schema 快照裡看不到。
