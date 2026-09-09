import {
  CODE_CLEAN, CODE_LABOR_REV, LABOR_BILL_TO_OFFICE,
  type HkEntry,
} from './hk-entries.ts';

/**
 * 產生前的**模擬檢查** —— 成對分錄有沒有配成對。
 *
 * ============================================================
 * 【★★★ 為什麼要在按下去之前檢查，而不是事後稽核】
 *
 * 房務的成對分錄唯一會安靜壞掉的地方是**只產生一半**:
 *
 *   有支出沒收入 → 物業付了錢，安幸帳上沒有那筆收入
 *   有收入沒支出 → 安幸收了錢，物業帳上沒有成本
 *
 * 兩種的金額都是對的，只是少了一邊 ——
 * **任何一張報表的總額看起來都不會怪**，而總額正是唯一有人會看的東西。
 *
 * 事後用 SQL 稽核當然也行（`supabase/audits/查-房務收支成對檢查.sql`），
 * 但那時候資料已經進去了，要清掉七十幾列比擋在按下去之前貴得多。
 *
 * ============================================================
 * 【★★★ 為什麼吃「要寫進去的那批列」而不是自己重算】
 *
 * 這支收的 `income` 就是待會 `upsert` 進 `orders` 的那個陣列，
 * `clean` / `labor` 就是待會寫進 `expenses` 的那兩批。
 *
 * 自己再算一次的話就是**第二份實作** —— 兩份規則遲早會漂，
 * 而漂掉的症狀是「檢查說沒問題，實際產出不一樣」，比沒有檢查更糟。
 *
 * ★ 所以這支只做**比對**，一行業務規則都不重寫。
 *
 * ============================================================
 * 【★★ 它抓得到的四種，第四種是最危險的】
 *
 *   ① 清潔費筆數／金額配不起來
 *   ② 人事費筆數／金額配不起來
 *   ③ **`LABOR_BILL_TO_OFFICE` 裡的物業名字對不到任何物業**
 *
 * ③ 是寫死名字的代價（見 `hk-entries.ts`）:物業一改名，
 * 那個 Set 就是空的 → 應該成對的人事費一筆都不產生收入，
 * 而 ① ② 通通會通過（兩邊都是 0，配得起來）。
 * **少的是一筆 20 萬，畫面上完全看不出來。**
 */

/** 一筆清潔費支出（`cleaningCosts()` 的輸出取用得到的欄位）。 */
export type CleanLike = {
  key: string;
  amount: number;
  work_date: string;
  label: string;
};

/** 一筆人事費支出（`laborCosts()` 的輸出）。 */
export type LaborLike = {
  key: string;
  amount: number;
  estate_id: string | null;
};

export type PairIssue = {
  /** `error` 會擋在眼前，`warn` 只是說明 —— 兩者都不擋按鈕 */
  level: 'error' | 'warn';
  text: string;
};

export type PairResult = {
  ok: boolean;
  /** 應該有幾筆收入（＝金額不為 0 的清潔費 ＋ 要成對的人事費） */
  expectCount: number;
  /** 實際會寫幾筆 */
  actualCount: number;
  expectAmount: number;
  actualAmount: number;
  cleanExpect: number; cleanActual: number;
  laborExpect: number; laborActual: number;
  issues: PairIssue[];
};

const sum = (ns: number[]) => ns.reduce((a, b) => a + b, 0);

/**
 * ★ 金額 0 的不產生收入（`cleaningIncome` 會濾掉），所以「應該有幾筆」
 *   算的也是金額不為 0 的那些 —— 兩邊用同一條件才比得對。
 */
const paying = <T extends { amount: number }>(rows: T[]) =>
  (rows ?? []).filter((r) => Number(r.amount) !== 0);

/** 訊息裡最多列幾筆。全部列出來的話一筆漏掉會被七十列淹掉。 */
const SHOW = 3;
const brief = (xs: string[]) =>
  xs.slice(0, SHOW).join('、') + (xs.length > SHOW ? `…等 ${xs.length} 筆` : '');

/**
 * 一筆時薪工資對應的那份工（`hourlyRows()` 的輸出，**還沒換成安幸辦公室之前**）。
 *
 * ★★★ 要的是**真正被打掃的那間房**,不是工資記在哪。
 *   `hourlyExpense()` 之後 property_id 已經變成安幸辦公室了,那時候比不出東西。
 */
export type HourJob = {
  spent_on: string;
  property_id: string | null;
  staff_name: string;
  hours: number;
};

/** 一份會產生清潔費的工（`cleaningCosts()` 的輸出）。 */
export type CleanJob = {
  work_date: string;
  property_id: string | null;
};

export function pairCheck(input: {
  clean: CleanLike[];
  labor: LaborLike[];
  income: HkEntry[];
  pairEstates: ReadonlySet<string>;
  /** 現有的所有物業名稱 —— 用來驗 `LABOR_BILL_TO_OFFICE` 對不對得到 */
  allEstateNames: readonly string[];
  /** 時薪工資對應的那幾份工。給下面「三筆規則」用 */
  hourJobs?: HourJob[];
  /** 有產生清潔費的那幾份工。同上 */
  cleanJobs?: CleanJob[];
  /** 房源 id → 名稱。只給訊息用 */
  roomName?: (id: string | null) => string;
}): PairResult {
  const issues: PairIssue[] = [];

  const cleanPay = paying(input.clean ?? []);
  const laborPay = paying(input.labor ?? [])
    .filter((r) => r.estate_id && input.pairEstates.has(r.estate_id));

  const incClean = (input.income ?? []).filter((r) => r.account_code === CODE_CLEAN);
  const incLabor = (input.income ?? []).filter((r) => r.account_code === CODE_LABOR_REV);

  /*
   * ── ③ 這裡曾經檢查「找得到安幸辦公室那個房源嗎」，2026-09-09 拿掉 ──
   *
   *   migration_235 之後收入**不掛任何房源**（`purpose_type='office'`）,
   *   所以沒有那個東西可以找不到了。
   *   留著會變成一個永遠成立的檢查 —— 那比沒有檢查更糟,
   *   因為它會讓人以為「有在看」。
   */
  // ── ④ 寫死的物業名字還對得到嗎（最危險的一條）──────
  const known = new Set(input.allEstateNames ?? []);
  const lost = LABOR_BILL_TO_OFFICE.filter((n) => !known.has(n));
  if (lost.length > 0) {
    issues.push({
      level: 'error',
      text: `找不到物業「${lost.join('、')}」—— 它的人事費不會產生安幸收入。`
        + '物業改過名的話要同步改 lib/hk-entries.ts 的 LABOR_BILL_TO_OFFICE。',
    });
  }

  // ── ① 清潔費 ──────────────────────────────────────
  if (incClean.length !== cleanPay.length) {
    const has = new Set(incClean.map((r) => r.key));
    const missing = cleanPay
      .filter((r) => !has.has(`HKREV|${r.key}`))
      .map((r) => `${r.work_date} ${r.label || '（沒填房源）'}`);
    issues.push({
      level: 'error',
      text: `清潔費 ${cleanPay.length} 筆，收入只有 ${incClean.length} 筆`
        + (missing.length ? `。缺：${brief(missing)}` : '。'),
    });
  } else {
    const a = sum(cleanPay.map((r) => Number(r.amount)));
    const b = sum(incClean.map((r) => Number(r.amount)));
    if (a !== b) {
      issues.push({
        level: 'error',
        text: `清潔費筆數對得起來，但金額不一樣：支出 $${a.toLocaleString('en-US')}`
          + `／收入 $${b.toLocaleString('en-US')}。`,
      });
    }
  }

  // ── ② 人事費 ──────────────────────────────────────
  if (incLabor.length !== laborPay.length) {
    issues.push({
      level: 'error',
      text: `要成對的人事費 ${laborPay.length} 筆，收入只有 ${incLabor.length} 筆。`,
    });
  } else {
    const a = sum(laborPay.map((r) => Number(r.amount)));
    const b = sum(incLabor.map((r) => Number(r.amount)));
    if (a !== b) {
      issues.push({
        level: 'error',
        text: `人事費筆數對得起來，但金額不一樣：支出 $${a.toLocaleString('en-US')}`
          + `／收入 $${b.toLocaleString('en-US')}。`,
      });
    }
  }

  /*
   * ── ★★★ 三筆規則（2026-09-09 使用者講清楚的）────────
   *
   *   劉姐的工單    → 三筆：安幸收入 ＋ 物業支出 ＋ 安幸支出（時薪）
   *   其他人的工單  → 兩筆：安幸收入 ＋ 物業支出
   *
   * ★★★ 所以**有工資就一定要有清潔費**。
   *   反過來不必 —— 別人做的工只有兩筆，那是對的。
   *
   * ★★ 這正是 2026-09-08 抓到的那個 bug 的形狀:
   *   「劉姐有產生支出，但沒有房源請款」。
   *   當時是人工比對發現的 —— 而人工比對不會有第二次。
   *
   * ★ 比的是「同一天 ＋ 同一間房」。工作類型不比 ——
   *   工資是按天算的,一天在同一間房不會有兩種工作類型各算一次錢。
   */
  const hj = input.hourJobs ?? [];
  if (hj.length > 0) {
    const cleaned = new Set(
      (input.cleanJobs ?? [])
        .filter((j) => j.property_id)
        .map((j) => `${j.work_date}|${j.property_id}`));
    const nameOf = input.roomName ?? ((id: string | null) => id ?? '');
    const orphan = hj.filter(
      (h) => h.property_id && !cleaned.has(`${h.spent_on}|${h.property_id}`));
    if (orphan.length > 0) {
      issues.push({
        level: 'error',
        text: `有工資、沒有清潔費（應該三筆卻只有一筆）：`
          + brief(orphan.map(
            (h) => `${h.spent_on} ${nameOf(h.property_id)} ${h.staff_name} ${h.hours} 小時`))
          + '。那幾間房安幸付了工資，卻沒有向物業收錢。',
      });
    }
  }

  /*
   * ── 說明性的（不是錯）─────────────────────────────
   *
   * ★ 金額 0 的清潔費不產生收入是**對的**,但要講出來 ——
   *   不講的話「支出 66 筆、收入 64 筆」看起來就是壞掉。
   */
  const zero = (input.clean ?? []).length - cleanPay.length;
  if (zero > 0) {
    issues.push({
      level: 'warn',
      text: `有 ${zero} 筆清潔費金額是 0，不產生收入（人工指定 0 元是「這次不用錢」）。`,
    });
  }
  const unpaired = paying(input.labor ?? []).length - laborPay.length;
  if (unpaired > 0) {
    issues.push({
      level: 'warn',
      text: `有 ${unpaired} 筆人事費只有支出、沒有安幸收入`
        + `（只有 ${LABOR_BILL_TO_OFFICE.join('、')} 成對，其餘物業本來就只有支出）。`,
    });
  }

  return {
    ok: issues.every((i) => i.level !== 'error'),
    expectCount: cleanPay.length + laborPay.length,
    actualCount: (input.income ?? []).length,
    expectAmount: sum([...cleanPay, ...laborPay].map((r) => Number(r.amount))),
    actualAmount: sum((input.income ?? []).map((r) => Number(r.amount))),
    cleanExpect: cleanPay.length, cleanActual: incClean.length,
    laborExpect: laborPay.length, laborActual: incLabor.length,
    issues,
  };
}
