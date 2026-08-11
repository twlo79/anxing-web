/**
 * 契約期別的純函式。
 *
 * 放在 lib 而不是元件裡，是因為測試用 `node --experimental-strip-types`
 * 跑，它剝不掉 .tsx 的 JSX —— 純邏輯留在 .ts 才測得到。
 */

export type RcLike = { amount: number; active: boolean };

/** 目前實際會收的**每月**總額（暫停的不算） */
export function feeMonthly(rows: RcLike[]): number {
  return rows.filter((r) => r.active).reduce((a, r) => a + (Number(r.amount) || 0), 0);
}

/**
 * 租期內的月份清單（YYYYMM）。
 *
 * ============================================================
 * 【為什麼期別要從租期算出來，不用 <input type="month">】
 *
 * 月份輸入框可以打 1999-01，也可以打 2099-12 —— 兩個都會被存下來，
 * 然後 gen_contract_fee_orders 把它夾進租期，結果是
 * **「設定存進去了，但一期都沒有產生」**。
 *
 * 使用者看到設定躺在那裡、費用單卻不存在，而畫面上沒有任何線索
 * 說明為什麼。改成下拉之後，選項就是這張契約收得到的月份 ——
 * 選不出無效的值，這類錯誤就不存在了。
 *
 * ============================================================
 * 【迄日要先減一天】
 *
 * 很多契約把「住到 9/30」寫成迄日 2028-10-01。
 * 直接取 end_date 的月份會多長出 2028/10 —— 那一期會產生一張
 * 永遠收不到錢的費用單，而且要等到月結對不起來才有人發現。
 */
export function leaseMonths(start: string | null, end: string | null): string[] {
  if (!start || !end) return [];
  const s = new Date(`${start}T00:00:00Z`);
  const e = new Date(`${end}T00:00:00Z`);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime()) || e <= s) return [];
  e.setUTCDate(e.getUTCDate() - 1);
  const out: string[] = [];
  const cur = new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), 1));
  const last = new Date(Date.UTC(e.getUTCFullYear(), e.getUTCMonth(), 1));
  // 上限 600 個月（50 年）—— 資料壞掉時不要把瀏覽器掛住
  for (let i = 0; cur <= last && i < 600; i++) {
    out.push(`${cur.getUTCFullYear()}${String(cur.getUTCMonth() + 1).padStart(2, '0')}`);
    cur.setUTCMonth(cur.getUTCMonth() + 1);
  }
  return out;
}

/** 'YYYYMM' → '2026/10' */
export const ymShow = (ym: string) => `${ym.slice(0, 4)}/${ym.slice(4)}`;

/* ============================================================
 * 期別（跟著契約的繳別走）
 *
 * 【為什麼加費的期別不是月份】
 * 固定加費一期一張，期別跟著契約的繳別 —— 年繳契約一年收一次管理費，
 * 不是一年收十二次。（2026-08 之前不是這樣，見 migration_106：
 * 年繳契約因此多收了 11 個月的加費。）
 *
 * 期別的錨點是**起租月**，不是 1 月：6 月起租的年繳約，
 * 第一期是 6 月～隔年 5 月。
 * ============================================================ */

export type Cadence = 'monthly' | 'quarterly' | 'halfyear' | 'yearly' | string;

/** 一期含幾個月 */
export const cadenceStep = (c: Cadence): number =>
  (c === 'quarterly' ? 3 : c === 'halfyear' ? 6 : c === 'yearly' ? 12 : 1);

export type LeasePeriod = {
  /** 期別起月 YYYYMM —— 存進 contract_recurring_charges.start_ym 的值 */
  ym: string;
  /** 第幾期，從 1 起算 */
  n: number;
  /** 顯示用：'第 1 期 2026/10 ~ 2027/09'（月繳時只有一個月，不加波折號） */
  label: string;
};

export function leasePeriods(
  start: string | null, end: string | null, cadence: Cadence,
): LeasePeriod[] {
  const months = leaseMonths(start, end);
  if (!months.length) return [];
  const step = cadenceStep(cadence);
  const out: LeasePeriod[] = [];
  for (let i = 0; i < months.length; i += step) {
    // 最後一期可能不滿：租期 26 個月的年繳約，第三期只有 2 個月。
    // 那一期還是要收 —— 少列的話最後兩個月的加費永遠產不出來。
    const from = months[i];
    const to = months[Math.min(i + step - 1, months.length - 1)];
    out.push({
      ym: from,
      n: out.length + 1,
      label: step === 1
        ? `第 ${out.length + 1} 期 ${ymShow(from)}`
        : `第 ${out.length + 1} 期 ${ymShow(from)} ~ ${ymShow(to)}`,
    });
  }
  return out;
}

/** 某個月份落在第幾期（找不到回 null）—— 舊資料的期別可能落在期中 */
export function periodOf(periods: LeasePeriod[], ym: string): LeasePeriod | null {
  let hit: LeasePeriod | null = null;
  for (const p of periods) { if (p.ym <= ym) hit = p; else break; }
  return hit;
}
