/**
 * 損益表。**只算數字，不管版面。**
 *
 * ============================================================
 * 【三段式，不是「收入 − 支出」一條線】（2026-08-15 使用者指定）
 *
 *     物業收入
 *   − 物業成本
 *   ─────────────
 *   = 物業毛利        ← 每一棟各一欄。看得出哪一棟在賠錢
 *   − 營業費用        ← 辦公室（purpose_type='office'），不分攤
 *   ─────────────
 *   = 本期損益
 *
 * 【為什麼辦公室費用不分攤到各物業】
 *
 * 按收入比例攤下去的話，「開封整棟」那一欄會出現一筆它從來沒花過的錢。
 * 分攤基準是人訂的 —— 換一個基準，同一棟就從賺錢變賠錢，
 * 而看報表的人不會知道那個數字是被算出來的還是真的花掉的。
 *
 * 物業毛利保持乾淨:那一欄的每一塊錢都對得到一筆真實的收支。
 * 辦公室費用單獨站一段，是公司的共同成本，本來就不屬於任何一棟。
 *
 *
 * ============================================================
 * 【認列基礎，不是收付基礎】
 *
 *   收入  `revenue_recognitions.month_amount` —— 已經按住宿天數拆好的月份認列，
 *         不是 `orders.amount`。跨月訂單在 orders 上是一整筆，
 *         只有這張表知道三萬元裡有多少落在 8 月。
 *
 *   支出  `expenses.spent_on` ＋ **遞延已經拆成子單**。
 *         母單的 `amount` 是「這一天認列多少」，`gross_amount` 才是實付總額 ——
 *         用 gross_amount 的話，一筆付一年的保險費會整包砸在某個月，
 *         那個月憑空虧損，而後面十一個月憑空獲利。
 *
 * 損益表要的是「這段期間發生了什麼」，不是「這段期間錢進出多少」。
 * 後者是現金流量表，那是另一張表。
 *
 *
 * ============================================================
 * 【為什麼抽成純函式】
 *
 * 版面歪了看一眼就知道，數字錯了不會有任何徵兆。
 * 2026-08 儀表板顯示營收 0（實際八百多萬）就是這樣過去的。
 * 會算錢的部分要有測試。
 */

import { srcLabel, isOffice, isCompany } from './revenue-report.ts';

export type PnlRev = {
  source: string;
  estate_id: string | null;
  month_amount: number | string;
  fee_type?: string | null;
};

export type PnlExp = {
  spent_on: string;
  amount: number | string;
  account_code: string | null;
  purpose_type: string;
  estate_id: string | null;
  /** 遞延母單。它的 amount 是這一期認列的金額，不是實付 */
  deferred?: boolean | null;
  gross_amount?: number | string | null;
  /** 遞延子單。有值就是子單 */
  parent_expense_id?: string | null;
};

/** 一列 = 一個科目。cells 依 estate 順序，最後一格是合計 */
export type PnlLine = {
  label: string;
  /** estate_id → 金額。沒有掛物業的落在 '' */
  by: Map<string, number>;
  total: number;
};

export type PnlBlock = {
  lines: PnlLine[];
  by: Map<string, number>;
  total: number;
};

export type Pnl = {
  income: PnlBlock;
  cost: PnlBlock;
  /** 物業毛利 = income − cost */
  gross: { by: Map<string, number>; total: number };
  /** 營業費用（辦公室）。不分攤，所以只有 total */
  opex: PnlBlock;
  /** 本期損益 = gross.total − opex.total */
  net: number;
};

const num = (v: number | string | null | undefined) => Number(v) || 0;

/**
 * 遞延支出要用哪一筆。
 *
 * 一筆遞延會有 1 張母單 ＋ N 張子單，而**兩邊的 amount 都是認列金額**。
 * 全部相加就會重複算一次母單那一期。
 *
 * 規則:母單只在它自己那一期算一次，子單各自算各自的期。
 * 也就是 —— 兩種都算 amount，都不要碰 gross_amount。
 * `gross_amount` 是給「這筆總共付了多少」用的，不是損益表要的數字。
 *
 * 這支函式存在的意義是把上面那段話變成程式碼，而不是散在頁面裡。
 */
export function accrualAmount(e: PnlExp): number {
  return num(e.amount);
}

/**
 * 收入的科目名稱。
 *
 * 認列表沒有 `account_code` —— 它用 `source`（airbnb/longterm/oneoff…），
 * 一次性收入再用 `fee_type` 細分（清潔費、垃圾代收費…）。
 *
 * 損益表上「其他收入」全部擠成一列的話，看報表的人得再去營收頁翻一次
 * 才知道那三十萬是什麼。所以一次性收入拆到 fee_type。
 */
export function incomeLabel(r: PnlRev): string {
  if (r.source === 'oneoff' && r.fee_type) return r.fee_type;
  return srcLabel(r.source);
}

/** 依科目彙總成一組列。`keyOf` 決定科目名，`estOf` 決定落在哪一欄 */
function group<T>(
  rows: T[],
  keyOf: (r: T) => string,
  estOf: (r: T) => string,
  amtOf: (r: T) => number,
  order?: string[],
): PnlBlock {
  const map = new Map<string, PnlLine>();
  const by = new Map<string, number>();
  let total = 0;

  for (const r of rows) {
    const k = keyOf(r);
    const est = estOf(r);
    const amt = amtOf(r);
    if (!map.has(k)) map.set(k, { label: k, by: new Map(), total: 0 });
    const line = map.get(k)!;
    line.by.set(est, (line.by.get(est) ?? 0) + amt);
    line.total += amt;
    by.set(est, (by.get(est) ?? 0) + amt);
    total += amt;
  }

  /*
   * 排序:有指定順序的照指定的，其餘依金額由大到小。
   *
   * 不用字母序 —— 損益表是拿來找「哪一項特別大」的，
   * 而字母序會把最大的那一項藏在中間。
   */
  const lines = [...map.values()].sort((a, b) => {
    if (order) {
      const ia = order.indexOf(a.label), ib = order.indexOf(b.label);
      if (ia >= 0 || ib >= 0) return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
    }
    return Math.abs(b.total) - Math.abs(a.total);
  });

  return { lines, by, total };
}

/**
 * @param revs 期間內的營收認列
 * @param exps 期間內的支出（已依 spent_on 篩好）
 * @param nameOf 科目代碼 → 名稱。查不到就回代碼本身 —— 至少看得出是哪一個
 */
export function buildPnl(
  revs: PnlRev[],
  exps: PnlExp[],
  nameOf: (code: string | null) => string,
): Pnl {
  /*
   * 收入。
   *
   * 辦公室出租與公司登記不掛物業（estate_id 是 null），它們會落在 '' 那一欄。
   * 那是對的 —— 那些錢確實不是任何一棟帶進來的，
   * 硬塞給某一棟會讓那棟的毛利虛胖。
   */
  const income = group(
    revs,
    incomeLabel,
    (r) => r.estate_id ?? '',
    (r) => num(r.month_amount),
  );

  /*
   * 物業成本 vs 營業費用，界線就是 purpose_type。
   *
   * `office` 是安幸自己的辦公室（`estate_id` 與 `property_id` 都必須是 null，
   * 資料庫層有約束）。其餘都是某一棟的花費。
   */
  const estExp = exps.filter((e) => e.purpose_type !== 'office');
  const officeExp = exps.filter((e) => e.purpose_type === 'office');

  const cost = group(
    estExp,
    (e) => nameOf(e.account_code),
    (e) => e.estate_id ?? '',
    accrualAmount,
  );

  const opex = group(
    officeExp,
    (e) => nameOf(e.account_code),
    () => '',
    accrualAmount,
  );

  // 毛利要逐欄算。用 total 相減再攤回去的話，某一欄只有收入沒有成本時會消失
  const gross = new Map<string, number>();
  for (const k of new Set([...income.by.keys(), ...cost.by.keys()])) {
    gross.set(k, (income.by.get(k) ?? 0) - (cost.by.get(k) ?? 0));
  }

  return {
    income,
    cost,
    gross: { by: gross, total: income.total - cost.total },
    opex,
    net: income.total - cost.total - opex.total,
  };
}

/**
 * 這份損益表用到哪些物業欄，依總收入由大到小。
 *
 * 【為什麼不列出全部物業】
 * 這段期間沒有任何收支的物業擺上去只是一整欄的 0，
 * 而一張二十欄的表裡有十二欄是 0 的時候，人會停止橫向捲動。
 *
 * '' 這一欄（沒掛物業的收入／支出）永遠排最後，
 * 而且只在真的有數字時才出現。
 */
export function estateColumns(p: Pnl): string[] {
  const keys = new Set<string>([
    ...p.income.by.keys(), ...p.cost.by.keys(),
  ]);
  const withEstate = [...keys].filter((k) => k !== '');
  withEstate.sort((a, b) =>
    ((p.income.by.get(b) ?? 0) - (p.cost.by.get(b) ?? 0))
    - ((p.income.by.get(a) ?? 0) - (p.cost.by.get(a) ?? 0)));

  const hasBlank = (p.income.by.get('') ?? 0) !== 0 || (p.cost.by.get('') ?? 0) !== 0;
  return hasBlank ? [...withEstate, ''] : withEstate;
}

/** 三段相加要等於本期損益。畫面上放一條對帳線,不用另外寫檢查程式 */
export function pnlBalances(p: Pnl): boolean {
  return Math.abs((p.income.total - p.cost.total - p.opex.total) - p.net) < 0.005;
}

export { isOffice, isCompany };
