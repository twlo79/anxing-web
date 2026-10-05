/**
 * 房源狀態卡片上的「備註」（2026-10-05 David：「讀出備註，可以直接編輯，同步寫到訂單備註裡；管家都能做編輯」）。
 *
 * ★★★ 不是另存一份 —— 寫的就是 `orders.note`／`contracts.note`，跟訂單頁、契約頁編輯的是**同一欄**。
 * ★★ 誰能改 ＝ `canEditOrders()`（管家／會計／主管／總經理），跟 RLS 一致（orders_housekeeper、contracts_rw）。
 * ★★ RLS 擋下的 update 不會報錯、只是影響 0 列 —— 所以一定要 `.select('id')` 回來數，0 列就說「沒存到」。
 */
export type StayKind = 'order' | 'contract';

/** 這一筆的備註存在哪張表 */
export const noteTable = (kind: StayKind): 'orders' | 'contracts' => (kind === 'contract' ? 'contracts' : 'orders');

/** 存進去的值：前後空白去掉，空字串存 null（不要留一個「看起來有、其實是空白」的備註） */
export function normNote(s: string | null | undefined): string | null {
  const t = (s ?? '').replace(/\s+$/g, '').replace(/^\s+/g, '');
  return t ? t : null;
}

/** 有沒有改到（空白差異不算） */
export const noteChanged = (before: string | null | undefined, after: string | null | undefined): boolean =>
  normNote(before) !== normNote(after);

/** 存完之後的判定：null ＝ 成功；字串 ＝ 要顯示在卡片上的錯誤 */
export function noteSaveError(error: { message?: string } | null | undefined, rows: readonly unknown[] | null | undefined): string | null {
  if (error) return '沒存到：' + (error.message || '不明原因');
  if (!rows || rows.length === 0) return '沒存到 —— 多半是沒有權限，請找主管';
  return null;
}
