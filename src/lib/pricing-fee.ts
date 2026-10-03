import { ymOf } from './period.ts';
/**
 * 調價軟體支出（migration_312）—— 人勾、人按，不自動產生。
 *
 * 2026-10-03 David：「訂單有一個按鈕『調價支出』，勾選哪些訂單要產生支出，預覽，完成產生。
 *   下次可以選其他沒有選的產生；有歷史紀錄可以撤銷；產生過的不能重複產生。」
 *
 * ★ 真正的金額、能不能產生，以資料庫的 gen_pricing_fees() 為準（預覽也是它算的）。
 *   這裡只負責畫面上的勾選與試算 —— 兩邊公式一樣（訂單 × 費率，四捨五入到元）。
 */

/** 誰看得到「調價支出」—— 跟支出的 RLS 同一組（會計／主管／總經理） */
export const PRICING_ROLES = ['accountant', 'manager', 'super_admin'] as const;
export function canPricingFee(role: string | null | undefined): boolean {
  return !!role && (PRICING_ROLES as readonly string[]).includes(role);
}

/** 一張訂單的調價支出（元） */
export function feeOf(amount: number | null | undefined, rate: number): number {
  return Math.round((Number(amount) || 0) * rate);
}

/** 入住日 → 六碼 ym（走 period.ts 唯一那一份；沒有日期回空字串） */
export const ymOfCheckin = (checkin: string | null | undefined): string => (checkin ? ymOf(checkin) : '');

/** 支出的 auto_key → 訂單 id；不是調價支出回 null */
export function orderIdOfKey(key: string | null | undefined): string | null {
  const m = /^pricing:order:(.+)$/.exec(key ?? '');
  return m ? m[1] : null;
}

/** 月份快選：這個月、上個月、上上個月（六碼，新到舊） */
export function recentYms(todayYm: string, n = 3): string[] {
  let y = Number(todayYm.slice(0, 4)), m = Number(todayYm.slice(4, 6));
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    out.push(`${y}${String(m).padStart(2, '0')}`);
    m -= 1; if (m === 0) { m = 12; y -= 1; }
  }
  return out;
}

export type PricingRow = { id: string; checkin: string | null };

/** 這個月份（或 'all'）看得到的列 */
export function rowsOfMonth<T extends PricingRow>(rows: readonly T[], ym: string): T[] {
  return ym === 'all' ? [...rows] : rows.filter((r) => ymOfCheckin(r.checkin) === ym);
}

/** 點月份 ＝ 把那個月還沒產生過的全勾起來 */
export function pickMonth<T extends PricingRow>(rows: readonly T[], ym: string, done: ReadonlySet<string>): Set<string> {
  return new Set(rowsOfMonth(rows, ym).filter((r) => !done.has(r.id)).map((r) => r.id));
}
