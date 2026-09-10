/**
 * 手動暫收款的必填檢查（2026-08-25 使用者：「上方那些是必填」）。
 *
 * ── 為什麼從「至少填一個」改成「全部必填」 ────────────────
 *
 * 舊規則是 `房源與姓名至少要填一個`。那條規則的問題不是太寬，
 * 而是**它讓資料庫裡長出對不上任何人的錢**：
 *
 *   只填房源 → 半年後退款時不知道要退給誰
 *   只填姓名 → 對不上是哪一間房收的
 *   物業空著 → 暫收付管理的物業篩選看不到它，等於從清單上消失
 *
 * 三種都不會報錯。錢在帳上，而沒有人查得出它是誰的。
 *
 * ★ 這是**手動列專用**。連動列（從訂單／契約同步過來的）這幾欄是
 *   來源的快照，本來就填得滿，也不該在這裡擋。
 *
 * ── 為什麼寫在 .ts 而不是元件裡 ──────────────────────
 * 專案規矩：判斷式寫在 .tsx 裡測不到（測試環境不處理 JSX）。
 */

export type ManualDepositDraft = {
  estate_id?: string | null;
  room?: string | null;
  guest_name?: string | null;
  currency?: string | null;
  amount?: number | string | null;
  kind?: string | null;
};

/** 欄位順序＝畫面上由上到下，訊息才對得上眼睛掃的順序 */
const FIELDS: { key: keyof ManualDepositDraft; label: string }[] = [
  { key: 'estate_id', label: '物業' },
  { key: 'room', label: '房源' },
  { key: 'guest_name', label: '姓名' },
];

/**
 * 回傳缺的欄位名（畫面順序）。全部填好回傳空陣列。
 *
 * ★ 金額與種類分開處理 —— 見 manualDepositError()。
 */
export function manualDepositMissing(d: ManualDepositDraft): string[] {
  return FIELDS.filter((f) => !String(d[f.key] ?? '').trim()).map((f) => f.label);
}

/**
 * 存檔前的完整檢查。有問題回傳要顯示的訊息，沒問題回傳 null。
 *
 * ★ 一次講完缺哪些，不要一次擋一個 ——
 *   使用者填三次才存得起來的話，第二次就會開始亂填。
 */
/**
 * 缺的欄位**含金額**。
 *
 * ★★★ 2026-09-10 抽出來。原本「金額」只在 `manualDepositError()` 裡面
 *   被 push 進去 —— 那份完整清單**只存在於那個函式的區域變數裡**，
 *   畫面拿不到，所以金額欄永遠畫不出紅框。
 *
 * ★ 現在畫面的紅框、送出鈕的提示、擋下來的訊息用的是同一份答案。
 *   三個地方各算一次的話，遲早出現「星號標了卻不擋」
 *   或「擋了卻沒標」，而兩種都會讓使用者不再相信那個星號。
 */
export function manualDepositMissingAll(d: ManualDepositDraft): string[] {
  const missing = manualDepositMissing(d);
  if (!(Number(d.amount) > 0)) missing.push('金額');
  return missing;
}

export function manualDepositError(d: ManualDepositDraft): string | null {
  const missing = manualDepositMissingAll(d);
  if (missing.length) return `請填：${missing.join('、')}`;

  /*
   * 種類理論上永遠有值（下拉預設押金），但 payload 少帶它的話
   * 資料庫會用預設值 'deposit' —— 選了訂金卻存成押金，**而且存檔成功**。
   * 所以這裡明確擋一次。
   */
  if (d.kind !== 'deposit' && d.kind !== 'earnest') return '請選種類（押金或訂金）';
  return null;
}
