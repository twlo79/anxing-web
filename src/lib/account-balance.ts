/**
 * 帳戶明細：卡片與合計上的「這個帳戶現在有多少錢」—— **全站唯一一份規則**。
 *
 * 規則（2026-10-05 David：「以最後的數字為準」）：
 *   ① 有流水 → 最後一筆流水的餘額（跟表格最上面那一列同一個數）
 *   ② 沒有流水 → 銀行帳戶退回最新對帳單的期末；現金帳戶退回期初
 *
 * 【歷程 —— 為什麼要釘成一支函式】
 *   · 2026-08-18 上線（migration_142）：銀行卡片讀「最新對帳單的期末」。當時流水全部來自對帳單，
 *     兩個數字一定相同，所以沒有人發現它們其實是兩個來源。
 *   · 2026-08-31：現金帳戶沒有對帳單 → 改讀最後一筆流水（只改了現金那一條路）。
 *   · 2026-10-05：第一次在對帳單之後記了流水（8088→4145 三筆調撥），銀行卡片停在對帳單期末，
 *     24145 卡片 2,728,106 vs 表格 4,775,684。→ 兩條路合成這一支。
 * ★★ 畫面上不准再寫 `closing_balance` 當卡片餘額 —— 有測試釘著（account-balance.test.ts）。
 */
export function cardBalance(a: {
  manual: boolean;
  /** 最後一筆流水的 balance；沒有流水是 undefined */
  lastTxnBalance?: number | null;
  /** 最新對帳單的期末；沒上傳過是 undefined */
  stmtClosing?: number | null;
  /** 現金帳戶的期初 */
  opening?: number | null;
}): number | null {
  if (a.lastTxnBalance != null) return Number(a.lastTxnBalance);
  if (a.manual) return Number(a.opening) || 0;
  return a.stmtClosing != null ? Number(a.stmtClosing) : null;
}

/** 卡片餘額跟對帳單期末不一樣時（對帳單之後又記了流水），卡片下面要說出對帳單的數字 */
export function stmtDiffers(card: number | null, stmtClosing?: number | null): boolean {
  return card != null && stmtClosing != null && Math.round(card) !== Math.round(Number(stmtClosing));
}
