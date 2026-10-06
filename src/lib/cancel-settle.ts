/**
 * 私下訂單「取消訂單・結算退款」（migration_319，2026-10-06 David 過審）。
 *
 * 「沒入應該是計算所有已收後退」：
 *   已收合計 ＝ 押金可結算（已收 − 已從押金扣的加費）＋ 訂單已收
 *   退還     ＝ 已收合計 − 沒入
 *   退還 0 → 結案；< 3,000 → 免審直接退；≥ 3,000 → 送請款審核
 *
 * ★★ 資料庫那支 cancel_order_settle() 是真正的規則；這裡是畫面的試算與擋門訊息，兩邊同一套。
 */

/** 退還多少以上要審核（David：「退還不到 3000 直接過」） */
export const CANCEL_REVIEW_AT = 3000;

export type SettlePath = 'close' | 'direct' | 'review';

export function settlePath(refund: number): SettlePath {
  if (refund <= 0) return 'close';
  return refund < CANCEL_REVIEW_AT ? 'direct' : 'review';
}

export const PATH_LABEL: Record<SettlePath, string> = {
  close: '全部沒入：不用請款，按下去就結案',
  direct: `退還未滿 $${CANCEL_REVIEW_AT.toLocaleString()}：不用審核，直接排匯款`,
  review: `退還 $${CANCEL_REVIEW_AT.toLocaleString()} 以上：送請款審核，兩票核可後才生效`,
};

export const PATH_BUTTON: Record<SettlePath, string> = {
  close: '確認取消並沒入',
  direct: '確認取消，直接退款',
  review: '送審',
};

const r0 = (n: number | null | undefined) => Math.round(Number(n) || 0);

/** 押金可結算：沒收到 → 0；收到 → 實收（沒有實收欄就用金額）− 已從押金扣的加費 */
export function depositAvail(d: { received_on?: string | null; received_amount?: number | null; amount?: number | null } | null | undefined,
                             feesTotal = 0): number {
  if (!d?.received_on) return 0;
  return Math.max(0, r0(d.received_amount ?? d.amount) - r0(feesTotal));
}

export type SettleTotals = { deposit: number; order: number; total: number };

export function settleTotals(depAvail: number, orderPaid: number | null | undefined): SettleTotals {
  const deposit = Math.max(0, r0(depAvail));
  const order = Math.max(0, r0(orderPaid));
  return { deposit, order, total: deposit + order };
}

/** 快選：全部、只沒入押金、只沒入房費、全退（金額相同或為 0 的不重複列） */
export function quickPicks(t: SettleTotals): { label: string; forfeit: number }[] {
  const out: { label: string; forfeit: number }[] = [{ label: '全部', forfeit: t.total }];
  if (t.deposit > 0 && t.order > 0) {
    out.push({ label: '只沒入押金', forfeit: t.deposit });
    out.push({ label: '只沒入房費', forfeit: t.order });
  }
  if (t.total > 0) out.push({ label: '全退', forfeit: 0 });
  return out;
}

/**
 * 擋門訊息（David：「退還不能多於全部金額 > 如果超過直接顯示原因」）。null ＝ 可以送。
 * 兩格都可以打：沒入或退還，任一格超過已收合計都直接講原因。
 */
export function settleError(forfeit: number, refund: number, total: number,
                            payee?: { name?: string; account?: string }): string | null {
  const T = `$${total.toLocaleString()}`;
  if (total <= 0) return '這張訂單一毛都還沒收到 —— 沒有東西可以沒入或退還，直接刪掉訂單就好';
  // ★ 超過的先講 —— 兩格連動，退還打太大時沒入會變負數，那時要講的是「退還超過」不是「沒入是負的」
  if (refund > total) return `退還 $${refund.toLocaleString()} 超過已收合計 ${T} —— 最多只能退收到的錢`;
  if (forfeit > total) return `沒入 $${forfeit.toLocaleString()} 超過已收合計 ${T}`;
  if (forfeit < 0) return '沒入不能是負的';
  if (refund < 0) return '退還不能是負的';
  if (forfeit + refund !== total) return `沒入＋退還要等於已收合計 ${T}`;
  if (refund > 0 && payee && (!payee.name?.trim() || !payee.account?.trim())) return '要退還的話，房客戶名與收款帳號要填';
  return null;
}

/** 這張訂單能不能取消結算（按鈕灰掉時的原因） */
export function cancelBlockedReason(o: { source: string; cancelled_on?: string | null;
                                          cancel_settle?: { status?: string } | null }): string | null {
  if (o.source !== 'private') return '只有私下訂單在這裡取消 —— Airbnb／Agoda 的取消照平台同步';
  if (o.cancelled_on && o.cancel_settle?.status !== 'rejected') return '這張訂單已經取消了';
  return null;
}
