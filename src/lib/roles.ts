/**
 * 誰能編輯訂單與契約裡的東西。
 *
 * ============================================================
 * 【為什麼要有這支】（2026-08-21）
 *
 * 角色清單原本是**直接寫在畫面裡**的字串陣列，同一份在
 * shortterm/page.tsx 出現兩次（收款按鈕、RecurringPanel），
 * 契約頁則是根本沒寫（ContractFees 的 canEdit 寫死 true）。
 *
 * 這種散落的清單有一種很特別的壞法:改了其中一處，另一處還是舊的，
 * **而且不會報錯** —— 只會有某個角色在某一頁看得到按鈕、
 * 在另一頁看不到，沒有人知道哪一邊才是對的。
 *
 * ★ 前端擋掉**不是安全機制**，RLS 才是。
 *   這裡存在的唯一理由是:不要讓人看到一顆按了沒用的按鈕。
 *   所以這份清單必須跟 RLS 一致 —— 不一致的兩種後果都很糟:
 *
 *     前端比 RLS 寬  → 按得下去，PostgREST 回成功、影響 0 列，
 *                      畫面說「已儲存」，重整之後什麼都沒有
 *     前端比 RLS 窄  → 明明有權限卻看不到按鈕，使用者只會說「壞了」
 *
 * 【為什麼寫在 .ts 不是 .tsx】
 * 測試環境不處理 JSX，寫在元件裡的判斷式測不到。
 */

/**
 * 能編輯訂單／契約內容（含收款、固定加費、收款證明）的角色。
 *
 * ★ 必須與這幾條 RLS 一致（migration_154）:
 *     orders                       orders_housekeeper / orders_rw / orders_accountant_all
 *     order_payments               op_housekeeper ＋ 原有的會計主管政策
 *     contract_recurring_charges   crc_write_housekeeper ＋ crc_write
 *     attachments (op/)            can_edit_receipt()
 *
 * 2026-08-21 加入 housekeeper —— 使用者指定「契約與訂單編輯裡面
 * 所有功能都要開放給管家」。這代表管家改得動金額、標記得了已收款。
 */
export const ORDER_EDIT_ROLES = [
  'housekeeper', 'accountant', 'manager', 'super_admin',
] as const;

/**
 * 這個角色能不能編輯訂單／契約的內容。
 *
 * 角色還沒載入時（null / undefined / ''）一律回 false ——
 * useProfile() 第一次 render 一定是空的，這時候先不要畫按鈕。
 * 寧可晚半秒才出現，也不要閃一下又消失。
 */
export function canEditOrders(role: string | null | undefined): boolean {
  return !!role && (ORDER_EDIT_ROLES as readonly string[]).includes(role);
}

/**
 * 能刪除訂單的角色（2026-08-22 使用者指定「開放管家可以刪除訂單」）。
 *
 * ★ 必須與 `trash_deletable_tables()` 的 `('orders', 'housekeeper')`
 *   ＋ `trash_can_delete()` 的 housekeeper 分支一致（migration_167）。
 *
 *   **cleaner 不在裡面** —— 資料庫的 RLS 分不出 cleaner 與管家，
 *   但 trash_can_delete 看的是角色字串，那裡分得出來也真的擋得住。
 *   前端這份要跟得上，否則房務會看到一顆按下去只會跳
 *   「你的帳號沒有刪除「訂單」的權限」的按鈕。
 */
export const ORDER_DELETE_ROLES = [
  'housekeeper', 'accountant', 'manager', 'super_admin',
] as const;

/**
 * 這個角色、這一筆訂單，刪得掉嗎？
 *
 * 回 null 表示可以刪；回字串表示不能刪，**而那個字串就是要顯示給人看的原因**。
 *
 * ★ 為什麼回原因而不是 boolean:
 *   直接把按鈕藏掉的話，管家會問「為什麼這一筆沒有刪除鈕」，
 *   而答案（押金已退）畫面上一個字都沒有。
 *   按鈕留著、變灰、hover 看得到原因 —— 跟押金那邊同一個做法
 *   （2026-08-22「押金鎖住就好，不用拿掉」）。
 *
 * @param role         profiles.role
 * @param book         orders.book。null／undefined 當作 anxing（舊資料）
 * @param lockedReason order_locked_reason() 的結果,沒有就傳 null
 */
export function orderDeleteBlockedReason(
  role: string | null | undefined,
  book: string | null | undefined,
  lockedReason: string | null | undefined,
): string | null {
  // 角色還沒載入 —— 先當作不能刪。寧可晚半秒,不要閃一下又消失
  if (!role) return '正在確認權限…';
  if (!(ORDER_DELETE_ROLES as readonly string[]).includes(role)) {
    return '你的帳號沒有刪除訂單的權限。';
  }
  /*
   * 其他帳本（愛皮／洪鯊）的收入也存在 orders 表裡。
   * 管家在選單上看不到那一頁 —— 看不到就不該刪得掉。
   * 這一條跟 soft_delete 裡的 row 層檢查同一個述詞（migration_167）。
   */
  if (role === 'housekeeper' && (book ?? 'anxing') !== 'anxing') {
    return '這筆是「其他收支帳」的收入,不在你的權限範圍。請洽會計。';
  }
  /*
   * 已退押金／已掛加費 —— 資料庫的 trg_orders_lock_guard 會擋（migration_157），
   * 而且只放行會計與總管理員。前端先講，免得按下去才看到例外訊息。
   */
  if (lockedReason && !['accountant', 'super_admin'].includes(role)) {
    return `${lockedReason}。要刪除請洽會計或總管理員。`;
  }
  return null;
}
