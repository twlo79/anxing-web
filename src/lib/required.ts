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

/* ══════════════════════════════════════════════════════════
 * 送出鈕的閘門
 * ══════════════════════════════════════════════════════════
 *
 * 【★★★ 為什麼不能真的 disabled】（David 指定，2026-09-10）
 *
 * 使用者要的是兩件事:「沒填不能送出」＋「沒填的框要標紅」。
 * 直覺是把按鈕 `disabled` —— **但那兩件事會互相打架**:
 *
 *   紅框是「按下儲存」之後才出現的（見 components/Req.tsx:
 *   空表單一打開就整片紅，那是指責不是提示）。
 *   按鈕真的 disabled 就按不下去 → `tried` 永遠是 false
 *   → **紅框永遠不會出現**。
 *
 * 結果是一顆灰按鈕，而使用者不知道是哪一格漏了 ——
 * 比現在還糟:現在至少按下去會跳一句話。
 *
 * ★★ 所以用 `aria-disabled` 而不是 `disabled`:
 *   看起來是灰的、讀螢幕會念「已停用」、但**點得下去**。
 *   點下去不送出，而是把 `tried` 打開 → 紅框全部亮起來 ＋ 跳訊息。
 *
 * ★ 這一條**不適用於 `saving`**。存檔進行中要用真的 `disabled` ——
 *   那時候按下去該什麼都不發生，不是「告訴你缺什麼」。
 */

export type Gate = {
  /** 擋不擋。true = 這一按不會送出，只會標紅 */
  blocked: boolean;
  /** 滑鼠停留時說的話。★ 一定要講出缺哪幾欄，不是「請填必填欄位」 */
  title: string;
  /** 要不要畫成灰的 */
  dim: boolean;
};

/**
 * 算出送出鈕現在該長什麼樣。
 *
 * @param missing 缺的欄位（`missingFields()` 的結果）
 * @param busy    存檔進行中
 *
 * ★★ `busy` 時 `blocked` 也是 true —— 存檔中按第二次不該做任何事。
 *   但那時候的 title 講的是「儲存中」，不是「還沒填」:
 *   兩個都灰，理由不一樣，說出來的話就要不一樣。
 */
export function submitGate(missing: string[], busy = false): Gate {
  if (busy) return { blocked: true, title: '儲存中⋯', dim: true };
  if (missing.length) {
    return {
      blocked: true,
      // ★ 跟 missingMessage 分開:那句是跳出來的訊息（要有「無法儲存」
      //   才會顯示成紅色），這句是滑鼠停留的提示，短一點比較好讀
      title: `還沒填：${missing.join('、')}`,
      dim: true,
    };
  }
  return { blocked: false, title: '', dim: false };
}

/**
 * 灰掉的樣子。**不要用 `disabled:` 開頭的 Tailwind class** ——
 * 那一組只在真的 `disabled` 時生效，而這裡刻意沒有 disabled。
 */
export const gateCls = (dim: boolean) =>
  (dim ? 'opacity-40 cursor-not-allowed' : '');
