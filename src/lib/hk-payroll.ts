/**
 * 房務的打掃量、布巾與報酬（純函式）。
 *
 * ============================================================
 * 【三個數字，三種算法，不能混用】
 *
 *   打掃量   給人的工作量    兩人合掃一間 → **各 0.5**
 *   布巾     給倉庫叫貨用    兩人合掃一間 → **算 1 間**
 *   報酬點數 給算薪用        打掃量 × 該房源的難度點數
 *
 * 前兩個的差別是這整支最容易寫錯的地方：**同一件事，除以人數 vs 不除**。
 *
 * 兩人合掃 A15：
 *   · 工作量各算 0.5 —— 因為那間房只被清了一次，兩個人分那份工
 *   · 布巾算 1 組    —— 房間只有一張床，不會因為兩個人去就變兩張
 *
 * 用同一個數字去算兩件事，其中一件一定是錯的。
 * 而錯的那件不會報錯：布巾多叫一倍只是倉庫多囤，
 * 工作量多算一倍是每個月多發的薪水。
 */

export type PayrollRow = {
  work_date: string;
  property_id: string | null;
  /** 同一天同一間的「同一種工作」才算合掃 —— 退房與入住是兩次不同的工作 */
  work_type: string;
  staff_id: string | null;
};

/** 同一天、同一間、同一種工作 = 同一份工 */
const jobKey = (r: PayrollRow) => `${r.work_date}|${r.property_id ?? ''}|${r.work_type}`;

/**
 * 每一份工有幾個人做。
 *
 * 【為什麼要先算這個】
 * 「兩人合掃各 0.5」不能逐筆判斷 —— 看單獨一筆永遠不知道旁邊還有沒有人。
 * 要先把整批掃過一遍，才知道每一份工被幾個人分。
 *
 * 同一個人在同一份工上有兩筆（重複指派）只算一個人 —— 不然他自己
 * 跟自己「合掃」，每筆變 0.5，總量憑空少一半。
 */
export function crewSize(rows: PayrollRow[]): Map<string, number> {
  const crew = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!r.staff_id) continue;                 // 沒指派的不算任何人的工作量
    const k = jobKey(r);
    (crew.get(k) ?? crew.set(k, new Set()).get(k)!).add(r.staff_id);
  }
  return new Map([...crew].map(([k, s]) => [k, s.size]));
}

/**
 * 每個人的打掃量。合掃的除以人數。
 *
 * 回傳的是小數（0.5、1.5…）—— 不要在這裡四捨五入。
 * 每一筆都進位的話，一個月幾十筆會累積出好幾間的差，
 * 而那個差直接變成多發的薪水。
 */
export function cleanUnits(rows: PayrollRow[]): Map<string, number> {
  const crew = crewSize(rows);
  const out = new Map<string, number>();
  // 同一個人在同一份工上重複出現時只算一次
  const counted = new Set<string>();
  for (const r of rows) {
    if (!r.staff_id) continue;
    const k = jobKey(r);
    const dedupe = `${k}|${r.staff_id}`;
    if (counted.has(dedupe)) continue;
    counted.add(dedupe);
    const n = crew.get(k) ?? 1;
    out.set(r.staff_id, (out.get(r.staff_id) ?? 0) + 1 / n);
  }
  return out;
}

/**
 * 布巾要算幾間 —— **一份工算一間，不管幾個人做**。
 *
 * 回傳去重後的「哪一天哪一間」，組數再乘床數。
 * 沒有房源的工作（洗烘折毛巾、協助行政）不帶布巾。
 */
export function linenJobs(rows: PayrollRow[]): { work_date: string; property_id: string }[] {
  const seen = new Set<string>();
  const out: { work_date: string; property_id: string }[] = [];
  for (const r of rows) {
    if (!r.property_id) continue;
    const k = jobKey(r);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ work_date: r.work_date, property_id: r.property_id });
  }
  return out;
}

/**
 * 布巾組數 = Σ 每一份工的房源床數。
 *
 * 【床數沒填的要另外報，不能當成 0】
 * 當成 0 的話那間房就靜靜地少帶一組床單 —— 房務到現場才發現，
 * 而總數看起來完全正常。
 */
export function linenSets(
  rows: PayrollRow[],
  bedsOf: (propertyId: string) => number | null | undefined,
  countLinen: (propertyId: string) => boolean = () => true,
): { sets: number; unknown: number } {
  let sets = 0, unknown = 0;
  for (const j of linenJobs(rows)) {
    if (!countLinen(j.property_id)) continue;
    const b = bedsOf(j.property_id);
    if (b == null) { unknown++; continue; }
    sets += b;
  }
  return { sets, unknown };
}

export type PayrollLine = {
  staffId: string;
  /** 打掃量（合掃已經除過人數） */
  units: number;
  /** 報酬點數 = Σ 每筆的打掃量 × 該房源點數 */
  points: number;
  /** 有幾筆算不出點數（房源還沒設） */
  unknownPoints: number;
};

/**
 * 報酬點數 ＝ 打掃量 × 房源的打掃點數。
 *
 * ============================================================
 * 【為什麼點數在房源上，不在人身上】
 *
 * 難度是房子的性質，不是人的。開封4F 四層樓爬上爬下就是比 A5 累，
 * 誰去掃都一樣。
 *
 * 掛在人身上的話，每換一個人負責就要重設一次 —— 而漏設的那次
 * 不會報錯，只會讓那個月的報酬少一截。
 *
 * 【點數算不出來要報，不能當成 0】
 * 房源沒設點數就當 0 的話，那個人那筆白做了 —— 而他要自己去對帳
 * 才會發現。所以分開回傳。
 */
export function payroll(
  rows: PayrollRow[],
  pointsOf: (propertyId: string | null) => number | null | undefined,
): Map<string, PayrollLine> {
  const crew = crewSize(rows);
  const out = new Map<string, PayrollLine>();
  const counted = new Set<string>();

  for (const r of rows) {
    if (!r.staff_id) continue;
    const k = jobKey(r);
    const dedupe = `${k}|${r.staff_id}`;
    if (counted.has(dedupe)) continue;
    counted.add(dedupe);

    const line = out.get(r.staff_id)
      ?? { staffId: r.staff_id, units: 0, points: 0, unknownPoints: 0 };
    const share = 1 / (crew.get(k) ?? 1);
    line.units += share;

    const p = pointsOf(r.property_id);
    if (p == null) line.unknownPoints++;
    else line.points += share * p;

    out.set(r.staff_id, line);
  }
  return out;
}

/**
 * 顯示用：把 0.5 這種小數寫得好看。
 *
 * 3 → 「3」、3.5 → 「3.5」。不寫成 3.50 —— 多數是整數，
 * 整排「12.00」會讓人以為那是金額。
 */
export const fmtUnits = (n: number) =>
  Number.isInteger(n) ? String(n) : n.toFixed(1);
