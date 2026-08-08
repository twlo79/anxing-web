/**
 * 押金的幣別明細。
 *
 * 【為什麼是一筆多幣別，不是一幣別一筆】
 * 多幣別的現金實務上放在同一個保險箱一起保管，之後一起退。
 * 一次收、一次退、一組帳戶 —— 拆成多列的話使用者要填好幾次一樣的東西，
 * 而且各列的收款日還可能不小心填得不一樣，事後看不出哪個才對。
 *
 * 所以 deposits 一筆一列，幣別明細存在 lines（migration_87）：
 *
 *     amount  台幣那部分（統計、報表、Excel 都讀它，語意沒變）
 *     lines   [{cur:'TWD',amt:160000},{cur:'JPY',amt:10000}]
 *
 * 外幣**只**在 lines 裡。所以任何要「看到全部幣別」的地方都得走這裡，
 * 只讀 amount 會漏掉外幣而且不會有任何跡象。
 */

export type DepLine = { cur: string; amt: number };

const num = (n: unknown) => Number(n) || 0;

/**
 * 讀出明細。
 *
 * 舊資料（migration_87 之前）沒有 lines，退回用 currency + amount 組一筆 ——
 * 不退回的話那些押金在畫面上會變成「沒有金額」。
 */
export function depLines(d: { lines?: DepLine[] | null; currency?: string | null; amount?: number | null }): DepLine[] {
  const ls = (d.lines ?? []).filter((l) => l && l.cur && num(l.amt) !== 0);
  if (ls.length) return ls.map((l) => ({ cur: l.cur.toUpperCase(), amt: num(l.amt) }));
  if (num(d.amount)) return [{ cur: (d.currency || 'TWD').toUpperCase(), amt: num(d.amount) }];
  return [];
}

export const isTwdLine = (l: DepLine) => l.cur === 'TWD';

/** 台幣那部分。等於 deposits.amount —— 兩者對不起來就是資料壞了。 */
export function twdOf(d: Parameters<typeof depLines>[0]): number {
  return depLines(d).filter(isTwdLine).reduce((a, l) => a + l.amt, 0);
}

/** 非台幣的幾列。列表上顯示在台幣底下的小字。 */
export function fxOf(d: Parameters<typeof depLines>[0]): DepLine[] {
  return depLines(d).filter((l) => !isTwdLine(l));
}

const money = (n: number) => Math.round(n).toLocaleString('en-US');

/** 一列的顯示文字：「NT$ 160,000」／「JPY 10,000」。 */
export function lineText(l: DepLine): string {
  return isTwdLine(l) ? `NT$ ${money(l.amt)}` : `${l.cur} ${money(l.amt)}`;
}

/**
 * 列表上的主要金額。
 *
 * 有台幣就顯示台幣；**完全沒有台幣的押金要顯示第一個外幣**，
 * 不然畫面會是「NT$ 0」，看起來像沒收押金。
 */
export function primaryText(d: Parameters<typeof depLines>[0]): string {
  const ls = depLines(d);
  if (!ls.length) return '—';
  const twd = ls.find(isTwdLine);
  return lineText(twd ?? ls[0]);
}

/** 主要金額以外的那幾列，列表上當小字。 */
export function extraLines(d: Parameters<typeof depLines>[0]): DepLine[] {
  const ls = depLines(d);
  if (!ls.length) return [];
  const twd = ls.find(isTwdLine);
  return twd ? ls.filter((l) => !isTwdLine(l)) : ls.slice(1);
}

/** 一行的完整摘要，給 Excel 與分享訊息用：「NT$ 160,000＋JPY 10,000」。 */
export function summaryText(d: Parameters<typeof depLines>[0]): string {
  const ls = depLines(d);
  return ls.length ? ls.map(lineText).join('＋') : '—';
}

/** 多幣別嗎 —— 畫面上要不要展開明細看這個。 */
export const isMultiCurrency = (d: Parameters<typeof depLines>[0]) => depLines(d).length > 1;

/**
 * 各幣別合計。押金頁的統計卡用。
 *
 * **不能只加 amount** —— 那樣外幣完全不會出現在統計裡，
 * 而且因為數字看起來很正常，沒有人會發現少了。
 */
export function sumByCurrency(rows: Parameters<typeof depLines>[0][]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) for (const l of depLines(r)) out[l.cur] = (out[l.cur] ?? 0) + l.amt;
  return out;
}
