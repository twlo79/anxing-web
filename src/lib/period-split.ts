/**
 * 每期金額怎麼拆到各月 —— 跟資料庫 gen_contract_orders()（migration_298）同一條規則。
 *
 *   前 step−1 個月 = round(per ÷ step)
 *   最後一個月     = per − 前面合計（吸收餘數）
 *
 * 年繳 1,867,576 → 155,631 × 11 ＋ 155,635。月繳 step = 1 → 就是 per 本身。
 * 這支只給畫面顯示用；真正產月租單的是資料庫那支，改規則兩邊要一起改。
 */
export function periodSplit(per: number, step: number): { base: number; last: number; remainder: number } {
  const s = Math.max(1, Math.floor(step) || 1);
  const p = Number(per) || 0;
  const base = Math.round(p / s);
  const last = p - base * (s - 1);
  return { base, last, remainder: last - base };
}

/**
 * 一期裡每個月的金額（照上面同一條規則）。`months` 通常 = step；
 * 租期最後一期不足整期時（季繳租 14 個月 → 最後一期 2 個月）就只有前幾個月，
 * 都是 base —— 餘數那個月根本沒到。
 */
export function periodAmounts(per: number, step: number, months: number): number[] {
  const s = Math.max(1, Math.floor(step) || 1);
  const { base, last } = periodSplit(per, s);
  const n = Math.max(0, Math.floor(months) || 0);
  return Array.from({ length: n }, (_, i) => (i === s - 1 ? last : base));
}
