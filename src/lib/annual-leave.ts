/**
 * 特休額度 —— **勞基法第 38 條**（2026-09-29 使用者指定：「用勞基法算特休，然後設計一個公司額外特休假」）。
 *
 * ============================================================
 * 【級距（法定）】
 *
 *   6 個月以上未滿 1 年    3 天
 *   1 年以上未滿 2 年      7 天
 *   2 年以上未滿 3 年     10 天
 *   3 年以上未滿 5 年     14 天
 *   5 年以上未滿 10 年    15 天
 *   10 年以上           每滿 1 年加 1 天，加到 30 天為止（滿 10 年 16 天、滿 11 年 17 天…）
 *
 * 公司給得比法定多的那部分**不在這裡** —— 另開一個假別「公司特休」（leave_types.company_annual），
 * 額度在假別額度頁逐人填。兩個假別分開記，年底對勞基法時法定那份一目了然。
 *
 * 【級距表放資料庫】`leave_seniority`（threshold_months → days）。這裡的 `STATUTORY_TIERS`
 *   是同一份的預設值，資料庫撈不到時退回用；畫面正常都是把資料庫那份傳進來。
 *   ★ 10 年以上「每年加 1、上限 30」這條規則不在表裡（表只放級距），寫在 `annualLeaveDays()`。
 *
 * 【只增不減】級距是「以上」—— 年資越久越多，不會跨一條線就變少。
 *
 * 【年資算到哪一天】呼叫端決定 `asOf`。假別額度頁用**當年 12/31**（一年一個數字），
 *   跟使用者 2026-09-29 過審的稿子一致。
 *
 * 【邊界】用足月數不用天數 —— 「滿 6 個月」是日曆上同一天（2/15 到職 → 8/15 滿）。
 *
 * 【回「天」不回「小時」】每日工時在 work_settings 可改，換算留給呼叫端。
 */

export type Tier = { fromMonths: number; days: number };

/** 法定級距（資料庫 leave_seniority 的預設值；由大到小排） */
export const STATUTORY_TIERS: readonly Tier[] = [
  { fromMonths: 120, days: 15 },
  { fromMonths: 60, days: 15 },
  { fromMonths: 36, days: 14 },
  { fromMonths: 24, days: 10 },
  { fromMonths: 12, days: 7 },
  { fromMonths: 6, days: 3 },
];
/** 10 年以上每滿一年加 1 天，加到這裡為止 */
export const TEN_YEAR_CAP_DAYS = 30;

/** 資料庫那張表（可能沒排序、可能有人多加一列）→ 由大到小、去掉壞值 */
export function tiersFrom(rows: readonly { threshold_months: number; days: number }[] | null | undefined): Tier[] {
  const t = (rows ?? [])
    .map((r) => ({ fromMonths: Number(r.threshold_months), days: Number(r.days) }))
    .filter((r) => Number.isFinite(r.fromMonths) && r.fromMonths > 0 && Number.isFinite(r.days) && r.days >= 0)
    .sort((a, b) => b.fromMonths - a.fromMonths);
  return t.length ? t : [...STATUTORY_TIERS];
}

/**
 * 兩個日期之間的足月數。「足月」= 到了同一個日子才算 —— 1/31 到職的人 2/28 還沒滿一個月。
 * 用字串拆，不用 Date：`new Date('2026-08-17')` 在 UTC+8 是 08:00，跨月邊界會差一天。
 */
export function monthsBetween(from: string, to: string): number {
  const a = (from ?? '').slice(0, 10);
  const b = (to ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(a) || !/^\d{4}-\d{2}-\d{2}$/.test(b)) return -1;
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  let m = (by - ay) * 12 + (bm - am);
  if (bd < ad) m -= 1;   // 日還沒到就還沒滿這個月
  return m;
}

/**
 * 法定特休天數。
 * 【到職日沒填就回 null，不回 0】0 是「確定沒有特休」，null 是「算不出來」——
 *   混在一起的話沒填到職日的人會被當成沒特休，而那正是最需要補資料的情況。
 */
export function annualLeaveDays(
  hireDate: string | null | undefined, asOf: string, tiers: readonly Tier[] = STATUTORY_TIERS,
): number | null {
  if (!hireDate) return null;
  const m = monthsBetween(hireDate, asOf);
  if (m < 0) return null;
  const sorted = [...tiers].sort((a, b) => b.fromMonths - a.fromMonths);
  const top = sorted[0];
  // 10 年以上：最高一級的天數 ＋ 每多滿一年加 1，上限 30
  if (top && top.fromMonths >= 120 && m >= top.fromMonths) {
    const extra = Math.floor((m - top.fromMonths) / 12) + 1;   // 滿 10 年就先 +1（15 → 16）
    return Math.min(TEN_YEAR_CAP_DAYS, top.days + extra);
  }
  for (const t of sorted) if (m >= t.fromMonths) return t.days;
  return 0;
}

/** 落在哪一段 —— 畫面上寫出來，人才知道數字怎麼來的 */
export function tierLabel(hireDate: string | null | undefined, asOf: string): string {
  if (!hireDate) return '未填到職日';
  const m = monthsBetween(hireDate, asOf);
  if (m < 0) return '到職日有誤';
  if (m < 6) return '未滿 6 個月';
  if (m < 12) return '6 個月～1 年';
  if (m < 24) return '1～2 年';
  if (m < 36) return '2～3 年';
  if (m < 60) return '3～5 年';
  if (m < 120) return '5～10 年';
  return `滿 ${Math.floor(m / 12)} 年`;
}

/** 天 → 小時。每日工時從設定來，不寫死 8 */
export const leaveHours = (days: number, hoursPerDay: number) =>
  Math.round(days * hoursPerDay * 100) / 100;
