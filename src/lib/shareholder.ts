/**
 * 安幸・股東往來（migration_321，2026-10-07 David 過審）。
 *
 *   in  ＝ 收入：股東借給公司（公司欠股東 +）
 *   out ＝ 支出：公司還股東（公司欠股東 −）
 *
 * ★ 負債，不是營收也不是支出 —— 不進營收表與損益。
 * ★ 判斷式放 .ts 才測得到（anxing-ui 規則）。
 */
export type ShDir = 'in' | 'out';
export type ShMethod = 'transfer' | 'cash';
export type ShTxn = {
  id: string; txn_date: string; shareholder: string; direction: ShDir; amount: number;
  method: ShMethod; account_code: string | null; peer_bank_code: string | null; peer_account: string | null;
  summary: string | null;
};

export const DIR_LABEL: Record<ShDir, string> = { in: '收入（股東借給公司）', out: '支出（公司還股東）' };
export const DIR_SHORT: Record<ShDir, string> = { in: '借入', out: '還款' };
export const METHOD_LABEL: Record<ShMethod, string> = { transfer: '匯款', cash: '現金' };

/** 欄名跟著收支與方式換（過審稿的寫法） */
export const methodFieldLabel = (d: ShDir) => (d === 'in' ? '收款方式' : '付款方式');
export function accountFieldLabel(d: ShDir, m: ShMethod): string {
  if (m === 'cash') return d === 'in' ? '收到現金放在' : '現金從哪裡出';
  return d === 'in' ? '安幸收款帳號' : '安幸付款帳號';
}
export const peerFieldLabel = (d: ShDir) => (d === 'in' ? '股東匯出的帳號（對帳用，選填）' : '匯到股東的帳號');

const n0 = (v: unknown) => Math.round(Number(v) || 0);
const signed = (t: Pick<ShTxn, 'direction' | 'amount'>) => (t.direction === 'in' ? n0(t.amount) : -n0(t.amount));

/** 每位股東：借入合計、還款合計、公司還欠他多少；欠最多的在前 */
export function byHolder(rows: readonly ShTxn[]): { name: string; inSum: number; outSum: number; owed: number }[] {
  const m = new Map<string, { name: string; inSum: number; outSum: number; owed: number }>();
  for (const t of rows) {
    const k = t.shareholder.trim();
    const x = m.get(k) ?? { name: k, inSum: 0, outSum: 0, owed: 0 };
    if (t.direction === 'in') x.inSum += n0(t.amount); else x.outSum += n0(t.amount);
    x.owed += signed(t);
    m.set(k, x);
  }
  return [...m.values()].sort((a, b) => b.owed - a.owed || a.name.localeCompare(b.name));
}

/** 三張卡：借入累計、已還累計（含本年）、公司尚欠、有欠款的股東數 */
export function shTotals(rows: readonly ShTxn[], year: string) {
  let inSum = 0, outSum = 0, outYear = 0;
  for (const t of rows) {
    if (t.direction === 'in') inSum += n0(t.amount);
    else { outSum += n0(t.amount); if (t.txn_date.startsWith(year)) outYear += n0(t.amount); }
  }
  const holders = byHolder(rows);
  return { inSum, outSum, outYear, owed: inSum - outSum, owingHolders: holders.filter((h) => h.owed !== 0).length };
}

/**
 * 每一列「到這一筆為止公司還欠這位股東多少」。
 * 依日期由舊到新累加（同一天照建立順序，也就是陣列順序），回傳 id → 餘額。
 */
export function runningOwed(rows: readonly ShTxn[]): Map<string, number> {
  const sorted = rows.map((t, i) => ({ t, i })).sort((a, b) => a.t.txn_date.localeCompare(b.t.txn_date) || a.i - b.i);
  const bal = new Map<string, number>();
  const out = new Map<string, number>();
  for (const { t } of sorted) {
    const k = t.shareholder.trim();
    const v = (bal.get(k) ?? 0) + signed(t);
    bal.set(k, v); out.set(t.id, v);
  }
  return out;
}

/** 這位股東上次用的帳號（新增時自動帶入） */
export function lastPeer(rows: readonly ShTxn[], name: string): { bank: string; account: string } | null {
  const hit = [...rows].filter((t) => t.shareholder.trim() === name.trim() && t.peer_account)
    .sort((a, b) => b.txn_date.localeCompare(a.txn_date))[0];
  return hit ? { bank: hit.peer_bank_code ?? '', account: hit.peer_account ?? '' } : null;
}

/** 存檔前缺什麼（紅框與訊息同一份答案） */
export function shMissing(d: { txn_date?: string; shareholder?: string; amount?: number; direction?: string }): string[] {
  const m: string[] = [];
  if (!d.direction) m.push('收支');
  if (!d.txn_date) m.push('日期');
  if (!(d.shareholder ?? '').trim()) m.push('股東');
  if (!(Number(d.amount) > 0)) m.push('金額');
  return m;
}
