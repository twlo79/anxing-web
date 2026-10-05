/**
 * 分頁記在網址上（2026-10-05 David：「重新整理後都會回到行事曆，可以都在自己那頁嗎？」）。
 *
 * `<Tabs urlKey="tab">` 用：點分頁時把 `?tab=xxx` 寫進網址（replaceState，不多一筆上一頁），
 * 重新整理或把連結丟給別人時，從網址讀回來。
 * ★ 認不得的值一律不理（回 null）—— 舊連結、打錯字，都安靜地留在預設分頁，不會變成空白。
 */
export function tabFromSearch(search: string, key: string, keys: readonly string[]): string | null {
  const v = new URLSearchParams(search).get(key);
  return v && keys.includes(v) ? v : null;
}

/** 把分頁寫進網址；其他參數原樣留著 */
export function searchWithTab(search: string, key: string, value: string): string {
  const sp = new URLSearchParams(search);
  sp.set(key, value);
  const s = sp.toString();
  return s ? `?${s}` : '';
}
