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
  close: '不用退錢：不用請款，按下去就結案',
  direct: `退還未滿 $${CANCEL_REVIEW_AT.toLocaleString()}：不用審核，直接排匯款`,
  review: `退還 $${CANCEL_REVIEW_AT.toLocaleString()} 以上：送請款審核，兩票核可後才生效`,
};

export const PATH_BUTTON: Record<SettlePath, string> = {
  close: '確認取消',
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

/* ══════════════════════════════════════════════════════════
 * 2026-10-13（migration_332，David 過審）：房費、押金分開算
 *
 *   房費　保留／退還 —— 「房費不是沒入，是要不要退」：保留的直接改寫成訂單金額，
 *         照原本住宿的月份算房費營收（不走折讓）
 *   押金　沒入／退還 —— 沒入的記一筆一次性營收，名目「其他收入」
 *   退還合計 ＝ 房費退還 ＋ 押金退還；0 結案、< 3,000 免審、≥ 3,000 送審（不變）
 *
 * ★ 資料庫 cancel_order_settle() 是真正的規則；這裡是畫面的試算與擋門訊息。
 * ══════════════════════════════════════════════════════════ */

export type SplitDraft = { keepFee: number; depForfeit: number };
export type SplitResult = { feeRefund: number; depRefund: number; refund: number; kept: number };

export function splitRefund(t: SettleTotals, d: SplitDraft): SplitResult {
  const feeRefund = t.order - r0(d.keepFee);
  const depRefund = t.deposit - r0(d.depForfeit);
  return { feeRefund, depRefund, refund: feeRefund + depRefund, kept: r0(d.keepFee) + r0(d.depForfeit) };
}

/** 快選：全部不退／只退房費／只退押金／全退（某一邊是 0 時，跟別的重複的不列） */
export function splitPicks(t: SettleTotals): ({ label: string } & SplitDraft)[] {
  const out: ({ label: string } & SplitDraft)[] = [{ label: '全部不退', keepFee: t.order, depForfeit: t.deposit }];
  if (t.order > 0 && t.deposit > 0) {
    out.push({ label: '只退房費', keepFee: 0, depForfeit: t.deposit });
    out.push({ label: '只退押金', keepFee: t.order, depForfeit: 0 });
  }
  if (t.total > 0) out.push({ label: '全退', keepFee: 0, depForfeit: 0 });
  return out;
}

/** 擋門訊息；null ＝ 可以送。超過的先講（兩格連動，打太大時另一格會變負數） */
export function splitError(t: SettleTotals, d: SplitDraft,
                           payee?: { name?: string; account?: string }): string | null {
  const m = (n: number) => `$${Math.round(n).toLocaleString()}`;
  if (t.total <= 0) return '這張訂單一毛都還沒收到 —— 沒有東西可以退還，直接刪掉訂單就好';
  const kf = r0(d.keepFee), df = r0(d.depForfeit);
  if (kf > t.order) return `房費留下 ${m(kf)} 超過已收房費 ${m(t.order)}`;
  if (kf < 0) return `房費退還超過已收房費 ${m(t.order)} —— 最多只能退收到的錢`;
  if (df > t.deposit) return `押金沒入 ${m(df)} 超過押金可結算 ${m(t.deposit)}`;
  if (df < 0) return `押金退還超過押金可結算 ${m(t.deposit)} —— 最多只能退收到的錢`;
  const { refund } = splitRefund(t, d);
  if (refund > 0 && payee && (!payee.name?.trim() || !payee.account?.trim())) return '要退還的話，房客戶名與收款帳號要填';
  return null;
}
