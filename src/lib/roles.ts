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
