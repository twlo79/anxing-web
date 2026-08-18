/**
 * 通知種類與顯示文字。
 *
 * 【為什麼跟 lib/push 分開兩個檔案】
 * lib/push 頂層 `import webpush from 'web-push'` —— 那是 Node 專用套件
 * （用到 crypto、http）。通知設定頁是 client component，
 * 從那裡匯入任何東西都會把 web-push 整包拉進瀏覽器的 bundle。
 *
 * 症狀是 **tsc 完全不會報錯**，`next build` 才在打包階段掛掉，
 * 或是安靜地讓首頁多背幾百 KB 永遠用不到的程式碼。
 *
 * 所以純資料放這裡（前後端共用），會碰到 Node API 的留在 lib/push。
 *
 * 【字串就是欄位名】
 * 這幾個 key 直接對應 notification_prefs 的布林欄位
 * （migration_92 的四個 ＋ migration_140 的 purchasing），
 * 刻意一致 —— 不然要多維護一份對照表，而對照表漏掉一項不會報錯，
 * 只會讓某一種通知永遠發不出去。
 */
export type NotifyKind = 'orders' | 'approvals' | 'reviews' | 'cleaning' | 'purchasing';

export const NOTIFY_KINDS: NotifyKind[] = ['orders', 'approvals', 'reviews', 'cleaning', 'purchasing'];

export const NOTIFY_LABEL: Record<NotifyKind, string> = {
  orders: '訂單通知',
  approvals: '審核通知',
  reviews: '評價通知',
  cleaning: '清潔記錄通知',
  purchasing: '採購需求通知',
};

export const NOTIFY_DESC: Record<NotifyKind, string> = {
  orders: '爬蟲抓到新訂單，或有人手動新增私下訂單',
  approvals: '有請款單待你核可，或你送的單被核可／駁回',
  reviews: '爬蟲抓到新的房客評價',
  cleaning: '匯入新的清潔記錄',
  purchasing: '有人提出新的採購需求（migration_140）',
};

/**
 * 沒有偏好列時的預設值。**必須跟 migration_92 的 column default 一致。**
 *
 * 審核是 true，因為那是上線前的既有行為 —— 改成 false 等於這次上線
 * 把所有人的核可通知悄悄關掉，而且沒有人會知道為什麼不再收到了。
 */
export const NOTIFY_DEFAULT: Record<NotifyKind, boolean> = {
  orders: false, approvals: true, reviews: false, cleaning: false,
  /*
   * 採購需求預設 true（migration_140 的 column default 也是 true）。
   *
   * 這是新功能,沒有「維持現狀」的問題 —— 而收不到的話,
   * 會計不知道有需求進來,那張需求單就會躺在那裡沒有人處理。
   * 那正是這個功能要解決的問題。
   */
  purchasing: true,
};
