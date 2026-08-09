/**
 * 契約每一期的應繳日。
 *
 * ============================================================
 * 【原本錯在哪】
 *
 * 舊算法是：第 i 期應繳日 = 首繳日 + i × 繳別月數。
 *
 * 兩條線各自從自己的起點往前推 —— 期別從租期起算，應繳日從首繳日算 ——
 * 中間的差距會**原封不動帶到最後一期**，而且永遠不會自己修正。
 *
 * 首繳日填 2026/5/13、租期 2026/7/1 起、月繳：
 *
 *     第 1 期 2026/07  應繳 2026/05/13   ← 差兩個月
 *     第 2 期 2026/08  應繳 2026/06/13   ← 還是差兩個月
 *     第 3 期 2026/09  應繳 2026/07/13   ← 一路差到底
 *
 * 2026-08 遇過更誇張的：年份打錯三年，整排應繳日顯示 2023 年。
 * 不會報錯，只會讓催款清單整排失準。
 *
 *
 * ============================================================
 * 【新算法：錨在期別本身，不是錨在首繳日】
 *
 * 安幸是**預繳制** —— 7 月的租金在 6 月收。所以：
 *
 *     第 i 期應繳日 = （第 i 期的第一個月 − 1 個月）的「幾號」
 *
 * 「幾號」來自 pay_day；沒設定時取首繳日的日數當預設。
 * 首繳日從此只是用來猜「幾號」，不再當作起點 —— 它的年月填錯也不會影響任何一期。
 *
 * 同一條規則直接涵蓋四種繳別，因為繳別只影響「期別怎麼切」，不影響錨點：
 *
 *     月繳   期別 07 / 08 / 09        應繳 6/13、7/13、8/13
 *     季繳   期別 07-09 / 10-12       應繳 6/13、9/13
 *     半年繳 期別 07-12 / 01-06       應繳 6/13、12/13
 *     年繳   期別 07-次年06           應繳 6/13
 *
 *
 * ============================================================
 * 【只影響顯示，不影響錢】
 *
 * 應繳日是催款用的參考日，不存進資料庫、不影響金額、不影響已收款、
 * 不影響營收認列。所以填錯只是催款清單看起來怪，改對之後整排立刻正確，
 * 沒有任何資料要修。
 */

/** 繳別 → 一期幾個月。 */
export const STEP_OF: Record<string, number> = {
  monthly: 1, quarterly: 3, halfyear: 6, yearly: 12,
};

/**
 * 那個月有幾天。用來把 31 號夾到 2 月的 28/29。
 *
 * 不夾的話 new Date(2026, 1, 31) 會溢位成 3/3 —— 應繳日直接跳到下個月，
 * 而且畫面上看起來像個正常日期，沒有人會發現。
 */
function daysInMonth(y: number, m0: number): number {
  return new Date(y, m0 + 1, 0).getDate();
}

const iso = (y: number, m0: number, d: number) =>
  `${y}-${String(m0 + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/**
 * 一期實際涵蓋的日期區間。
 *
 * ============================================================
 * 【為什麼不能只寫月份】
 *
 * 收租視窗原本把期別寫成「2026/6~2027/5」—— 那是月租單的日曆月，
 * 不是這一期真正涵蓋的時間。
 *
 * 6/13 起租的年繳約，第 1 期實際是 **2026/6/13 ~ 2027/6/12**。
 * 寫成「2026/6~2027/5」有兩個問題：
 *
 *   1. 少寫了 6/1~6/12 與 2027/6/1~6/12 這兩截，起訖都差半個月
 *   2. 跟旁邊的「應繳 2026/5/13」對不起來 —— 使用者會以為系統算錯
 *
 * 系統內部用日曆月存月租單（LT_{room}_{YYYYMM}）是實作選擇，
 * 但**畫面要講的是租約的語言**：房客租的是 6/13 到隔年 6/12。
 *
 * ============================================================
 * 【月底夾取】
 *
 * 1/31 起租的月繳約，第 2 期不能是 2/31。往前夾到 2/28（閏年 2/29）——
 * 不夾的話 JS 的 Date 會溢位成 3/3，而畫面上看起來像個正常日期。
 */
export function periodRange(
  startDate: string | null | undefined, cadence: string, index: number,
): [string, string] | null {
  if (!startDate || !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) return null;
  const step = STEP_OF[cadence] ?? 1;
  const y = Number(startDate.slice(0, 4));
  const m0 = Number(startDate.slice(5, 7)) - 1;
  const d = Number(startDate.slice(8, 10));

  /** 起租日往後推 n 個月，日數超過該月天數就夾到月底 */
  const shift = (n: number): [number, number, number] => {
    const t = m0 + n;
    const yy = y + Math.floor(t / 12);
    const mm = ((t % 12) + 12) % 12;
    return [yy, mm, Math.min(d, daysInMonth(yy, mm))];
  };

  const [fy, fm, fd] = shift(index * step);
  // 迄日 = 下一期的起日減一天。用「減一天」而不是「當月最後一天」——
  // 6/13 起租的話這一期要到隔月 12 號，不是 6/30。
  const [ny, nm, nd] = shift((index + 1) * step);
  const end = new Date(ny, nm, nd);
  end.setDate(end.getDate() - 1);

  return [
    iso(fy, fm, fd),
    iso(end.getFullYear(), end.getMonth(), end.getDate()),
  ];
}

/** 期別區間的顯示字串：`2026/6/13 ~ 2027/6/12` */
export function fmtPeriodRange(r: [string, string] | null): string {
  if (!r) return '';
  const f = (s: string) => `${Number(s.slice(0, 4))}/${Number(s.slice(5, 7))}/${Number(s.slice(8, 10))}`;
  return `${f(r[0])} ~ ${f(r[1])}`;
}

/**
 * 「幾號繳」。優先用契約設定的 pay_day，沒有就取首繳日的日數。
 * 兩個都沒有時回 null —— 呼叫端要顯示「未設定」，不要自己猜一個 1 號出來。
 */
export function resolvePayDay(payDay: number | null | undefined, firstPaymentDate: string | null | undefined): number | null {
  const p = Number(payDay);
  if (p >= 1 && p <= 31) return Math.trunc(p);
  if (firstPaymentDate && /^\d{4}-\d{2}-\d{2}$/.test(firstPaymentDate)) {
    const d = Number(firstPaymentDate.slice(8, 10));
    if (d >= 1 && d <= 31) return d;
  }
  return null;
}

/**
 * 第 index 期（0 起算）的應繳日。
 *
 * @param startDate 租期起 'YYYY-MM-DD'
 * @param cadence   monthly / quarterly / halfyear / yearly
 * @param index     第幾期，0 起算
 * @param payDay    幾號繳（1–31）
 */
export function dueDateOf(startDate: string | null | undefined, cadence: string, index: number, payDay: number | null): string | null {
  if (!startDate || !/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !payDay) return null;
  const step = STEP_OF[cadence] ?? 1;

  // 該期的第一個月，再往前一個月 —— 預繳制：7 月的租金 6 月收
  const y = Number(startDate.slice(0, 4));
  const m0 = Number(startDate.slice(5, 7)) - 1 + index * step - 1;

  // Date 會自己處理跨年（m0 = -1 → 前一年 12 月）
  const anchor = new Date(y, m0, 1);
  const ay = anchor.getFullYear();
  const am0 = anchor.getMonth();

  // 31 號遇到 2 月要夾到當月最後一天,不能讓它溢位到下個月
  return iso(ay, am0, Math.min(payDay, daysInMonth(ay, am0)));
}

/** 'YYYY-MM-DD' → '2026/6/13'（不補零,跟畫面既有的寫法一致）。 */
export function fmtDue(d: string | null): string {
  if (!d) return '';
  return `${Number(d.slice(0, 4))}/${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
}

export type DueCheck =
  | { ok: true; payDay: number; firstDue: string }
  | { ok: false; reason: 'no_start' | 'no_pay_day' }
  | { ok: true; payDay: number; firstDue: string; warn: string };

/**
 * 首繳日與算出來的第一期應繳日對不對得上。
 *
 * 對不上不是錯誤，只是要講出來 —— 使用者填了 2026/5/13，系統實際用 2026/6/13，
 * 不說的話他會以為系統壞了，或者更糟：以為 5/13 真的生效了。
 */
export function checkFirstDue(
  startDate: string | null | undefined,
  cadence: string,
  payDay: number | null,
  firstPaymentDate: string | null | undefined,
): { firstDue: string | null; mismatch: boolean } {
  const firstDue = dueDateOf(startDate, cadence, 0, payDay);
  if (!firstDue || !firstPaymentDate) return { firstDue, mismatch: false };
  return { firstDue, mismatch: firstPaymentDate !== firstDue };
}
