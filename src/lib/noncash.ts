/**
 * 非實支 → 轉成實支 的勾選與試算（migration_322，2026-10-07）。真正的規則在資料庫 convert_noncash()。
 */
import { ymOf } from './period.ts';

export type NcRow = { id: string; spent_on: string; amount: number; estate_id: string | null };

/** 支出日 → 六碼 ym（走 period.ts 唯一那一份） */
export const ncYmOf = (d: string) => (d ? ymOf(d) : '');

/** 物業（'' ＝ 全部）＋ 支出月（'all' ＝ 全部）篩過的列 */
export function ncRowsOf<T extends NcRow>(rows: readonly T[], estateId: string, ym: string): T[] {
  return rows.filter((r) => (!estateId || r.estate_id === estateId) && (ym === 'all' || ncYmOf(r.spent_on) === ym));
}

/** 點物業或月份 ＝ 只列那些並全勾 */
export const ncPick = (rows: readonly NcRow[], estateId: string, ym: string) => new Set(ncRowsOf(rows, estateId, ym).map((r) => r.id));

/** 已選的合計 */
export function ncTotal(rows: readonly NcRow[], sel: ReadonlySet<string>): number {
  return rows.reduce((s, r) => s + (sel.has(r.id) ? Math.round(Number(r.amount) || 0) : 0), 0);
}
