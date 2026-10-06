/**
 * 定期收費展開後「分年 → 月份」（2026-10-06 David 過審）。
 *
 * ★ 今年預設展開、往年收起來；但**有未填月份的那一年不管幾年前都展開** —— 收起來的話漏填就看不到了。
 * ★ 月份看 order_key 尾巴的六碼（'RC_<uuid>_202601'），不看日期 —— 日期是月底（migration_314），跟月份一一對應但不必去算。
 */
export type RcOrder = { id: string; order_key: string; amount: number | null; paid: boolean };
export type RcYear<T extends RcOrder> = { year: string; list: T[]; total: number; zero: number };

export const ymOfRcKey = (k: string) => k.slice(-6);

/** 依年份分組，新的年份在前；年份裡的月份由舊到新 */
export function groupRcByYear<T extends RcOrder>(os: readonly T[]): RcYear<T>[] {
  const m = new Map<string, T[]>();
  for (const o of os) { const y = ymOfRcKey(o.order_key).slice(0, 4); (m.get(y) ?? m.set(y, []).get(y)!).push(o); }
  return Array.from(m.entries())
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([year, list]) => {
      const l = [...list].sort((a, b) => ymOfRcKey(a.order_key).localeCompare(ymOfRcKey(b.order_key)));
      return {
        year, list: l,
        total: l.reduce((s, o) => s + (Number(o.amount) || 0), 0),
        zero: l.filter((o) => !Number(o.amount)).length,
      };
    });
}

/** 預設要不要展開：今年，或那一年有未填 */
export const rcYearOpenByDefault = (g: { year: string; zero: number }, thisYear: string): boolean =>
  g.year === thisYear || g.zero > 0;
