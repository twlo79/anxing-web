/**
 * 合掃分攤的**事前預覽**。
 *
 * ============================================================
 * 【為什麼需要這個】（2026-09-01 使用者：「不要單間計入」）
 *
 * 一間房只有一間。兩個人一起掃就是各 0.5 —— `hk-payroll.ts` 的
 * `crewSize()` 已經是這樣算的，**問題不在算得對不對，在看不看得見**。
 *
 * ★★★ 分母是「同一天、同一間、同一種工作的**全部**列」，
 *   不只是你剛剛勾的那幾個人。
 *
 *   所以在既有的一筆上再補一個人進去，**原本那個人會從 1 間掉到 0.5 間**。
 *   那是對的，但如果存檔前不講，畫面上只會看到
 *   「我明明是補資料，怎麼 Ayu 反而變少了」。
 *
 * ★ 這一支就是把「按下去之後會變成怎樣」先算出來給人看。
 *   跟同步建議的打勾／打叉同一個道理:**系統負責看見，人負責決定。**
 *
 * ============================================================
 * 【★★ 為什麼不直接呼叫 payroll()】
 *
 * `payroll()` 算的是**整個月每個人的總量**，而這裡要的是
 * 「這一份工，這幾個人各分到多少」——
 * 把整月的數字丟給人看，他得自己去減才知道差多少。
 *
 * 兩者的分母規則必須一致，所以 `jobKey` 的定義在下面重寫了一次 ——
 * ★ 這是刻意的重複:`payroll` 用的是 `property_id`（對到 ERP 之後的），
 *   而新增畫面上人看到的是 `property_code`（還沒對應的代碼）。
 *   共用一個函式的話，就得在畫面上先做一次對應才能預覽，
 *   而還沒對到房源的代碼根本對應不出來 —— 那正是最需要預覽的情況。
 */

export type CrewRow = {
  work_date: string;
  /** 畫面上看得到的房源代碼。null／空字串 = 沒有房源（公區、洗烘折毛巾）。 */
  property_code: string | null;
  work_type: string;
  staff_id: string | null;
};

/**
 * 同一天、同一間、同一種工作 ＝ 同一份工。
 *
 * ★ 跟 `hk-payroll.ts` 的 `jobKey` 同一條規則（那邊用 property_id）。
 *   兩邊的分母不一致的話，預覽說 0.5 而實際算成 1 —— 那比不預覽更糟。
 */
export const jobKeyByCode = (r: Pick<CrewRow, 'work_date' | 'property_code' | 'work_type'>) =>
  `${r.work_date}|${r.property_code ?? ''}|${r.work_type}`;

/** 這一份工現在有哪些人（去重）。 */
export function crewOf(rows: CrewRow[], date: string, code: string, type: string): Set<string> {
  const key = jobKeyByCode({ work_date: date, property_code: code || null, work_type: type });
  const out = new Set<string>();
  for (const r of rows) {
    if (!r.staff_id) continue;
    if (jobKeyByCode(r) === key) out.add(r.staff_id);
  }
  return out;
}

export type SharePreview = {
  staffId: string;
  /** 加入之前這個人在這份工上分到幾間。0 = 本來不在這份工上。 */
  before: number;
  /** 加入之後分到幾間。 */
  after: number;
  /** 這次要新加進去的人。 */
  isNew: boolean;
};

/**
 * 按下「加入」之後，這份工上每個人會變成幾間。
 *
 * @param rows     這個月已經有的全部工作項
 * @param date     要補的日期
 * @param code     房源代碼（空字串 = 沒有房源）
 * @param type     工作類型
 * @param staffIds 這次勾選的人
 *
 * ★★ 回傳**包含原本就在的人**，因為他們的數字也會變 ——
 *   只列新加的那幾個的話，「Ayu 為什麼變少」還是沒有答案。
 *
 * ★ 已經在這份工上的人再勾一次不會重複計算（`crewOf` 用 Set）。
 *   不去重的話他自己跟自己合掃，兩筆各 0.5，總量憑空少一半。
 */
export function sharePreview(
  rows: CrewRow[], date: string, code: string, type: string, staffIds: string[],
): SharePreview[] {
  const now = crewOf(rows, date, code, type);
  const next = new Set([...now, ...staffIds.filter(Boolean)]);
  if (next.size === 0) return [];

  const beforeShare = now.size > 0 ? 1 / now.size : 0;
  const afterShare = 1 / next.size;

  return [...next].map((id) => ({
    staffId: id,
    before: now.has(id) ? beforeShare : 0,
    after: afterShare,
    isNew: !now.has(id),
  }));
}

/**
 * 顯示用：0.5 這種小數寫得好看。
 *
 * ★ 跟 `hk-payroll.ts` 的 `fmtUnits` 同一套 —— 同一個數字在兩個地方
 *   長得不一樣的話，人會以為那是兩個不同的數字。
 */
export function fmtShare(n: number): string {
  if (!Number.isFinite(n)) return '0';
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

/**
 * 把預覽變成一句人話。沒有東西要說就回 null。
 *
 * @param nameOf 拿 staff_id 換名字
 *
 * ★★★ 「有人會變少」是**最重要的那一句**，所以單獨挑出來講。
 *   混在「Ayu 0.5、劉姐 0.5」裡的話沒有人會發現那是「掉下來」的。
 */
export function previewText(
  p: SharePreview[], nameOf: (id: string) => string,
): { line: string; warn: string | null } | null {
  if (p.length === 0) return null;

  const line = `${p.length} 個人合掃 → `
    + p.map((x) => `${nameOf(x.staffId)} ${fmtShare(x.after)} 間`).join('・');

  const dropped = p.filter((x) => !x.isNew && x.after < x.before);
  const warn = dropped.length
    ? `${dropped.map((x) => `${nameOf(x.staffId)} 會從 ${fmtShare(x.before)} 間變成 ${fmtShare(x.after)} 間`).join('、')}`
    : null;

  return { line, warn };
}
