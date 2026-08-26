/**
 * 人工隱藏評價（migration_178，2026-08-25 使用者:「幫我設計 可以人工刪除」）。
 *
 * ============================================================
 * 【★★ 為什麼叫「隱藏」不叫「刪除」】
 *
 * 評價是爬蟲用 `airbnb_review_id` upsert 進來的。
 * 真的 DELETE 掉的話，**下一次同步它就原封不動回來** ——
 * 而畫面上不會有任何跡象，使用者只會覺得刪除鍵沒用，然後再刪一次。
 *
 * 所以留著那一列、標記它，統計時排除。
 * 按鈕上的字也要寫「隱藏」——寫「刪除」的話，
 * 使用者對它的期待就是「不見了」，而它其實還在。
 */

export type HidableReview = {
  id: string;
  hidden_at?: string | null;
  hidden_by?: string | null;
  hidden_reason?: string | null;
};

/** 誰能隱藏。使用者指定「經理 + 總管理員」—— 要跟 RLS 的 reviews_write 一致。 */
export const HIDE_ROLES = ['manager', 'super_admin'];

export const canHideReview = (role: string | null | undefined) =>
  HIDE_ROLES.includes(role ?? '');

export const isHidden = (r: HidableReview) => !!r.hidden_at;

/**
 * 常見的隱藏理由。
 *
 * ★ 做成選項而不是純自由輸入:三個月後回頭看，
 *   自由輸入的欄位裡有一半是空白或「測試」。
 *   選項讓「這是哪一類問題」變得可以統計 ——
 *   例如「重複」如果一直出現，那是爬蟲該修，不是一直手動藏。
 *
 * ★ 但保留「其他」＋自由輸入 —— 只給固定選項的話，
 *   遇到對不上的情況使用者會硬選一個最像的，那比空著更糟。
 */
export const HIDE_REASONS = [
  '重複的評價',
  '不是我們的房源',
  '測試資料',
  '客人要求撤下',
  '其他',
];

/**
 * 送出前檢查。回傳錯誤訊息，沒問題回 null。
 *
 * ★★ 理由**必填**（資料庫的 `rv_hidden_chk` 也擋）。
 *
 *   三個月後看到一則被藏起來的四星評價，
 *   「誰藏的」查得到但「為什麼」查不到的話，沒有人敢把它放回去 ——
 *   於是它就永遠留在那裡，而那一棟的平均星等永遠比實際高一點點。
 */
export function hideError(reason: string | null | undefined, other: string | null | undefined): string | null {
  const r = (reason ?? '').trim();
  if (!r) return '請選擇隱藏原因';
  if (r === '其他' && !(other ?? '').trim()) return '選了「其他」請說明原因';
  return null;
}

/** 存進資料庫的理由字串。「其他」時把自由輸入接在後面，兩個資訊都留著。 */
export function hideReasonText(reason: string, other: string | null | undefined): string {
  const o = (other ?? '').trim();
  return reason === '其他' && o ? `其他：${o}` : reason;
}

/**
 * 隱藏會讓統計少一則 —— 按下去之前要講出**影響了哪一棟的平均**。
 *
 * ★ 不講的話使用者只知道「這則不見了」，
 *   下個月看到那一棟平均漲了 0.1 會找不到原因。
 */
export function hideImpactText(rating: number | null | undefined, estateName?: string | null): string {
  const r = Number(rating);
  const who = (estateName ?? '').trim();
  if (!(r > 0)) return '這則不會再算進平均星等與管家排行。';
  return `這則 ${r} 星不會再算進${who ? `「${who}」的` : ''}平均星等與管家排行。`;
}
