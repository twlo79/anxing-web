/**
 * 時薪人員（劉姐）的支出 —— 時數 × 時薪，平均攤到那天做的房源。
 *
 * ============================================================
 * 【為什麼不能沿用清潔費那一套】（2026-09-07 使用者:「劉姐的也要進支出」）
 *
 * 清潔費是「這間房被清了一次，值多少錢」——
 * key 是 `日期|房源|工作類型`，**裡面沒有人**。那對按間計酬的人剛好:
 * 房間的價錢就是清的人拿的錢。
 *
 * 劉姐是**時薪**。她那天做了幾間跟她拿多少錢沒有關係 ——
 * 5 小時就是 5 × 500，不管掃一間還是四間。
 *
 *
 * ============================================================
 * 【★★★ 取代，不是相加】（2026-09-07 使用者選「取代」）
 *
 *   一份工**全部都是時薪人員**做的 → **不產生清潔費**，
 *                                      那幾間的成本改由她的工時支出承擔
 *   只要有一個間數人員在裡面       → 清潔費**原價照算**（2026-09-07 使用者:
 *                                      「合掃 各算各的」「劉姐一樣用時數算錢」）
 *
 * ★★ 第二條刻意**不打折**。14B3 是庭玉跟劉姐合掃的 ——
 *   把清潔費砍一半的話庭玉的錢會默默少掉，而她是按間計酬的,
 *   那份工對她的價值沒有因為旁邊多一個人而變少。
 *
 * ★ 兩邊各算各的,所以那份工的總成本確實會比只有庭玉做時高 ——
 *   那是事實:那天有兩個人在那間房裡。
 *
 *
 * ============================================================
 * 【★★★ 攤分要湊得回總數】
 *
 * 5 小時 × 500 = 2,500 攤到三間 → 833.33…。三個都四捨五入成 833
 * 的話合計是 2,499 —— **少一塊**。而那一塊不會有任何地方叫,
 * 只會讓那個月的房務成本跟薪資表差一點點,
 * 然後每個月差的金額都不一樣,沒有人查得出來源。
 *
 * 所以餘數補在第一筆:834 / 833 / 833，加起來剛好 2,500。
 */

export type HourDay = {
  work_date: string;
  staff_id: string;
  /** 那天上了幾小時。null／0 = 沒上班。 */
  hours: number | null;
};

export type HourlyStaff = {
  id: string;
  name: string;
  /** 時薪。null／0 = 還沒設，那個人不產生支出（見 `missingRate`）。 */
  hourly_rate?: number | null;
};

/** 一份工（`estateLog()` 攤平後的 LogEntry 取用得到的那幾個欄位）。 */
export type HourlyJob = {
  work_date: string;
  property_id: string | null;
  work_type: string;
  staffIds: string[];
};

export type HourlyRow = {
  key: string;
  spent_on: string;
  staff_id: string;
  staff_name: string;
  property_id: string;
  hours: number;
  rate: number;
  /** 那天的總薪資（未攤分）。畫面上要看得到「2,500 分成三份」。 */
  dayTotal: number;
  amount: number;
  /** 那天攤了幾間。1 就是沒攤。 */
  share: number;
};

/** 算不出支出的那幾天。**要列出來,不能安靜略過。** */
export type HourlySkip = {
  work_date: string;
  staff_name: string;
  hours: number;
  reason: '沒有房源' | '沒設時薪';
};

/**
 * 這一份工是不是「只有時薪人員」做的。
 *
 * ★ 沒有指派任何人的工**不算** —— 那種是資料還沒補完,
 *   排除掉的話那間房的成本會直接消失,而畫面上看不出來。
 */
export function hourlyOnlyJob(j: HourlyJob, hourlyIds: ReadonlySet<string>): boolean {
  return j.staffIds.length > 0 && j.staffIds.every((id) => hourlyIds.has(id));
}

/**
 * 要從清潔費排除的 job key。
 *
 * ★★★ key 的格式必須跟 `cleaningCosts()` 算出來的那一個**一模一樣**
 *   （`日期|房源|工作類型`）—— 差一個字元就等於沒排除到,
 *   而症狀是「劉姐的房間付了兩次」,帳面上完全正常。
 */
export function hourlyOnlyKeys(
  jobs: HourlyJob[], hourlyIds: ReadonlySet<string>,
): Set<string> {
  const out = new Set<string>();
  for (const j of jobs ?? []) {
    if (!j.property_id) continue;              // 沒房源的本來就不會產生清潔費
    if (hourlyOnlyJob(j, hourlyIds)) {
      out.add(`${j.work_date}|${j.property_id}|${j.work_type}`);
    }
  }
  return out;
}

/**
 * 把一個整數平均分成 n 份，**加起來剛好等於原數**。
 *
 * ★ 餘數補在前面幾份。哪一份多一塊沒有意義,重要的是總數對得起來。
 */
export function splitEvenly(total: number, n: number): number[] {
  if (n <= 0) return [];
  const t = Math.round(total);
  const base = Math.floor(t / n);
  let rest = t - base * n;
  return Array.from({ length: n }, () => {
    const extra = rest > 0 ? 1 : 0;
    rest -= extra;
    return base + extra;
  });
}

/**
 * 時薪人員的支出。一天一個人一間房一筆。
 *
 * @param days   每人每天的時數（畫面上那幾格）
 * @param jobs   `estateLog()` 攤平後的全部 job
 * @param staff  時薪人員（含時薪）
 */
export function hourlyRows(
  days: HourDay[], jobs: HourlyJob[], staff: HourlyStaff[],
): { rows: HourlyRow[]; skipped: HourlySkip[] } {
  const rows: HourlyRow[] = [];
  const skipped: HourlySkip[] = [];
  const byId = new Map(staff.map((s) => [s.id, s]));

  /*
   * 那個人那天做過哪幾間。**去重** —— 同一天同一間做了退房又做入住是兩份工,
   * 但攤分的對象是「房間」,算兩次的話那間房會拿到雙倍。
   */
  const propsOf = new Map<string, string[]>();
  for (const j of jobs ?? []) {
    if (!j.property_id) continue;
    for (const sid of j.staffIds) {
      if (!byId.has(sid)) continue;
      const k = `${j.work_date}|${sid}`;
      const list = propsOf.get(k) ?? [];
      if (!list.includes(j.property_id)) list.push(j.property_id);
      propsOf.set(k, list);
    }
  }

  for (const d of days ?? []) {
    const s = byId.get(d.staff_id);
    if (!s) continue;
    const hours = Number(d.hours);
    if (!Number.isFinite(hours) || hours <= 0) continue;   // 沒上班

    const rate = Number(s.hourly_rate);
    if (!Number.isFinite(rate) || rate <= 0) {
      // ★ 沒設時薪不是「算出來是 0」。安靜跳過的話，那個人整個月不見了
      skipped.push({ work_date: d.work_date, staff_name: s.name, hours, reason: '沒設時薪' });
      continue;
    }

    const props = propsOf.get(`${d.work_date}|${d.staff_id}`) ?? [];
    if (props.length === 0) {
      /*
       * ★★ 有時數、卻沒有任何房源。**不猜一間填進去** ——
       *   那筆錢會掛在別的物業頭上,而沒有人會發現。
       *   列出來讓人回排班表補一筆工作（2026-09-07 使用者選這條）。
       */
      skipped.push({ work_date: d.work_date, staff_name: s.name, hours, reason: '沒有房源' });
      continue;
    }

    const dayTotal = Math.round(hours * rate);
    const parts = splitEvenly(dayTotal, props.length);
    props.forEach((pid, i) => {
      rows.push({
        // ★ `HR|` 前綴避開清潔費的 `日期|房源|類型` —— 兩者共用同一個唯一索引
        key: `HR|${d.work_date}|${d.staff_id}|${pid}`,
        spent_on: d.work_date,
        staff_id: d.staff_id, staff_name: s.name,
        property_id: pid,
        hours, rate, dayTotal,
        amount: parts[i],
        share: props.length,
      });
    });
  }

  rows.sort((a, b) => a.spent_on.localeCompare(b.spent_on)
    || a.staff_name.localeCompare(b.staff_name));
  skipped.sort((a, b) => a.work_date.localeCompare(b.work_date));
  return { rows, skipped };
}

/** 支出的項目名稱。`5 小時 × $500 ÷ 2 間` —— 算式寫出來,不用點開就核得了。 */
export function hourlyItemName(r: HourlyRow): string {
  const base = `${r.staff_name} ${r.hours} 小時 × $${r.rate.toLocaleString('en-US')}`;
  return r.share > 1 ? `${base} ÷ ${r.share} 間` : base;
}
