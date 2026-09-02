/**
 * 房務成本 → 支出（純函式）。
 *
 * ============================================================
 * 【★★★ 合掃算一份，不是兩份】（2026-09-02 使用者確認）
 *
 * `hk-payroll.ts` 的檔頭列了三個數字三種算法。清潔費是**第四個**，
 * 而它跟布巾同一邊:
 *
 *   打掃量  兩人合掃 → 各 0.5   算薪水
 *   布巾    兩人合掃 → 算 1 組  叫貨
 *   清潔費  兩人合掃 → **付一份**  房間只被清了一次
 *
 * ★ 用打掃量那套的話，正隆一間合掃就付兩次 —— 一次 9,000。
 *
 * ★★ 所以這裡吃的是 `estateLog` 產出的 `LogEntry`（一份工一列，
 *   合掃已經合併、`units_override` 已經算進去），**不是**原始的工作項目。
 *   自己再分組一次的話，那條規則就有兩份（CLAUDE.md 的坑）。
 *
 * ============================================================
 * 【★★★ 沒有單價的不產生，而且要回傳】
 *
 * 當成 0 塞進去的話，帳會少一截而**沒有任何地方會叫** ——
 * 支出頁看到的是一筆 $0，而 $0 看起來只是「還沒填」。
 *
 * 所以分成兩袋:算得出錢的、算不出的。畫面上兩袋都要顯示。
 */

import type { LogEntry } from './hk-payroll.ts';

export type CostRow = {
  /**
   * 冪等鍵 —— 寫進 `expenses.hk_job_key`，那一欄有唯一索引。
   *
   * ★★★ 「產生本月支出」按兩次只會有一筆。沒有它的話就是兩份帳，
   *   而帳上多一筆看起來完全正常，沒有任何地方會叫。
   */
  key: string;
  work_date: string;
  property_id: string;
  /** 房源字樣，給 item_name 用 */
  label: string;
  work_type: string;
  /** 這一份工算幾間（合掃已經合併，units_override 已經算進去） */
  units: number;
  /** 每一間多少錢 */
  price: number;
  /** units × price，四捨五入到元 */
  amount: number;
};

/** 沒辦法算錢的那些，要在畫面上列出來讓人去補。 */
export type Unpriced = {
  work_date: string;
  label: string;
  units: number;
  reason: '沒有房源' | '沒設單價';
};

/**
 * 清潔費。一份工一筆。
 *
 * @param jobs    `estateLog()` 攤平後的全部 job
 * @param priceOf 房源 → 公訂價（`properties.clean_price`）
 */
export function cleaningCosts(
  jobs: LogEntry[],
  priceOf: (propertyId: string) => number | null | undefined,
): { rows: CostRow[]; unpriced: Unpriced[] } {
  const rows: CostRow[] = [];
  const unpriced: Unpriced[] = [];

  for (const j of jobs ?? []) {
    /*
     * ★ 沒有房源就沒有單價可查。這些是補登時房源留空、
     *   或房務代碼還沒接上 ERP 的 —— 兩種都要人去補，不是這裡猜。
     */
    if (!j.property_id) {
      unpriced.push({ work_date: j.work_date, label: j.label || '（沒填房源）',
                      units: j.units, reason: '沒有房源' });
      continue;
    }
    const price = priceOf(j.property_id);
    if (price == null) {
      unpriced.push({ work_date: j.work_date, label: j.label,
                      units: j.units, reason: '沒設單價' });
      continue;
    }
    /*
     * ★★ `units` 不是永遠等於 1 —— 「一筆等於好幾間」的工作
     *   （migration_198 的 units_override）要乘進去。
     *   正隆整棟一次 4 間就是 4 × 9,000。
     */
    const amount = Math.round(j.units * Number(price));
    // ★ 金額 0 的不產生。免費的清掃記一筆 $0 只會讓支出頁多一列雜訊
    if (amount === 0) continue;
    rows.push({
      key: `${j.work_date}|${j.property_id}|${j.work_type}`,
      work_date: j.work_date, property_id: j.property_id,
      label: j.label, work_type: j.work_type,
      units: j.units, price: Number(price), amount,
    });
  }
  return { rows, unpriced };
}

export type LaborCost = {
  id: string;
  estate_id?: string | null;
  property_id?: string | null;
  monthly_amount: number;
  active?: boolean;
};

export type LaborRow = {
  key: string;
  /** 該月最後一天（2026-09-02 使用者指定） */
  spent_on: string;
  estate_id: string | null;
  property_id: string | null;
  amount: number;
};

/**
 * 這個月最後一天。`period` 是 `YYYYMM`。
 *
 * ★★ 用 `new Date(y, m, 0)` —— 第三個參數給 0 會回到**上個月的最後一天**，
 *   所以月份給「下一個月」就拿到這個月的月底。閏年、大小月都不用自己判斷。
 *
 * ★ 回傳 `YYYY-MM-DD`，跟 `<input type="date">` 與資料庫同一個格式
 *   （2026-09-02 才因為兩個格式不同的字串比對而踩過一次）。
 */
export function lastDayOf(period: string): string {
  if (!/^\d{6}$/.test(period)) return '';
  const y = Number(period.slice(0, 4));
  const m = Number(period.slice(4, 6));
  if (m < 1 || m > 12) return '';
  const d = new Date(Date.UTC(y, m, 0));
  return d.toISOString().slice(0, 10);
}

/**
 * 人事費。一個月一個對象一筆。
 *
 * ★ 停用的不產生，但**既有的支出不會被刪** —— 錢付了就是付了，
 *   不該因為改了設定而從帳上消失（那是資料庫層的 comment 也寫著的）。
 */
export function laborCosts(costs: LaborCost[], period: string): LaborRow[] {
  const day = lastDayOf(period);
  if (!day) return [];
  const out: LaborRow[] = [];
  for (const c of costs ?? []) {
    if (c.active === false) continue;
    const target = c.estate_id ?? c.property_id;
    if (!target) continue;                 // 兩個都空的是壞資料，約束擋得住
    const amt = Number(c.monthly_amount);
    if (!Number.isFinite(amt) || amt <= 0) continue;
    out.push({
      key: `${period}|${target}`,
      spent_on: day,
      estate_id: c.estate_id ?? null,
      property_id: c.property_id ?? null,
      amount: Math.round(amt),
    });
  }
  return out;
}

/** 產生預覽的合計。畫面上要先看到總額再按下去。 */
export function costTotal(rows: { amount: number }[]): number {
  return (rows ?? []).reduce((a, r) => a + (Number(r.amount) || 0), 0);
}
