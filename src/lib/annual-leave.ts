/**
 * 特休額度（安幸的公司制度，2026-08-17 使用者提供）。
 *
 * ============================================================
 * 【級距】
 *
 *   未滿 6 個月      0 天
 *   6 個月 ~ 未滿 1 年   7 天
 *   1 年 ~ 未滿 2 年    11 天
 *   2 年 ~ 未滿 3 年    16 天
 *   3 年以上          21 天
 *
 * **這比勞基法優厚**（法定是 3 / 7 / 10 / 14 天）。
 * 寫下來是因為將來有人拿法規來對，會以為這裡算錯了 ——
 * 不是算錯，是公司給得比較多。
 *
 * 【只增不減】
 * 級距是「以上」，所以年資越久額度越高，不會因為跨過某條線變少。
 * 這一點看起來理所當然，但如果有人把 3 年以上寫成「3~5 年」再開新級距，
 * 就會出現「做滿 5 年反而歸零」的洞。
 *
 *
 * ============================================================
 * 【邊界怎麼算】
 *
 * 用**足月數**，不用天數 —— 「做滿 6 個月」是日曆上的同一天，
 * 不是 180 天。2 月 15 日到職的人，8 月 15 日就滿 6 個月。
 *
 * 用天數換算的話 2 月到職的人會晚兩天拿到特休，而那兩天沒有道理。
 *
 *
 * ============================================================
 * 【為什麼回傳「天」而不是「小時」】
 *
 * 制度是用天講的。換成小時要乘每日工時，而那個數字在
 * `work_settings` 裡是可以改的（現在 8 小時）。
 *
 * 在這裡先乘掉的話，哪天工時改成 7.5，這支函式回的數字就悄悄錯了 ——
 * 而它看起來仍然很合理。換算留給呼叫端，那裡才拿得到設定。
 */

/** 級距表。`from` 是「做滿幾個月」的下限（含） */
export const ANNUAL_LEAVE_TIERS: { fromMonths: number; days: number; label: string }[] = [
  { fromMonths: 36, days: 21, label: '3 年以上' },
  { fromMonths: 24, days: 16, label: '2 ~ 3 年' },
  { fromMonths: 12, days: 11, label: '1 ~ 2 年' },
  { fromMonths: 6, days: 7, label: '6 個月 ~ 1 年' },
];

/**
 * 兩個日期之間的足月數。
 *
 * 「足月」= 到了同一個日子才算 —— 1/31 到職的人 2/28 還沒滿一個月
 * （2 月沒有 31 號，那就等到 3/31）。
 *
 * 用 UTC 算，不用本地時區:`new Date('2026-08-17')` 在 UTC+8 是
 * 8/17 08:00，跨月邊界的計算會差一天，而那種錯只在某些時區出現。
 */
export function monthsBetween(from: string, to: string): number {
  const a = (from ?? '').slice(0, 10);
  const b = (to ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(a) || !/^\d{4}-\d{2}-\d{2}$/.test(b)) return -1;
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  let m = (by - ay) * 12 + (bm - am);
  // 日還沒到就還沒滿這個月
  if (bd < ad) m -= 1;
  return m;
}

/**
 * 特休天數。
 *
 * 【到職日沒填就回 null，不回 0】
 * 0 的意思是「他沒有特休」，null 是「算不出來」。
 * 混在一起的話，沒填到職日的人會被當成沒有特休 ——
 * 而那正是最需要有人去補資料的情況，卻在畫面上長得像已經處理完了。
 */
export function annualLeaveDays(
  hireDate: string | null | undefined,
  asOf: string,
): number | null {
  if (!hireDate) return null;
  const m = monthsBetween(hireDate, asOf);
  if (m < 0) return null;                      // 日期壞掉或還沒到職
  for (const t of ANNUAL_LEAVE_TIERS) {
    if (m >= t.fromMonths) return t.days;
  }
  return 0;                                    // 未滿 6 個月:確定沒有,不是算不出來
}

/** 落在哪一段。畫面上寫出來，人才知道這個數字是怎麼來的 */
export function tierLabel(hireDate: string | null | undefined, asOf: string): string {
  if (!hireDate) return '未填到職日';
  const m = monthsBetween(hireDate, asOf);
  if (m < 0) return '到職日有誤';
  for (const t of ANNUAL_LEAVE_TIERS) if (m >= t.fromMonths) return t.label;
  return '未滿 6 個月';
}

/**
 * 天 → 小時。每日工時從設定來，不寫死。
 *
 * 寫死 8 的話，哪天改成 7.5 小時制，所有人的特休會多算半天 ——
 * 而那個差只在請假請到最後一天時才會被發現。
 */
export const leaveHours = (days: number, hoursPerDay: number) =>
  Math.round(days * hoursPerDay * 100) / 100;
