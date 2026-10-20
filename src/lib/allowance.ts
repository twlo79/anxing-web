import { INV_NO_RE } from './invoice.ts';

/**
 * ============================================================
 * 契約折讓（收租視窗的「− 折讓」）—— 2026-10-18 改成跟登錄發票同一種視窗
 *
 * 【David】「折讓單號｜日期｜金額｜備註；單號跟發票號碼格式一樣；
 *          單號與日期非必填；備註填了就取代『折讓』顯示：備註內容 −$...」
 *
 * ★ 單號存 `orders.allowance_no`（migration_333，資料庫也擋格式）。
 * ★ 備註存 `item_name` —— 它就是列表上顯示的名字；`note` 照舊放算式（原應收 − 折讓 ＝ 淨額）給對帳用。
 * ★ 日期沒填 ＝ 這一期的第一天（改版前的預設），營收認列在那個月。
 * ============================================================
 */

export type AllowanceDraft = { no: string; date: string; amount: number; note: string };

/** 擋門訊息；null ＝ 可以存 */
export function allowanceError(d: AllowanceDraft): string | null {
  if (!(Math.abs(Number(d.amount) || 0) > 0)) return '請填折讓金額';
  const no = d.no.trim().toUpperCase();
  if (no && !INV_NO_RE.test(no)) return `折讓單號 ${no} 格式不對 —— 要是 2 碼英文＋8 碼數字（例：AB12345678），沒有單號就留空`;
  return null;
}

/** 寫進訂單的那幾欄 */
export function allowanceFields(d: AllowanceDraft, periodStart: string) {
  return {
    allowance_no: d.no.trim().toUpperCase() || null,
    checkin: d.date || periodStart,
    item_name: d.note.trim() || null,
  };
}

/** 列表上的名字：有備註就顯示備註，沒有就「折讓」 */
export function allowanceLabel(item_name: string | null | undefined): string {
  return (item_name ?? '').trim() || '折讓';
}

/**
 * ============================================================
 * 折讓退款的「扣除」（請款審核抽屜的編輯，2026-10-20 David：「-900 金額 要可以修改金額」）
 *
 * 實退 ＝ 折讓金額 − 扣除。折讓金額來自契約那張折讓單（orders.amount 的絕對值），這裡不改它。
 * 跟 migration_337 的 request_allowance_refund 同一條算法 —— 兩邊算出來一定要一樣。
 * ============================================================
 */

/** 折讓金額：有讀到折讓單就用它（絕對值），還沒讀到就用這一列目前的 實退 ＋ 扣除 推回去 */
export function allowanceBase(order: { amount: number } | null | undefined, dep: { refund_amount?: number | null; refund_deduct_amount?: number | null }): number {
  if (order) return Math.abs(Number(order.amount) || 0);
  return (Number(dep.refund_amount) || 0) + (Number(dep.refund_deduct_amount) || 0);
}

/** 擋門訊息；null ＝ 可以存 */
export function allowanceDeductError(base: number, item: string, amount: number): string | null {
  const ded = Math.round(Number(amount) || 0);
  if (ded < 0) return '扣除金額不能是負數';
  if (ded > base) return `扣除 ${ded.toLocaleString()} 超過折讓金額 ${base.toLocaleString()}`;
  if (ded > 0 && !item.trim()) return '請填扣除項目（例：稅金）';
  return null;
}

/** 寫進 deposits 的那三欄：扣什麼、扣多少、實退 */
export function allowanceDeductFields(base: number, item: string, amount: number) {
  const ded = Math.max(0, Math.round(Number(amount) || 0));
  return {
    refund_deduct_item: ded > 0 ? (item.trim() || null) : null,
    refund_deduct_amount: ded,
    refund_amount: base - ded,
  };
}
