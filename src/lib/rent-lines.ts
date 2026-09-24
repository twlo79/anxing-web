/**
 * 每期租金明細（contracts.rent_lines，migration_299）。
 *
 * 明細只是備查：月租單、應收、收租、認列全部照舊看 `amount_per_period`。
 * 唯一的規矩是「有明細的話，加總一定等於每期租金」—— 這裡跟資料庫的
 * `ct_rent_lines_chk()` 是同一條規則，改一邊要改另一邊。
 */
export type RentLine = { label: string; amount: number };

/** 常用的項目名，給輸入框當建議；打別的也可以 */
export const RENT_LINE_SUGGEST = ['房租', '設備租賃', '管理費', '車位'];

const n = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };

/** 資料庫來的 jsonb 整理成乾淨的陣列（不是陣列、少欄位都收成空／0） */
export function normalizeLines(raw: unknown): RentLine[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((r: any) => ({ label: String(r?.label ?? '').trim(), amount: Math.round(n(r?.amount)) }));
}

export function linesSum(lines: RentLine[]): number {
  return lines.reduce((a, l) => a + Math.round(n(l.amount)), 0);
}

/**
 * 存檔前的檢查。回 null ＝ 可以存；回字串 ＝ 擋下來的理由（畫面上直接顯示）。
 * 沒有明細一律可以存 —— 明細是選填的。
 */
export function linesProblem(lines: RentLine[], perPeriod: number | null | undefined): string | null {
  if (!lines.length) return null;
  if (lines.some((l) => !l.label.trim())) return '有一列明細沒填項目';
  if (lines.some((l) => n(l.amount) < 0)) return '明細金額不能是負的';
  const per = Math.round(n(perPeriod));
  const sum = linesSum(lines);
  if (sum !== per) {
    const d = per - sum;
    return `明細合計 ${sum.toLocaleString('en-US')}，跟每期租金差 ${d > 0 ? '+' : ''}${d.toLocaleString('en-US')}`;
  }
  return null;
}

/** 明細標題那一行的字：沒明細「＋ 拆明細」、有的話「明細（N 項）」 */
export function linesTitle(count: number): string {
  return count ? `明細（${count} 項）` : '＋ 拆明細';
}
