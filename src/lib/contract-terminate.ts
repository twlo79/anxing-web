/**
 * 契約「提前終止・結算退款」（migration_331，2026-10-13 David 過審）的試算與擋門訊息。
 *
 *   ① 終止日　② 已收、已住、可以結算的　③ 沒收多少、退多少（預收租金／押金分兩列）　④ 退還怎麼退
 *
 * ★★ 資料庫 terminate_contract_settle() 是真正的規則；這裡是畫面的試算，兩邊同一套。
 *   「住到終止日該收多少」跟 contract_earned_to()／gen_contract_recognitions 同一個算法：
 *   每月 月租 × 住的天數 ÷ 當月天數，加總後四捨五入。
 */
import { CANCEL_REVIEW_AT, settlePath, type SettlePath } from './cancel-settle.ts';

export { CANCEL_REVIEW_AT, settlePath };
export type { SettlePath };

const DAY = 86400000;
const d0 = (s: string) => new Date(s + 'T00:00:00Z').getTime();
const r0 = (n: number | null | undefined) => Math.round(Number(n) || 0);

/** 住到終止日（含）該收的租金 */
export function earnedTo(c: { start_date: string | null; monthly_rent: number | null }, end: string): number {
  const rent = Number(c.monthly_rent) || 0;
  if (!c.start_date || !end || rent <= 0 || end < c.start_date) return 0;
  const leaseEnd = d0(end) + DAY;
  const st = d0(c.start_date);
  const s = new Date(st);
  let y = s.getUTCFullYear(), m = s.getUTCMonth();
  let total = 0;
  for (;;) {
    const ms = Date.UTC(y, m, 1), me = Date.UTC(y, m + 1, 1);
    if (ms >= leaseEnd) break;
    const n = Math.round((Math.min(me, leaseEnd) - Math.max(ms, st)) / DAY);
    if (n > 0) total += rent * n / Math.round((me - ms) / DAY);
    m += 1; if (m === 12) { m = 0; y += 1; }
  }
  return Math.round(total);
}

/** 住了幾個月又幾天（給人看的） */
export function livedText(start: string | null, end: string): string {
  if (!start || !end || end < start) return '';
  const s = new Date(d0(start)), e = new Date(d0(end) + DAY);
  let months = (e.getUTCFullYear() - s.getUTCFullYear()) * 12 + e.getUTCMonth() - s.getUTCMonth();
  let days = e.getUTCDate() - s.getUTCDate();
  if (days < 0) { months -= 1; days += new Date(Date.UTC(e.getUTCFullYear(), e.getUTCMonth(), 0)).getUTCDate(); }
  return days ? `${months} 個月又 ${days} 天` : `${months} 個月`;
}

export type TermTotals = { rentPaid: number; earned: number; prepaid: number; deposit: number; total: number };

export function termTotals(rentPaid: number, earned: number, depositAvail: number): TermTotals {
  const paid = Math.max(0, r0(rentPaid));
  const e = Math.max(0, r0(earned));
  const prepaid = Math.max(0, paid - e);
  const deposit = Math.max(0, r0(depositAvail));
  return { rentPaid: paid, earned: e, prepaid, deposit, total: prepaid + deposit };
}

/** 押金可結算：沒收到、已退、已沒收 → 0；否則 實收 − 已從押金扣的加費 */
export function depositAvailable(d: {
  received_on?: string | null; received_amount?: number | null; amount?: number | null;
  returned_on?: string | null; forfeited_on?: string | null;
} | null | undefined, feesTotal = 0): number {
  if (!d?.received_on || d.returned_on || d.forfeited_on) return 0;
  return Math.max(0, r0(d.received_amount ?? d.amount) - r0(feesTotal));
}

export type Split = { rentForfeit: number; depForfeit: number };

export function refundOf(t: TermTotals, s: Split): { rent: number; dep: number; total: number } {
  const rent = t.prepaid - r0(s.rentForfeit);
  const dep = t.deposit - r0(s.depForfeit);
  return { rent, dep, total: rent + dep };
}

/** 快選：全部沒收／只沒收押金／只沒收租金／全退（金額一樣或 0 的不重複） */
export function termPicks(t: TermTotals): { label: string; split: Split }[] {
  const out: { label: string; split: Split }[] = [];
  if (t.total > 0) out.push({ label: '全部沒收', split: { rentForfeit: t.prepaid, depForfeit: t.deposit } });
  if (t.prepaid > 0 && t.deposit > 0) {
    out.push({ label: '只沒收押金', split: { rentForfeit: 0, depForfeit: t.deposit } });
    out.push({ label: '只沒收租金', split: { rentForfeit: t.prepaid, depForfeit: 0 } });
  }
  if (t.total > 0) out.push({ label: '全退', split: { rentForfeit: 0, depForfeit: 0 } });
  return out;
}

/** 擋門訊息；null ＝ 可以送 */
export function termError(
  c: { start_date: string | null; end_date: string | null },
  end: string, t: TermTotals, s: Split,
  payee?: { name?: string; account?: string },
): string | null {
  if (!end) return '填終止日';
  if (c.start_date && end < c.start_date) return `終止日不能早於起租日 ${c.start_date}`;
  if (c.end_date && end > c.end_date) return `終止日不能晚於原本的迄日 ${c.end_date}（到期就不用終止）`;
  const rf = r0(s.rentForfeit), df = r0(s.depForfeit);
  if (rf < 0 || df < 0) return '沒收不能是負的';
  if (rf > t.prepaid) return `預收租金最多沒收 $${t.prepaid.toLocaleString()}`;
  if (df > t.deposit) return `押金最多沒收 $${t.deposit.toLocaleString()}`;
  const r = refundOf(t, s);
  if (r.total > 0 && payee && (!payee.name?.trim() || !payee.account?.trim())) return '要退還的話，房客戶名與收款帳號要填';
  return null;
}

export const TERM_PATH_LABEL: Record<SettlePath, string> = {
  close: '沒有要退的：按下去就結案',
  direct: `退還未滿 $${CANCEL_REVIEW_AT.toLocaleString()}：不用審核，直接排匯款`,
  review: `退還 $${CANCEL_REVIEW_AT.toLocaleString()} 以上：送請款審核，兩票核可後才生效`,
};
export const TERM_PATH_BUTTON: Record<SettlePath, string> = {
  close: '確認終止',
  direct: '確認終止，直接退款',
  review: '送審',
};
