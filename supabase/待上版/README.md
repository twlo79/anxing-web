# 待上版（先不推）

2026-09-22 架構體檢的 🔴1「多步寫入沒有交易」修法。**已寫完、本機驗證過，但沒上線** ——
David 指定：高風險的先不推、不動，之後再上版。`deploy.ps1` 不會碰這個資料夾。

## 裡面有什麼

| 檔案 | 做什麼 | 取代掉的前端多步寫入 |
|---|---|---|
| `migration_292_earnest_rpc.sql` | `forfeit_earnest(p_dep, p_on)`、`convert_earnest(p_dep, p_on)` | `deposits/page.tsx` 沒收／轉租金：改押金 → 建收入 → 改訂單，三個請求 |
| `migration_293_supply_count_rpc.sql` | `save_supply_count(p_ym, p_on, p_rows)` | `housekeeping/supply-tab.tsx` 盤點存檔：刪舊列 → 建新列 |
| `migration_294_demand_to_request_rpc.sql` | `demand_to_request(p_demand, p_items)` | `housekeeping/demand-tab.tsx` 需求轉採購單：建單 → 建明細 → 改需求狀態 |
| `migration_295_move_order_rpc.sql` | `move_order(p_grp, p_segs, p_patch)` | `shortterm/page.tsx` 移房：刪段 → 建段 → 改單 |
| `migration_296_save_pr_rpc.sql` | `save_purchase_request(p_id, p_header, p_items)` → 回 `new_ids` | `purchases/page.tsx` 採購單存檔：改單頭 → 刪明細 → 建明細 |
| `rpc前端/*.tsx.txt` | 上面五頁改成呼叫 RPC 的完整版本 | — |

每支 RPC 都是 `security invoker`（RLS 照擋）、每一步 `get diagnostics` 數影響列數、0 列就 raise 整支回滾；
前端送來的推導值（時數、差額）在資料庫再算一次，不一致回 `HOURS_MISMATCH` / `DIFF_MISMATCH`。

## 為什麼先不上

這五頁現在的寫法是「三個請求各自一個交易」——中間斷掉會留半套資料。
修法對，但**換的是五個最常用的存檔按鈕**，改壞了一次影響五頁。
現在沒有人在報這五頁壞掉，所以先把低風險的推完、觀察一輪，再上這批。

## 要上版的時候怎麼做

1. 五支 migration 搬回 `supabase/migrations/`，**照 292→296 順序**貼進 SQL Editor 跑；每支結尾的自檢表要看得到（看不到 ＝ 整支回滾）。
2. 跑完先確認：`select name from schema_migrations where name >= '292' order by name;` 五列都在。
3. 前端五支 `.txt` 複製回原路徑（去掉 `.txt`）：

   | 搬回去 | 原路徑 |
   |---|---|
   | `rpc前端/deposits-page.tsx.txt` | `src/app/(app)/deposits/page.tsx` |
   | `rpc前端/purchases-page.tsx.txt` | `src/app/(app)/purchases/page.tsx` |
   | `rpc前端/shortterm-page.tsx.txt` | `src/app/(app)/shortterm/page.tsx` |
   | `rpc前端/housekeeping-supply-tab.tsx.txt` | `src/app/(app)/housekeeping/supply-tab.tsx` |
   | `rpc前端/housekeeping-demand-tab.tsx.txt` | `src/app/(app)/housekeeping/demand-tab.tsx` |

   ★ 搬之前先 `git diff HEAD -- 那五個檔`：如果原檔在這段期間又被改過，`.txt` 是舊底稿，要重新套而不是直接覆蓋。
4. `npx tsc --noEmit --skipLibCheck` ＋ 測試全綠。
5. **順序不能反**：migration 先、前端後。前端先推的話，五頁會呼叫不存在的函式，存檔全部失敗。
6. 上線後每頁各按一次存檔，確認資料有寫進去（RPC 在 RLS 底下回 0 列會 raise，不會安靜成功）。
7. 確認沒問題後刪掉這個資料夾。
