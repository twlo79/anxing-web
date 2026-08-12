/**
 * 公告編輯的判斷邏輯（純函式）。
 *
 * 【為什麼「要不要重新通知」是人決定，不是程式猜】
 *
 * 改了開會時間 → 全公司都要重看。
 * 改了一個錯字 → 不該讓十幾個人的畫面又冒出未讀圓點。
 *
 * 程式分不出這兩件事 —— 兩者都只是 body 變了。硬要猜的話，
 * 猜錯的方向都很糟：該通知的沒通知（有人照舊週三到），
 * 或者每次改錯字都驚動全公司（幾次之後就沒有人理未讀圓點了，
 * 那才是真正的損失 —— 通知機制一旦被當成雜訊就再也叫不動人）。
 *
 * 所以程式只做一件事：**內容變了就把選項預設打開**，
 * 由按下編輯的那個人決定。他知道自己改了什麼。
 */

/**
 * 比對用的正規化：去頭尾空白、把連續空白折成一個。
 *
 * 不做這一步的話，游標亂點多打一個空格、或貼上時多一個換行，
 * 都會被當成「內容變了」—— 而使用者完全不知道自己改了什麼。
 */
export function normalizeText(s: string | null | undefined): string {
  return (s ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * 標題或內容真的變了嗎。
 *
 * 置頂、顯示中不算 —— 那些是排列與可見性，不是「講的話變了」。
 * 把公告下架再上架不該要求所有人重看一次。
 */
export function noticeContentChanged(
  before: { title?: string | null; body?: string | null } | null | undefined,
  after: { title?: string | null; body?: string | null },
): boolean {
  if (!before) return false;   // 新發布的公告本來就是全員未讀，不用「重設」
  return normalizeText(before.title) !== normalizeText(after.title)
      || normalizeText(before.body) !== normalizeText(after.body);
}
