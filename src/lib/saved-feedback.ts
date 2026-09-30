/**
 * 存檔成功 —— 全站同一套（2026-09-30 David：「送出表單存成功就要跳出，所有行為都要統一，參考訂單、契約」）。
 *
 * ============================================================
 * 【三件事，每一頁都一樣】（過審的稿子：存檔成功-全站統一-UI稿.html）
 *
 *   ① 視窗關掉            —— 各頁自己做（setEdit(null) 那一行）
 *   ② 上方跳出綠色一句      —— `savedToast('已儲存：PR-202609-048')`，2.5 秒自己走
 *   ③ 那一列標黃「剛剛儲存」 —— `useJustSaved()` ＋ 列上掛 `justRow(isJust(id))`，45 秒後收掉
 *
 * 【② 為什麼走全站一個 toast，不用各頁自己的訊息】
 *   2026-09-30 請款單：成功訊息畫在頁面最上方，而編輯視窗（z-50）整個蓋在上面 ——
 *   存成功了也看不到，使用者以為沒存進去。各頁的訊息位置五花八門，
 *   一個一個修永遠會漏一頁。`(app)/layout.tsx` 掛一個 `<SavedToast />`（z-[60]，在所有視窗之上），
 *   各頁只要丟一個事件。
 *
 * 【③ 重新整理就不見】標記只在記憶體裡（React state），不進資料庫、不進 localStorage ——
 *   隔天打開還寫著「剛剛儲存」的話，那句話就變成謊話（lib/just-saved.ts 同一個理由）。
 *
 * 【為什麼 ② 的事件名稱與文字規則寫在 .ts】測得到（saved-feedback.test.ts）。
 */

/** 全站 toast 聽的事件名。改這個字串要連 SavedToast 一起改 */
export const SAVED_EVENT = 'anxing:saved';

/** 綠字停多久 */
export const SAVED_TOAST_MS = 2500;

/** 標黃那一列的底色（跟訂單頁同一組，表格與手機卡片共用） */
export const SAVED_HL = 'bg-amber-50 ring-1 ring-inset ring-amber-300';

/**
 * 綠色那一句要寫什麼。
 * ★ 帶上那一筆的名字或單號 —— 只寫「已儲存」的話，連按兩筆的時候分不出是哪一筆。
 * ★ 名字太長就截斷（toast 只有一行寬）。
 */
export function savedText(verb: string, name?: string | null, max = 28): string {
  const v = (verb || '已儲存').trim();
  const n = (name ?? '').replace(/\s+/g, ' ').trim();
  if (!n) return v;
  return `${v}：${n.length > max ? n.slice(0, max - 1) + '⋯' : n}`;
}

/** 丟給全站 toast。伺服器端（沒有 window）什麼都不做 */
export function savedToast(text: string): void {
  if (typeof window === 'undefined' || !text) return;
  window.dispatchEvent(new CustomEvent(SAVED_EVENT, { detail: text }));
}

/** 列上要掛的屬性：`<tr {...justRow(isJust(r.id))}>` —— 畫面會捲到有這個屬性的那一列 */
export function justRow(on: boolean): { 'data-just-saved'?: '1' } {
  return on ? { 'data-just-saved': '1' } : {};
}
