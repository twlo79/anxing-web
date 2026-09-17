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
 * 「幾號」來自 `payDayOf()`:pay_day 有填就用它，沒填就用**租期起日的那個「日」**。
 *
 * ★★★ 2026-09-17 之前那個退路是「首繳日的日數」，而首繳日被當成
 *   「實際第一次收到錢的那天」在填 —— 109 張契約裡有 57 張因此拿到了
 *   一個差一天、或 28／30／31 號的繳款日。使用者:「我不需要首繳日了。」
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
 * 契約日期的存檔前檢查。
 *
 * ============================================================
 * 【為什麼需要這支 —— 一個查不出原因的「存不進去」】
 *
 * 使用者把租期迄打成 **2027/4/31**。四月沒有 31 號。
 *
 * `<input type="date">` 收到不存在的日期時，`value` 會變成**空字串** ——
 * 畫面上那格還顯示著 31/04/2027，程式拿到的卻是 ''。
 * 於是 end_date 送出 null，而資料庫那一欄是 NOT NULL，
 * 存檔失敗、訊息是英文的 `null value in column "end_date"...`，
 * 2.5 秒後消失，而且**完全沒提到 4 月沒有 31 號**。
 *
 * 使用者看到的是「按了儲存沒反應」。
 *
 * ============================================================
 * 【所以空字串要當成「日期不存在」來報，不是「沒填」】
 *
 * 分不出這兩種情況 —— 使用者沒填、跟使用者填了不存在的日期，
 * 到程式這裡都是 ''。但後者遠比前者常見（日期框本來就會擋住沒填的情況），
 * 所以訊息要把「可能打了不存在的日期」講出來，並舉例。
 */
export type DateCheck = { ok: true } | { ok: false; error: string };

const BAD_DATE_HINT = '（日期框在收到不存在的日期時會自動清空，例如 4/31、6/31、2/30）';

export function checkContractDates(
  startDate: string | null | undefined,
  endDate: string | null | undefined,
  opts?: {
    /**
     * 訂金階段（`earnest_only`）：租期兩欄都空著是合法的（migration_174）。
     *
     * ★★ 只有**兩欄都空**才放行。
     *
     *   只填一邊的話仍然要擋 —— 那不是「還沒填」，那是填到一半。
     *   放行的話資料庫的 `ct_earnest_fields_chk` 會收下它
     *   （那道約束只問 `earnest_only or 三欄都有`），
     *   然後這張契約永遠帶著一個沒有結束日的租期，
     *   而月租單產生器只是安靜地跳過它。
     *
     * ★ 這一項刻意做成參數而不是「日期空就跳過」——
     *   一般契約的空日期正是這支函式當初要抓的東西
     *   （4/31 被日期框清成空字串）。兩者到程式這裡長得一模一樣，
     *   分得出來的只有呼叫端。
     */
    allowEmpty?: boolean;
  },
): DateCheck {
  const ok = (s: string | null | undefined) => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);

  // 租期都還沒定（訂金階段）—— 放行
  if (opts?.allowEmpty && !startDate && !endDate) return { ok: true };

  if (!ok(startDate)) return { ok: false, error: `租期起沒有填成有效日期${BAD_DATE_HINT}` };
  if (!ok(endDate)) return { ok: false, error: `租期迄沒有填成有效日期${BAD_DATE_HINT}` };
  if (endDate! <= startDate!) {
    return { ok: false, error: `租期迄（${endDate}）要晚於租期起（${startDate}）` };
  }
  /*
   * ★★ 2026-09-17:首繳日那三段檢查一起拿掉了。
   *   它們在檢查「首繳日是不是有效日期／有沒有比租期起早一年以上」——
   *   而首繳日已經不參與計算，也不在表單上了。
   *   一個沒有人填得到的欄位不需要守衛。
   */
  return { ok: true };
}

/**
 * 這份租約總共有幾個「月租期」。
 *
 * ============================================================
 * 【為什麼不能數日曆月】
 *
 * 系統把月租單存成 `LT_{房號}_{YYYYMM}`，一個日曆月一張。
 * 但租約是**月中到月中**的，兩者不會一一對應：
 *
 *     租期 2026/6/23 ~ 2026/9/23（季繳，每期 $5,040 = 3 × $1,680）
 *     碰到的日曆月：2026/6、7、8、9  →  4 個
 *     真正的租期數：                    3 個
 *
 * 多出來的那個月會讓季繳被切成「3 個月」+「1 個月」兩期，
 * 而且**多收一個月的租金、多認列一個月的營收**。
 *
 * ============================================================
 * 【公式】
 *
 *     期數 = 月份差 + (迄日的「日」> 起日的「日」? 1 : 0)
 *
 * 四種形狀都要對：
 *
 *     6/23 → 9/23        月差 3   23 > 23 否   → 3   （季繳一期）
 *     6/6  → 隔年 6/5    月差 12  5  > 6  否   → 12  （年繳一期）
 *     9/11 → 隔年 9/10   月差 12  10 > 11 否   → 12
 *     6/1  → 隔年 5/31   月差 11  31 > 1  是   → 12  （1 號起租，原本就對）
 *
 * 這個公式跟 migration_93 的資料庫函式**必須完全一致** ——
 * 一邊算 3 一邊算 4 的話，畫面與資料會各說各話，而且沒有人查得出來。
 */
export function rentMonthCount(
  startDate: string | null | undefined, endDate: string | null | undefined,
): number {
  if (!startDate || !endDate) return 0;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) return 0;
  const sy = Number(startDate.slice(0, 4)), sm = Number(startDate.slice(5, 7)), sd = Number(startDate.slice(8, 10));
  const ey = Number(endDate.slice(0, 4)), em = Number(endDate.slice(5, 7)), ed = Number(endDate.slice(8, 10));
  const diff = (ey * 12 + em) - (sy * 12 + sm);
  return Math.max(0, diff + (ed > sd ? 1 : 0));
}

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
 * 這張契約「每個月幾號繳」。
 *
 * ══════════════════════════════════════════════════════════
 * ★★★ 2026-09-17 改：退路從「首繳日」換成**租期起日**。
 *
 *   舊的寫法是 `pay_day` 沒填就去抓 `first_payment_date` 的「日」。
 *   問題是那一欄被當成兩種東西在填：
 *       ① 第一期的應繳日（規則）
 *       ② 實際第一次收到錢的那天（紀錄）
 *   而 109 張生效中的契約裡，**63 張**的「幾號繳」跟租期起日不一樣，
 *   其中 57 張是從 ② 推出來的 —— 差一天、31 號、28 號那種。
 *   使用者：「我不需要首繳日了。」
 *
 * ★★ 現在的規則只有兩條，由上而下：
 *       1. `pay_day` 有填 → 用它（另外談好的繳款日）
 *       2. 沒填 → **租期起日的那個「日」**
 *   `first_payment_date` 不再參與計算。欄位留在資料庫裡（那 57 張
 *   「第一次收到錢是哪天」是有用的紀錄），只是不再被讀。
 *
 * ★★★ 這支**改了名字**，不是只改參數。
 *   舊名字 `resolvePayDay(payDay, firstPaymentDate)` 的兩個參數
 *   跟新的 `payDayOf(startDate, payDay)` **型別完全一樣**（string|null、number|null）——
 *   只改參數順序的話，漏改的呼叫端會**安靜地把參數放反**而 tsc 一句話都不說。
 *   改名字才會編不過。
 * ══════════════════════════════════════════════════════════
 */
export function payDayOf(
  startDate: string | null | undefined,
  payDay: number | null | undefined,
): number | null {
  const p = Number(payDay);
  if (p >= 1 && p <= 31) return Math.trunc(p);
  if (startDate && /^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
    const d = Number(startDate.slice(8, 10));
    if (d >= 1 && d <= 31) return d;
  }
  return null;
}

/** 繳別的中文。跟契約頁的 `CAD_LABEL` 同一組字 */
const CAD_WORD: Record<string, string> = {
  monthly: '每月', quarterly: '每季', halfyear: '每半年', yearly: '每年',
};

/**
 * 應繳日的人話。（2026-09-17 使用者指定的四種寫法）
 *
 *     月繳　　每月 1 號
 *     季繳　　每季 1 號　　　＋「也就是 11／2／5／8 月的 1 號」
 *     半年繳　每半年 1 號　　＋「也就是 11／5 月的 1 號」
 *     年繳　　每年 11 月 1 號
 *
 * ★★★ 季／半年一定要說出**是哪幾個月**。只寫「每季 1 號」的話，
 *   看的人不知道是哪一季 —— 而那正是他要查這一行的原因。
 *   月份從租期起的那個月往後推，因為第一期就是從那個月開始收。
 *
 * ★★ 年繳要寫「幾月幾號」:一年只有一次，月份是它最重要的資訊。
 *
 * ★ 回兩段而不是一個字串 —— 畫面要把它們排成兩行（大字 ＋ 灰字），
 *   在這裡黏成一句的話，畫面就得再把它拆開，而拆的規則會跟這裡不一致。
 */
export function dueDayText(
  startDate: string | null | undefined,
  cadence: string,
  payDay?: number | null,
): { text: string; months: string; clamp: string } {
  const d = payDayOf(startDate, payDay);
  if (!d) return { text: '', months: '', clamp: '' };

  /*
   * ★ 31 號在沒有 31 號的月份會落在當月最後一天（`dueDateOf()` 的 `Math.min`）。
   *   28 以上就講出來 —— 不講的話「每月 31 號」在二月變成 28 號，
   *   而使用者會以為系統算錯。
   */
  const clamp = d > 28
    ? `${d} 號在沒有 ${d} 號的月份會落在當月最後一天（例如 2 月）。` : '';

  const word = CAD_WORD[cadence] ?? '每月';
  const step = STEP_OF[cadence] ?? 1;

  if (cadence === 'monthly') return { text: `每月 ${d} 號`, months: '', clamp };

  const m = startDate && /^\d{4}-\d{2}-\d{2}$/.test(startDate)
    ? Number(startDate.slice(5, 7)) : 0;
  if (!m) return { text: `${word} ${d} 號`, months: '', clamp };

  if (cadence === 'yearly') return { text: `每年 ${m} 月 ${d} 號`, months: '', clamp };

  const ms: number[] = [];
  for (let i = 0; i < 12 / step; i++) ms.push(((m - 1 + i * step) % 12) + 1);
  return { text: `${word} ${d} 號`, months: `也就是 ${ms.join('／')} 月的 ${d} 號`, clamp };
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

/*
 * ★★ `checkFirstDue()` 與 `DueCheck` 在 2026-09-17 一起刪掉。
 *   它們的工作是「首繳日跟算出來的第一期應繳日對不對得上」——
 *   而首繳日已經不參與計算了，那個比較沒有意義。
 *   留著一支永遠回 `mismatch: false` 的檢查，比沒有它更糟：
 *   下一個人會以為那裡有人在看著。
 */
