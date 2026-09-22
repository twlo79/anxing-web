/**
 * 發票登錄的格式規則（`invoices` 那張表）。
 *
 * ============================================================
 * 【為什麼寫在 `.ts` 而不是頁面裡】
 *
 * 測試執行環境不處理 JSX（CLAUDE.md）—— 寫在 `.tsx` 裡的判斷式測不到。
 * 而這裡的規則對應的是**資料庫的 check 約束**：寫錯不會在 tsc 被擋，
 * 只會在使用者按下儲存的那一刻跳一句英文出來。
 *
 * ============================================================
 * 【★★★ 2026-09-22：加費的發票從來沒存進去過】
 *
 * `invoices_ym_chk` 是 `ym ~ '^[0-9]{6}$'` —— **六碼、沒有連字號**。
 * 而契約頁的加費那一列算月份時寫成：
 *
 *     const feeYm = String(f.checkin ?? '').slice(0, 7);   // '2026-08' ← 七碼，有橫線
 *
 * 同一個檔案往上四十行，那一期的 `pfees` 篩選用的卻是正確的六碼寫法
 * （`f.checkin.slice(0,4) + f.checkin.slice(5,7)`）——
 * **同一條規則在同一個檔案裡寫了兩次，兩個答案**（CLAUDE.md 的老坑）。
 *
 * 症狀：按「開發票」→ 填好 → 儲存 →
 * `new row for relation "invoices" violates check constraint "invoices_ym_chk"`。
 * 而月租單那條路正常，因為它的 `ym` 是從 `chunk` 的 `m.ym` 直接來的。
 *
 * ★ 所以格式與訊息收到這裡來，兩頁共用一份。
 * ============================================================
 */

/** 統一發票號碼：2 碼英文 ＋ 8 碼數字。 */
export const INV_NO_RE = /^[A-Z]{2}[0-9]{8}$/;

/**
 * 認列月份：**六碼、沒有連字號**。
 *
 * ★★ 這一條跟資料庫的 `invoices_ym_chk` 是同一條。改這裡的話
 *   那條 check 也要一起改 —— 只改一邊的話畫面會放行而資料庫擋下來。
 */
export const INV_YM_RE = /^[0-9]{6}$/;

/**
 * `2026-08-31` → `202608`。
 *
 * ★ 就是 `period.ts` 的 `ymOf` —— 這裡不再有第二份實作（2026-09-22 收成一支）。
 *   保留這個名字是因為「發票的月份」讀起來比「認列月份」直白，兩個呼叫端都用它。
 */
export { ymOf as invYm } from './period.ts';

/** 一張要存的發票。欄位名跟 `invoices` 一致。 */
export type InvoiceDraft = {
  /** 六碼年月 */
  ym?: string | null;
  invoice_no?: string | null;
  invoice_date?: string | null;
};

/**
 * 存檔前的檢查。回**第一個**錯誤訊息，沒問題回 null。
 *
 * ★★ 一次只回一句。全部列出來會變成一段文章，而人只看第一行
 *   （跟 `validateAdvance()` 同一個做法）。
 *
 * ★★★ `ym` 那一條的訊息**不能寫「月份格式錯誤」** —— 使用者的畫面上
 *   根本沒有「月份」這一格（它是從加費那一列的日期推出來的）。
 *   訊息要指著他看得到的東西，不然他會去找一個不存在的欄位
 *   （CLAUDE.md：標籤字要跟畫面上的一模一樣）。
 */
export function invoiceMissing(v: InvoiceDraft): string | null {
  const no = (v.invoice_no ?? '').trim().toUpperCase();
  if (!INV_NO_RE.test(no)) return '發票號碼格式應為 2 碼英文 + 8 碼數字，例 AB12345678';
  if (!(v.invoice_date ?? '').trim()) return '請填開票日期';
  if (!INV_YM_RE.test((v.ym ?? '').trim())) {
    return '這一列沒有日期，算不出要認列到哪個月 —— 先把那一筆的日期補上再開發票';
  }
  return null;
}
