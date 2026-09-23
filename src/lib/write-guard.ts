/**
 * 寫入之後：到底有沒有改到列（CLAUDE.md 第一條坑）。
 *
 * ============================================================
 * 【★★★ 為什麼需要這支】
 *
 * PostgREST 的 UPDATE／DELETE 被 RLS 擋下來時 **回成功、影響 0 列**。
 * 沒有 `.select('id')` 的話連「影響幾列」都拿不到 —— 程式看到的是
 * `{ error: null }`，於是畫面說存好了，而資料庫什麼都沒變。
 *
 * 症狀永遠一樣：**按下去數字變了，重新整理又跳回去。**
 * 使用者的結論是「這個系統存不住東西」，而 console 一個錯誤都沒有。
 *
 * ★★ 「0 列」不一定是權限。關帳守衛、`where` 條件對不上、
 *   那一列剛被別人刪掉 —— 都是 0 列。所以訊息講「多半是」，不要斷定。
 *
 * ★★★ 有樂觀更新的地方**還要把畫面收回去**（`rollback`）。
 *   只跳訊息、留著那個假數字，比沒改更糟 ——
 *   使用者會關掉訊息然後繼續相信畫面上的數字
 *   （2026-09-03 `hk_day.rooms_override` 那次就是這樣過了三個月）。
 *
 * 【為什麼寫在 .ts】測試環境不處理 JSX（CLAUDE.md）。這支被 30 幾個地方呼叫，
 * 規則錯一次就是 30 幾個地方一起錯 —— 那正是要有測試的東西。
 */

/** PostgREST 回來的形狀（`.select('id')` 之後）。只取要判斷的兩欄 */
export type WriteRes = {
  data?: unknown[] | null;
  error?: { message?: string | null } | null;
};

/**
 * 回第一個問題，沒問題回 null。
 *
 * @param res  `await supabase.from(…).update(…).eq(…).select('id')` 的回傳
 * @param what 這個動作叫什麼（「儲存」「刪除」「收款」）—— 會出現在訊息開頭
 */
export function writeError(res: WriteRes | null | undefined, what = '更新'): string | null {
  if (!res) return `${what}失敗：沒有收到回應。`;
  if (res.error) return `${what}失敗：${res.error.message ?? '未知錯誤'}`;
  // ★ data 是 undefined ＝ 呼叫端忘了 `.select('id')`，不是「成功」
  if (res.data == null) return `${what}沒有回傳影響的列 —— 查詢少了 .select('id')，無法確認有沒有寫進去。`;
  if (!Array.isArray(res.data) || res.data.length === 0) {
    return `${what}沒有改到任何一列 —— 多半是權限或關帳。請重新整理後確認。`;
  }
  return null;
}

/** 真的改到列了嗎 —— 只要一個布林時用這支 */
export function wrote(res: WriteRes | null | undefined): boolean {
  return writeError(res) === null;
}

/**
 * 影響了幾列。預期筆數對不上時用這支報數字
 * （例如「只有 3/5 張套到金額」）。`.select('id')` 沒接時回 null。
 */
export function rowsWritten(res: WriteRes | null | undefined): number | null {
  if (!res || res.error || res.data == null || !Array.isArray(res.data)) return null;
  return res.data.length;
}
