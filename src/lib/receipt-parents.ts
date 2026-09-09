/**
 * 憑證掛在哪一層，以及**誰要借看哪幾層**。
 *
 * ============================================================
 * 【★★★ 這支存在的理由】（2026-09-09）
 *
 * 2026-08-04 做「憑證連動」:請款單的照片帶到支出頁顯示。
 * 那時候憑證只有一種掛法（整張單 `request_id`），所以借一層就夠了。
 *
 * 2026-08-24 做「逐項憑證圖片」（migration_172），多了第二種掛法
 * （`request_item_id`）。那次動了請款頁 213 行、`Receipts.tsx` 10 行、
 * 一支 migration —— **但沒有動支出頁**。
 *
 * 結果:8/24 之後逐項上傳的憑證，在支出頁**從來沒有顯示過**，
 * 而畫面上寫的是「尚未上傳」——
 * 「真的沒傳」跟「傳了但在另一層」給的是同一個答案。
 *
 * 使用者是一個月後才發現的（2026-09-09:「上傳圖片檔案不見了」），
 * 而且第一直覺是「資料被刪了」。查下去圖片一張都沒少。
 *
 * ============================================================
 * 【★★ 為什麼把「借看哪幾層」抽出來】
 *
 * `Receipts.tsx` 裡那張 kind → 欄位的對應表本來就是單一來源，很好。
 * 壞掉的是**另一半**:「支出要借看哪幾層」寫在 `expenses/page.tsx`
 * 的 JSX 屬性裡 —— 一個沒有名字、沒有測試、grep 不到的知識。
 *
 * ★★★ 新增一種請款側的掛法時，底下的測試會失敗並且告訴你要改哪裡。
 *   這是唯一能擋住「加了新抽屜卻沒人去開」的東西。
 */

/** 憑證可以掛在哪些母體上。★ 跟 `Receipts.tsx` 的 `col` 對應表是同一份知識。 */
export const RECEIPT_COL = {
  /** 整張請款單 */
  pr: 'request_id',
  /** 單一請款項目（migration_172，2026-08-24）*/
  pri: 'request_item_id',
  /** 支出自己的 */
  exp: 'expense_id',
  /** 押金 */
  dep: 'deposit_id',
  /** 短租收款證明（migration_85）*/
  op: 'order_payment_id',
  /** 押金某一筆收款（migration_147）*/
  dp: 'deposit_payment_id',
  /** 加費的憑證（migration_158）*/
  of: 'order_id',
  /** 標案 */
  td: 'tender_id',
  /** 現金流水的收據 */
  cash: 'bank_transaction_id',
} as const;

export type ReceiptKind = keyof typeof RECEIPT_COL;

/**
 * **請款側**的掛法 —— 一筆支出可能從這幾層繼承憑證。
 *
 * ★ 判斷標準:這一種掛法的母體，會不會產生一筆支出？
 *   會的話支出頁就該看得到它的憑證。
 */
export const REQUEST_SIDE_KINDS: readonly ReceiptKind[] = ['pr', 'pri'];

/**
 * 支出頁**實際借看**的那幾層。
 *
 * ★★★ 這裡少一項，那一層的憑證在支出頁就永遠是「尚未上傳」——
 *   而且不會報錯。底下的測試釘的就是
 *   「REQUEST_SIDE_KINDS 裡的每一種都要在這裡」。
 */
export const EXPENSE_INHERITS: readonly ReceiptKind[] = ['pr', 'pri'];

/**
 * 沒有憑證時該說什麼。
 *
 * ★★ 不要一律說「尚未上傳」。這筆支出如果來自請款單，
 *   憑證很可能在那邊 —— 說「尚未上傳」等於替使用者下了一個錯的結論，
 *   而他會去重傳一張（於是同一張發票存了兩份）。
 */
export function emptyReceiptText(o: {
  /** 這筆支出是不是請款單帶進來的 */
  fromRequest: boolean;
  /** 這個人能不能在這裡上傳。★ 不能傳的話就不要教他怎麼傳 */
  canEdit?: boolean;
}): string {
  if (o.fromRequest) {
    return '沒有憑證圖片。這筆來自請款單 —— 請款單上如果有，這裡會一起顯示。';
  }
  return o.canEdit ? '尚未上傳，手機可直接拍照' : '尚未上傳';
}
