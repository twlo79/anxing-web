/**
 * 儀表板的期間與「上一期」計算。
 *
 * 抽出來的理由跟 revenue-report 一樣:期間算錯不會報錯,只會給你一個
 * 看起來合理但錯誤的成長率。2026-08 的 ym 格式事故就是這樣過去的。
 */

/** 期間模式。年/月是產生器,自訂是直接給起訖。 */
export type PeriodMode = 'year' | 'month' | 'custom';

const p2 = (n: number) => String(n).padStart(2, '0');
/** 不用 toISOString() —— 那是 UTC,台灣 +8 凌晨會少一天。 */
const iso = (d: Date) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;

/** 某年某月的最後一天。day 0 是「上個月的最後一天」。 */
export function lastDayOf(y: number, m: number): string {
  return iso(new Date(y, m, 0));
}

/** 整年 → 01-01 ~ 12-31 */
export function yearRange(y: number): [string, string] {
  return [`${y}-01-01`, `${y}-12-31`];
}

/** 整月 → 該月 1 號 ~ 最後一天。m 是 1..12。 */
export function monthRange(y: number, m: number): [string, string] {
  return [`${y}-${p2(m)}-01`, lastDayOf(y, m)];
}

/**
 * 上一期。
 *
 *   年   2026 全年      → 2025 全年
 *   月   2026-08        → 2026-07（跨年會退到 2025-12）
 *   自訂 任意區間        → 往前推「同樣天數」的緊鄰區間
 *
 * 自訂用天數而不是月數:自訂區間不保證對齊月份,用月數推會產生
 * 長度不同的兩段,成長率就失去意義。
 */
export function prevPeriod(mode: PeriodMode, from: string, to: string): [string, string] {
  if (mode === 'year') {
    const y = Number(from.slice(0, 4)) - 1;
    return yearRange(y);
  }
  if (mode === 'month') {
    const y = Number(from.slice(0, 4));
    const m = Number(from.slice(5, 7));
    return m === 1 ? monthRange(y - 1, 12) : monthRange(y, m - 1);
  }
  const f = new Date(from + 'T00:00:00');
  const t = new Date(to + 'T00:00:00');
  const days = Math.round((t.getTime() - f.getTime()) / 86400000) + 1;
  const pt = new Date(f); pt.setDate(pt.getDate() - 1);
  const pf = new Date(pt); pf.setDate(pf.getDate() - days + 1);
  return [iso(pf), iso(pt)];
}

/**
 * 去年同期（同比）。
 *
 *   年   2026 全年   → 2025 全年（跟環比相同,畫面上會標示出來）
 *   月   2026-08     → 2025-08
 *   自訂 任意區間     → 起訖各往前推一年
 *
 * 【為什麼要跟環比並列】
 * 環比看短期動能,同比避開季節性。短租的淡旺季差很多 ——
 * 八月比七月掉 20% 可能完全正常,但八月比去年八月掉 20% 就是真的在退。
 * 只看其中一個都會誤判。
 */
export function lastYearPeriod(mode: PeriodMode, from: string, to: string): [string, string] {
  if (mode === 'year') return yearRange(Number(from.slice(0, 4)) - 1);
  if (mode === 'month') return monthRange(Number(from.slice(0, 4)) - 1, Number(from.slice(5, 7)));
  // 自訂:整段平移一年。用字串取代 Date 運算,避開 2/29 平移到不存在的日期。
  const shift = (s: string) => `${Number(s.slice(0, 4)) - 1}${s.slice(4)}`;
  return [shift(from), shift(to)];
}

/** 年模式下環比與同比是同一段 —— 畫面上要合併,不要顯示兩欄一樣的數字。 */
export const yoySameAsPrev = (mode: PeriodMode) => mode === 'year';

/**
 * 成長率。比較期是 0 就回 null —— 除以零會是 Infinity,
 * 畫面上會出現「▲ Infinity%」這種東西。
 */
export function growth(cur: number, prev: number): number | null {
  if (!prev) return null;
  return ((cur - prev) / Math.abs(prev)) * 100;
}

/**
 * 期間裡「還沒走完的月份」。
 *
 * 今天是 8/6 而期間含 8 月的話,拿它跟 7 月整月比會顯示營收暴跌 ——
 * 那不是衰退,是月份還沒過完。認列表是按月存的,沒有日粒度,
 * 所以沒辦法真的算「8/1~8/6 的營收」來對比。只能把這件事講出來。
 *
 * 回傳 null 代表期間已經全部結束,比較可以直接看。
 */
export function partialMonth(to: string, today = new Date()): { passed: number; total: number } | null {
  const y = today.getFullYear(), m = today.getMonth() + 1;
  const monthStart = `${y}-${p2(m)}-01`;
  // 期間的迄日沒有碰到本月就沒事
  if (to < monthStart) return null;
  const total = new Date(y, m, 0).getDate();
  const passed = today.getDate();
  if (passed >= total) return null;   // 今天就是月底,不算未完
  return { passed, total };
}
