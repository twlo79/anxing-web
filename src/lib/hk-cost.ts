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
import {
  splitJobKey, splitExpenseKey, hasSplit, type SplitLine,
} from './work-split.ts';

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
  /** units × price，四捨五入到元。★ 有 `amount_override` 時就是那個值 */
  amount: number;
  /** 這筆是不是人工指定金額的（migration_215）。影響項目名稱要不要印 ×N */
  fixedAmount?: boolean;
  /**
   * 這筆是從哪一份工拆出來的（migration_216）。
   *
   * ★ 畫面上要縮排在那份工底下 —— 不然三筆各自獨立的 $1,500
   *   看起來像三份工，而它是一份。
   *
   * ★★★ 這是**工單上的原始代碼字樣**，不是拿來顯示的字。
   *   空字串（沒填房源）就是空字串，不要在這裡代成「（沒填房源）」——
   *   畫面把那四個字存回 `job_code` 的話，`splitJobKey` 就對不上了，
   *   而症狀是「拆完存好了，但支出沒有變」，完全沒有錯誤訊息
   *   （CLAUDE.md:兩個格式不同的字串拿去比對，2026-09-02 踩過）。
   *   顯示的代換交給畫面。
   */
  splitOf?: string;
  /** 有拆帳就是 true。★ 用它判斷「是不是拆出來的」，不要判斷 `splitOf` 是不是空字串 */
  fromSplit?: boolean;
};

/** 沒辦法算錢的那些，要在畫面上列出來讓人去補。 */
export type Unpriced = {
  work_date: string;
  label: string;
  units: number;
  reason: '沒有房源' | '沒設單價';
  /**
   * ★★ 帶著工作類型，畫面才組得出 `splitJobKey` 去開拆帳。
   *   少了它，「算不出錢」那一區就只能看不能修 ——
   *   而那一區正是最需要就地補的地方（CLAUDE.md:編輯用的欄位
   *   不要放在會消失的畫面上）。
   */
  work_type: string;
  /**
   * ★★★ 工單上的**原始**代碼字樣（可能是空字串）。
   *   `label` 是拿來看的（空的會顯示成「（沒填房源）」），
   *   存拆帳時一定要用這一支 —— 把顯示字存回去的話 key 就對不上，
   *   而症狀是「存好了但支出沒變」，沒有任何錯誤訊息。
   */
  job_code: string;
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
  splitsOf?: Map<string, SplitLine[]>,
): { rows: CostRow[]; unpriced: Unpriced[] } {
  const rows: CostRow[] = [];
  const unpriced: Unpriced[] = [];

  for (const j of jobs ?? []) {
    /*
     * ══════════ 拆帳:一份工記到好幾間 ══════════
     * （2026-09-03 使用者:「我想要在表單上呈現一項 然後支出拆成多間」）
     *
     * ★★★ 拆過的**完全不走下面那套**:不查單價、不乘間數、
     *   也不會進 unpriced。這正是拆帳存在的理由 ——
     *   「正隆多間」根本不在房源主檔，查不到任何單價。
     *
     * ★★ 間數與單價寫 0 並且 `fixedAmount`。畫面上不要印「×N」
     *   或「0.5 × $0」—— 那是一個算不出 $1,500 的算式，
     *   看得懂的人會停下來算，然後以為系統錯了。
     *
     * ★ 金額 0 的那一列照樣產生（不像下面會 `continue` 掉）——
     *   人明確填了 0 是「這一間這次不用錢」，跟「算出來剛好是 0」不同。
     *   略過的話那一間會從拆帳清單上消失，而合計看起來還是對的。
     */
    const sp = splitsOf?.get(splitJobKey(j));
    if (hasSplit(sp)) {
      for (const s of sp!) {
        rows.push({
          key: splitExpenseKey(s.id),
          work_date: j.work_date,
          property_id: s.property_id,
          label: s.property_label ?? '',
          work_type: j.work_type,
          units: 0, price: 0,
          amount: Math.round(Number(s.amount) || 0),
          fixedAmount: true,
          splitOf: j.label ?? '',
          fromSplit: true,
        });
      }
      continue;
    }

    /*
     * ★ 沒有房源就沒有單價可查。這些是補登時房源留空、
     *   或房務代碼還沒接上 ERP 的 —— 兩種都要人去補，不是這裡猜。
     */
    if (!j.property_id) {
      unpriced.push({ work_date: j.work_date, label: j.label || '（沒填房源）',
                      units: j.units, reason: '沒有房源',
                      work_type: j.work_type, job_code: j.label ?? '' });
      continue;
    }
    const price = priceOf(j.property_id);
    /*
     * ★★★ 有覆寫金額就不需要單價（migration_215）——
     *   「這份工要付 1,500」是人直接講的，不經過任何乘法。
     *   少了這個條件，正隆多間那三筆會被判成「沒設單價」而掉出去，
     *   而它們明明已經有金額了。
     */
    if (price == null && j.amountOverride == null) {
      unpriced.push({ work_date: j.work_date, label: j.label,
                      units: j.units, reason: '沒設單價',
                      work_type: j.work_type, job_code: j.label ?? '' });
      continue;
    }
    /*
     * ★★ `units` 不是永遠等於 1 —— 「一筆等於好幾間」的工作
     *   （migration_198 的 units_override）要乘進去。
     *   正隆整棟一次 4 間就是 4 × 9,000。
     */
    /*
     * ★★★ 有指定金額就用它（migration_215，2026-09-03 使用者選 B）。
     *
     *   起因:正隆一份工掃三間、工作量算一半 → 每間 9000/6 = 1,500。
     *   而 1/6 = 0.1666… 用「間數 × 單價」表達不出來 ——
     *   間數存兩位小數，0.17 算出來是 1,530。
     *
     * ★★ 代價要知道:金額與「間數 × 單價」從此**可能不一致**。
     *   這正是 CLAUDE.md 那條「推導值存成欄位」在警告的形狀 ——
     *   差別是這裡的覆寫是**人明確填的**，不是程式算完存起來的，
     *   而且只有填了才生效（null 一律走公式）。
     */
    const amount = j.amountOverride != null
      ? Math.round(Number(j.amountOverride))
      : Math.round(j.units * Number(price));
    // ★ 金額 0 的不產生。免費的清掃記一筆 $0 只會讓支出頁多一列雜訊
    if (amount === 0) continue;
    rows.push({
      key: `${j.work_date}|${j.property_id}|${j.work_type}`,
      work_date: j.work_date, property_id: j.property_id,
      label: j.label, work_type: j.work_type,
      units: j.units, price: Number(price ?? 0), amount,
      fixedAmount: j.amountOverride != null,
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

/**
 * 支出的預設項目名稱。
 *
 * ============================================================
 * 【★★★ 為什麼要抽出來】（2026-09-03）
 *
 * 這個字串本來寫在兩個地方 —— 預覽表格一份、`generateInner()` 一份 ——
 * 而它們**已經不一樣了**：預覽在後面多印一段灰色的「1 × $9,000」，
 * 寫進資料庫的沒有。人事費更糟，預覽印「（房源）」那四個字，
 * 而那是我當初寫死的佔位字，從來沒帶進過房源名。
 *
 * 症狀是**看到的跟存進去的不是同一個東西**，而畫面上完全看不出來
 * —— 跟 CLAUDE.md 那條「同一條規則在三個地方各寫一次」同一種病。
 *
 * ★ 現在畫面與寫入都呼叫這一支。要改名字改這裡。
 *
 * ============================================================
 * 【★★ 改了這裡不會動到已經產生的支出】
 *
 * 產生是 `upsert` ＋ `ignoreDuplicates`，既有的那筆不會被覆蓋。
 * 所以改完之後八月的舊資料維持舊名字，九月才是新的 ——
 * 這是刻意的（已經對過的帳不該無聲變動），但要知道會有兩種名字並存。
 */

/**
 * 清潔費。★ `units` 是 1 的時候不印 —— 「房務清潔 1485 ×1」是雜訊。
 *
 * ★★★ **金額是人工指定的時候也不印**（`fixedAmount`，migration_215）。
 *   印了會變成「×0.17」配一筆 1,500 —— 而 0.17 × 9,000 是 1,530。
 *   一個看得懂的人會停下來算，然後以為系統錯了。
 *   ×N 這個後綴的意思是「金額是這樣乘出來的」，不是就不該印。
 */
export function cleanItemName(label: string, units: number, fixedAmount = false): string {
  const u = Number(units);
  const suffix = !fixedAmount && u !== 1 && Number.isFinite(u)
    ? ` ×${Number(u.toFixed(2))}` : '';
  return `房務清潔 ${label ?? ''}`.trimEnd() + suffix;
}

/**
 * 人事費。
 *
 * ★ 沒有物業／房源字樣 —— 表格已經有「物業」與「房源」兩欄
 *   （2026-09-03 使用者:「項目1 物業2 房源3」）。
 *   名字裡再寫一次只是把同一件事講兩遍，而兩邊不同步時就變成矛盾。
 */
export const LABOR_ITEM_NAME = '房務人事費';
