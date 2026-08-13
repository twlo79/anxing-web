/**
 * 必填欄位（純函式）。
 *
 * ============================================================
 * 【為什麼要有一份共用的】
 *
 * 每張表單原本都在 save() 裡自己寫一串：
 *
 *     if (!edit.spent_on) return flash('請填支出日期');
 *     if (!edit.item_name.trim()) return flash('請填支出項目');
 *
 * 那樣有三個問題：
 *
 *   1. **一次只講一個。** 缺三個欄位就要按三次儲存才知道總共缺什麼。
 *   2. **畫面上看不出來。** 訊息說「請填支出項目」，但十幾個欄位裡
 *      哪一格是「支出項目」還是要自己找。
 *   3. **星號沒有依據。** 標籤上要不要加 `*` 得另外判斷一次，
 *      而那份判斷跟 save() 裡的很容易漂移 —— 標了星號卻不擋，
 *      或是擋了卻沒標，兩種都會讓使用者不再相信那個星號。
 *
 * 改成宣告一份清單之後，**訊息、紅框、星號用的是同一份答案**。
 *
 *
 * ============================================================
 * 【填了沒有，要看欄位的型別】
 *
 * 金額的 0 跟文字的空字串是不同的東西 —— 而 `!0` 跟 `!''` 都是 true，
 * 混在一起判斷的話，「數量填 0」會被當成沒填，
 * 而那在某些表單（折讓、加費）是合法的輸入。
 */

export type ReqField = {
  /** 顯示在訊息裡的名稱，也是紅框的比對鍵 */
  label: string;
  value: unknown;
  /**
   * text  去頭尾空白之後不能是空的（只打空白等於沒填）
   * money 必須大於 0
   * any   不能是 null / undefined / 空字串（0 與 false 算有填）
   */
  kind?: 'text' | 'money' | 'any';
  /** 條件式必填。false 時這一欄不檢查（例如「匯款才需要帳號」） */
  when?: boolean;
};

export function isFilled(f: ReqField): boolean {
  const { value, kind = 'text' } = f;
  if (kind === 'money') return Number(value) > 0;
  if (kind === 'any') return value !== null && value !== undefined && value !== '';
  return String(value ?? '').trim() !== '';
}

/**
 * 缺哪些欄位。全部填齊回空陣列。
 *
 * 順序照傳進來的順序 —— 那通常就是畫面上由上到下的順序，
 * 使用者照著訊息往下找的時候不用跳來跳去。
 */
export function missingFields(fields: ReqField[]): string[] {
  return fields.filter((f) => f.when !== false && !isFilled(f)).map((f) => f.label);
}

/**
 * 擋下來的那句話。
 *
 * 【為什麼把缺的全部列出來】
 * 一次講一個的話，使用者要按四次儲存才知道總共缺什麼 ——
 * 而每按一次都是一次「又失敗了」的挫折。
 *
 * 【為什麼開頭要有「無法儲存」】
 * 各頁的 flash() 是靠訊息內容判斷紅色或綠色的（/失敗|錯誤|不能|無法/）。
 * 沒有那幾個字的話，這句會用綠色顯示兩秒半就消失 ——
 * 一個看起來像成功的失敗訊息。
 */
export function missingMessage(missing: string[]): string {
  return `無法儲存,還沒填：${missing.join('、')}`;
}
