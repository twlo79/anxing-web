/**
 * Airbnb 訂單金額拆「實收／搭檔」（2026-10-02 使用者:「訂單金額下面有搭檔收多少、實收多少」）。
 *
 *   實收 ＝ airbnb_snapshots.earnings（You earn，Airbnb 列表上的 Total Payout）
 *   搭檔 ＝ airbnb_snapshots.cohost  （Co-host payout，只在明細裡）
 *   訂單金額 ＝ 實收 ＋ 搭檔 —— 爬蟲建單時就這樣算（lib/airbnb-sync revenueOf）
 *
 * ★ 不在 orders 上另存一份：同一個數字存兩個地方，遲早一邊改了另一邊沒改（CLAUDE.md 坑）。
 *   畫面直接讀快照；快照沒有的（爬蟲上線前 Excel 匯入的舊單）就說「沒有明細」。
 * ★ 對不上（差超過 1 元）只標出來，不自動改金額 —— 金額只出建議是同步的規矩。
 */
export type SnapSplit = { earnings: number | string | null; cohost: number | string | null };

export type AirbnbSplit =
  | { kind: 'none' }
  | { kind: 'split'; earn: number; cohost: number | null; diff: number };

const num = (v: unknown) => (v === null || v === undefined || v === '' ? null : Number(v));

export function airbnbSplit(amount: number | string | null | undefined, snap: SnapSplit | null | undefined): AirbnbSplit {
  const earn = num(snap?.earnings);
  if (!snap || earn === null || Number.isNaN(earn)) return { kind: 'none' };
  const co = num(snap.cohost);
  const total = earn + (co ?? 0);
  const diff = Math.round((Number(amount) || 0) - total);
  return { kind: 'split', earn, cohost: co, diff: Math.abs(diff) <= 1 ? 0 : diff };
}

/** 清單金額底下那一行。沒有搭檔只寫實收；搭檔沒抓到（null）寫「搭檔 ?」 */
export function airbnbSplitLine(s: AirbnbSplit, fmt: (n: number) => string): string {
  if (s.kind === 'none') return '沒有明細';
  const parts = [`實收 ${fmt(Math.round(s.earn))}`];
  if (s.cohost === null) parts.push('搭檔 ?');
  else if (s.cohost > 0) parts.push(`搭檔 ${fmt(Math.round(s.cohost))}`);
  return parts.join('・');
}
