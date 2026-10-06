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

/* ─── 月結記一筆（migration_317，2026-10-06 David：「選月份、填金額、送出就好」）─── */

/** 六碼 ym 加減 n 個月 */
export function ymAdd(ym: string, n: number): string {
  const t = Number(ym.slice(0, 4)) * 12 + Number(ym.slice(4, 6)) - 1 + n;
  return `${Math.floor(t / 12)}${String((t % 12) + 1).padStart(2, '0')}`;
}

/**
 * 缺哪幾個月：最後記到的那個月之後、到**上個月**為止。
 * ★ 不從起始月開始算 —— 很久以前沒記的不會一直跳出來；也不算這個月（月還沒結束）。
 * ★ 一筆都沒記過 → 不算缺（新項目）。
 */
export function missingYms(recorded: readonly string[], thisYm: string): string[] {
  if (!recorded.length) return [];
  const last = [...recorded].sort().at(-1)!;
  const prev = ymAdd(thisYm, -1);
  const out: string[] = [];
  for (let y = ymAdd(last, 1); y <= prev; y = ymAdd(y, 1)) out.push(y);
  return out;
}

/** 記一筆時月份的預設：最早缺的 → 上個月還沒記就上個月 → 這個月 */
export function defaultEntryYm(recorded: readonly string[], thisYm: string): string {
  const miss = missingYms(recorded, thisYm);
  if (miss.length) return miss[0];
  const prev = ymAdd(thisYm, -1);
  return recorded.includes(prev) ? thisYm : prev;
}

/** 記一筆的必填（判斷式放 .ts 才測得到） */
export function entryMissing(e: { estate_id: string; item: string; ym: string; amount: number }): string[] {
  const m: string[] = [];
  if (!e.estate_id) m.push('物業');
  if (!e.item.trim()) m.push('項目');
  if (!/^\d{4}(0[1-9]|1[0-2])$/.test(e.ym)) m.push('月份');
  if (!(e.amount > 0)) m.push('收入金額');
  return m;
}
