# 已上版（2026-09-23）—— 這個資料夾可以刪了

架構體檢 🔴1 的五支 RPC 已經上線：

* **migration 292～296** 已搬到 `supabase/migrations/`，2026-09-23 在 SQL Editor 跑完，五支自檢全綠
  （五支函式都在、都是 `security invoker`、跑的當下沒有動任何一列資料）
* **前端五頁**已經改成呼叫 RPC，跟著同一次 commit 推出去

`rpc前端/*.tsx.txt` 是當時的底稿，**已經套用完畢**（套的時候有重新合併 09-22 技術債那批的改動，
不是直接複製）。留著只會讓下一個人以為還有東西沒上 —— **整個資料夾刪掉即可**。

| 底稿 | 已套用到 |
|---|---|
| `rpc前端/deposits-page.tsx.txt` | `src/app/(app)/deposits/page.tsx` |
| `rpc前端/purchases-page.tsx.txt` | `src/app/(app)/purchases/page.tsx` |
| `rpc前端/shortterm-page.tsx.txt` | `src/app/(app)/shortterm/page.tsx` |
| `rpc前端/housekeeping-supply-tab.tsx.txt` | `src/app/(app)/housekeeping/supply-tab.tsx` |
| `rpc前端/housekeeping-demand-tab.tsx.txt` | `src/app/(app)/housekeeping/demand-tab.tsx` |
