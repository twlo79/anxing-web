/**
 * 新增備品品項的驗證。
 *
 * ============================================================
 * 【為什麼抽出來】（2026-09-07 使用者:「備品 必填 紅色*，表單最上方必填日期」）
 *
 * 原本只擋了物資名稱一項，其餘全部可以空著送出。空著的後果:
 *
 *   · 沒有規格 → 同一個名稱下次還會再建一次（唯一索引是「名稱＋規格」,
 *                 規格空白與規格「大包裝」是兩筆,於是清單上出現兩個衛生紙）
 *   · 沒有初始庫存 → 那一筆 supply_txn 不會寫,品項建好卻是 0,
 *                     而人以為自己填的數量進去了
 *
 * ★ 驗證寫在 `.ts` 才測得到（測試環境不處理 JSX，見 CLAUDE.md）,
 *   而且按鈕的 disabled 與送出前的檢查共用同一支,不會漂。
 */

export type NewSupplyItem = {
  /** 日期。初始庫存那一筆流水的 `happened_on`。 */
  on: string;
  name: string;
  spec: string;
  vendor: string;
  expire_on: string;
  /** 初始庫存。**字串**，因為空字串與 0 是兩件事（見下）。 */
  init: string;
};

/**
 * 填完整了沒。**回錯誤訊息，沒問題回 `null`。**
 *
 * ★★★ 初始庫存用**字串**判斷空白，不能先 `Number()` 再比大小 ——
 *   `Number('')` 是 **0**，所以「完全沒填」會通過 `>= 0` 的檢查,
 *   而它跟「明確填 0」在畫面上差很多:
 *
 *     填 0   → 這個品項現在沒有庫存（是一個答案）
 *     沒填   → 還不知道有多少（不是答案）
 *
 *   放行的話品項建好、庫存是 0，而填表的人記得自己填過數字。
 *
 * ★ 訊息一次講一項，照欄位由上到下的順序 —— 一次列全部的話，
 *   使用者要在一句話裡找出自己漏了哪一格。
 */
export function newItemError(a: NewSupplyItem): string | null {
  if (!a.on) return '要填日期';
  if (!a.name.trim()) return '要填物資名稱';
  if (!a.spec.trim()) return '要填規格型號';
  if (a.init.trim() === '') return '要填初始庫存（沒有就填 0）';

  const n = Number(a.init);
  if (!Number.isFinite(n) || n < 0) return '初始庫存要是 0 或正數';
  return null;
}

/**
 * 初始庫存要不要寫一筆流水。
 *
 * ★ 填 0 **不寫** —— 「現在沒有」是一個答案，但記一筆數量 0 的流水
 *   只會讓那個品項的歷史多一行雜訊。必填的是「回答這一格」，
 *   不是「一定要有庫存」。
 */
export function needsInitTxn(init: string): boolean {
  const n = Number(init);
  return init.trim() !== '' && Number.isFinite(n) && n > 0;
}
