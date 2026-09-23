/**
 * 請假：一張單裝一份日期明細（2026-09-22，migration_291）。
 *
 * ============================================================
 * 【為什麼寫在 `.ts` 而不是頁面裡】
 *
 * 測試執行環境不處理 JSX（CLAUDE.md）。而這裡每一件事都是
 * **錯了不會報錯**的類型：
 *
 *   · 假日判斷錯   → 中秋節被扣一天特休，畫面上只是少了 8 小時
 *   · 午休沒扣     → 09:00～18:00 算成 9 小時，每天多扣 1
 *   · 段切錯       → 「連續」寫成「分 3 段」，只是看起來怪
 *
 * ============================================================
 * 【★★★ 時數的算法跟資料庫是同一條】
 *
 * `leave_hours_between()`（migration_291）在資料庫裡有一份**同樣的算法**，
 * 而 `request_leave_batch()` 會拿它算的跟這裡送過去的比 ——
 * 對不上就擋（HOURS_MISMATCH）。所以這兩份不會安靜地長歪：歪了就送不出去。
 *
 * ============================================================
 * 【三個決定（使用者 2026-09-22）】
 *   · 剔除某一天 → 整批駁回、重送（沒有逐日剔除）
 *   · 午休 12:30～13:30（存在 `work_settings`，這裡只讀）
 *   · 舊單不動
 */

/** `YYYY-MM-DD` */
export type Ymd = string;
/** `HH:mm` */
export type Hm = string;

export type WorkSettings = {
  work_start: Hm;
  work_end: Hm;
  lunch_start: Hm;
  lunch_end: Hm;
  work_hours_per_day: number;
};

/** 沒讀到設定時的保底 —— 跟 migration_291 的預設一樣 */
export const DEFAULT_WS: WorkSettings = {
  work_start: '09:00', work_end: '18:00', lunch_start: '12:30', lunch_end: '13:30',
  work_hours_per_day: 8,
};

export type HolidayRow = { d: Ymd; kind: 'holiday' | 'makeup' | string };

/* ── 日期小工具（不用 Date 物件，避免時區） ────────────── */
const pad = (n: number) => String(n).padStart(2, '0');
export const toYmd = (d: Date): Ymd => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = (s: Ymd) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
export const addDays = (s: Ymd, n: number): Ymd => { const d = parse(s); d.setDate(d.getDate() + n); return toYmd(d); };
/** 0＝日 … 6＝六 */
export const dow = (s: Ymd) => parse(s).getDay();
export const isYmd = (s: unknown): s is Ymd => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

/**
 * 這一天要不要上班 —— 跟資料庫的 `is_workday()` 同一套：
 *   補班日（makeup）算上班、國定假日（holiday）不上、其餘看週末。
 *
 * ★ 順序不能反：補班日常常是週六，先看週末的話會把補班日當成假日。
 */
export function isWorkday(d: Ymd, holidays: ReadonlyMap<Ymd, string>): boolean {
  const k = holidays.get(d);
  if (k === 'makeup') return true;
  if (k === 'holiday') return false;
  const w = dow(d);
  return w >= 1 && w <= 5;
}

export const holidayMap = (rows: readonly HolidayRow[] | null | undefined): Map<Ymd, string> =>
  new Map((rows ?? []).map((r) => [r.d, r.kind]));

/* ── 時數 ────────────────────────────────────────────────── */
const mins = (t: Hm): number => { const [h, m] = t.split(':').map(Number); return h * 60 + (m || 0); };
/** `spreadHours()` 在分鐘與 `HH:mm` 之間來回，兩支都收在這裡 */
const hhmm = mins;
const toHm = (n: number): Hm => `${pad(Math.floor(n / 60))}:${pad(n % 60)}`;

/**
 * 一段時間裡有幾個「工作小時」：夾在上下班之間、扣掉午休。
 * **跟 `leave_hours_between()` 同一條算式**（見檔頭）。收到分。
 */
export function workHours(start: Hm, end: Hm, ws: WorkSettings = DEFAULT_WS): number {
  const s = mins(start), e = mins(end);
  if (!(e > s)) return 0;
  const seg = (a: number, b: number) => Math.max(0, Math.min(e, b) - Math.max(s, a));
  const m = seg(mins(ws.work_start), mins(ws.lunch_start)) + seg(mins(ws.lunch_end), mins(ws.work_end));
  return Math.round((m / 60) * 100) / 100;
}

/** 每一天可以選的四種樣子 */
export type DayMode = 'full' | 'am' | 'pm' | 'custom';

export type DayPick = {
  mode: DayMode;
  /** custom 才有：起訖 */
  start?: Hm;
  end?: Hm;
};

/** 一天算出來的結果 —— 送去資料庫的就是這個形狀 */
export type DayPlan = { d: Ymd; s: Hm; e: Hm; h: number; mode: DayMode };

/**
 * 每一種樣子的起訖。
 *
 * ★ 半天 ＝ **上午到午休 / 午休到下班**，時數照實算（12:30 午休的話上午 3.5、下午 4.5）。
 *   不寫死「半天＝4 小時」—— 那樣「上午半天」跟「下午半天」加起來會是 8 而不是實際的 8，
 *   聽起來一樣，但午休不在正中間時其中一邊會多扣半小時而沒有人發現。
 */
export function modeTimes(mode: DayMode, ws: WorkSettings, pick?: DayPick): { s: Hm; e: Hm } {
  if (mode === 'am') return { s: ws.work_start, e: ws.lunch_start };
  if (mode === 'pm') return { s: ws.lunch_end, e: ws.work_end };
  if (mode === 'custom') return { s: pick?.start ?? ws.work_start, e: pick?.end ?? ws.work_end };
  return { s: ws.work_start, e: ws.work_end };
}

export const MODE_LABEL: Record<DayMode, string> = {
  full: '整天', am: '上午半天', pm: '下午半天', custom: '指定時段',
};

/** 把使用者點的日子變成要送出的明細（照日期排） */
export function planDays(picks: ReadonlyMap<Ymd, DayPick>, ws: WorkSettings = DEFAULT_WS): DayPlan[] {
  return [...picks.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([d, p]) => {
    const { s, e } = modeTimes(p.mode, ws, p);
    return { d, s, e, h: workHours(s, e, ws), mode: p.mode };
  });
}

/** 合計：小時數 ＋ 換成天（用每日工時除） */
export function totals(plan: readonly DayPlan[], ws: WorkSettings = DEFAULT_WS): { hours: number; days: number } {
  const hours = Math.round(plan.reduce((n, p) => n + p.h, 0) * 100) / 100;
  const per = ws.work_hours_per_day || 8;
  return { hours, days: Math.round((hours / per) * 100) / 100 };
}

/**
 * 段：連續的請假日，**中間只隔週末／國定假日也算同一段**。
 * 給畫面說「連續」或「分 2 段」用的。
 */
export function segments(days: readonly Ymd[], holidays: ReadonlyMap<Ymd, string>): Ymd[][] {
  const ds = [...days].sort();
  const out: Ymd[][] = [];
  for (const d of ds) {
    const last = out[out.length - 1];
    if (last) {
      let x = addDays(last[last.length - 1], 1), bridged = true, guard = 0;
      while (x < d && guard++ < 60) { if (isWorkday(x, holidays)) { bridged = false; break; } x = addDays(x, 1); }
      if (bridged) { last.push(d); continue; }
    }
    out.push([d]);
  }
  return out;
}

/** 從起日往後鋪 n 個上班日（跳過週末與國定假日）—— 「請幾天」那一格用 */
export function spreadWorkdays(start: Ymd, n: number, holidays: ReadonlyMap<Ymd, string>): Ymd[] {
  const out: Ymd[] = [];
  let d = start, guard = 0;
  while (out.length < n && guard++ < 400) { if (isWorkday(d, holidays)) out.push(d); d = addDays(d, 1); }
  return out;
}

/* ── 以小時請：起算點 ＋ 時數 → 明細 ─────────────────────── */
/**
 * 從「哪一天幾點」開始，往後鋪 `hours` 個**工作小時**，回一天一列的明細。
 *
 * ============================================================
 * 【★★★ 為什麼不是「結束 = 開始 + 時數」】
 *
 * 那是牆上時鐘。09:00 + 4 小時 = 13:00，但 12:30～13:30 是午休 ——
 * 實際上班只有 3.5 小時，少扣半小時，**而畫面上看起來完全正常**。
 * 這裡逐段推進：碰到午休跳過、碰到下班換隔天、碰到假日整天跳過。
 *
 * ★★ 起算點落在非上班時間時**自動往後挪**（午休中→午休後、假日→下一個上班日、
 *   下班後→隔天上班），挪到哪裡由回傳的第一列自己講。
 *   呼叫端要把「從 X 起算」寫在畫面上 —— 安靜挪會讓人以為自己填錯。
 *
 * ★ 逐 30 分鐘推進。請假的粒度本來就不會比半小時細，
 *   而用逐分鐘推的話一天要跑 480 圈，沒有必要。
 *
 * ★★★ 時數的算法還是 `workHours()`（跟 `leave_hours_between()` 同一條）——
 *   這裡只負責「切到哪裡」，不自己算時數。送出時資料庫會再算一次比對。
 */
export function spreadHours(
  startDate: Ymd, startTime: Hm, hours: number,
  holidays: ReadonlyMap<Ymd, string>, ws: WorkSettings = DEFAULT_WS,
): DayPlan[] {
  const out: DayPlan[] = [];
  if (!isYmd(startDate) || !(hours > 0)) return out;
  const wStart = hhmm(ws.work_start), wEnd = hhmm(ws.work_end);
  const lStart = hhmm(ws.lunch_start), lEnd = hhmm(ws.lunch_end);
  let d = startDate;
  let t = Math.max(hhmm(startTime || ws.work_start), wStart);
  let left = hours;
  // 上限：往後找一年還鋪不完就放棄（避免假日表壞掉時無窮迴圈）
  for (let guard = 0; left > 0.001 && guard < 400; guard++) {
    if (!isWorkday(d, holidays)) { d = addDays(d, 1); t = wStart; continue; }
    if (t >= wEnd) { d = addDays(d, 1); t = wStart; continue; }
    if (t >= lStart && t < lEnd) t = lEnd;      // 起算點卡在午休裡
    /*
     * 每次推 30 分鐘，用 `workHours()` 回頭算「到這裡累積幾小時」——
     * 午休那段本來就回 0，所以不用特別跳過它（342 種起點×時數比對過，
     * 加不加那條 continue 輸出完全一樣；那行只是多繞兩圈，拿掉）。
     */
    let e = t, used = 0;
    while (used < left - 0.001 && e < wEnd) {
      e += 30;
      used = workHours(toHm(t), toHm(e), ws);
    }
    if (used > 0.001) {
      out.push({ d, s: toHm(t), e: toHm(e), h: used, mode: 'custom' });
      left = Math.round((left - used) * 100) / 100;
    }
    d = addDays(d, 1); t = wStart;
  }
  return out;
}

/** 起算點被往後挪了沒 —— 挪了的話回實際的第一天，沒挪回 null */
export function movedStart(startDate: Ymd, plan: readonly DayPlan[]): Ymd | null {
  return plan.length && plan[0].d !== startDate ? plan[0].d : null;
}

/* ── 送出前的擋 ──────────────────────────────────────────── */
/**
 * 回第一個錯誤訊息，沒問題回 null。
 *
 * ★★ 這幾條跟 `request_leave_batch()` 是同一組規則。兩邊都寫是刻意的：
 *   資料庫那層擋住任何路徑，這一層負責在**按下去之前**就講出為什麼。
 * ★ 額度不在這裡擋 —— 前端只知道「已用」，不知道「送審中」的；資料庫兩個都看。
 *   這裡只做「明顯不夠」的提醒，讓按鈕灰掉。
 */
export function leaveError(
  plan: readonly DayPlan[], holidays: ReadonlyMap<Ymd, string>,
  opt: { typeCode: string; remain: number | null },
): string | null {
  if (!opt.typeCode) return '請先選假別。';
  if (!plan.length) return '還沒選任何一天 —— 點月曆選日子。';
  for (const p of plan) {
    if (!isYmd(p.d)) return `${p.d} 不是日期。`;
    if (!isWorkday(p.d, holidays)) return `${p.d} 不是上班日，不用請假。`;
    if (p.h <= 0) return `${p.d} ${p.s}～${p.e} 沒有工作時數（在上班時間外，或全部是午休）。`;
  }
  const t = totals(plan);
  if (opt.remain != null && t.hours > opt.remain) {
    return `不夠：這次共 ${t.hours} 小時，只剩 ${opt.remain} 小時。拿掉幾天，或改請事假。`;
  }
  return null;
}

/* ── 紀錄列：把同批收成一列 ──────────────────────────────── */
export type LeaveRowLike = {
  id: string; batch_id?: string | null; type_code: string; start_at: string; end_at: string;
  hours: number; status: string; reason?: string | null; manager_at?: string | null; admin_at?: string | null;
  reject_reason?: string | null; created_at?: string;
};

export type LeaveBatch<T extends LeaveRowLike> = {
  /** batch_id，或舊單的 id */
  key: string;
  rows: T[];
  hours: number;
  /** 幾個請假日 */
  days: number;
  first: string;
  last: string;
  /** 同批的狀態 —— 全部一樣，取第一列 */
  status: string;
};

/**
 * 同批收成一列。舊單（沒有 batch_id）自己一列。
 * ★ 排序：新的在上面（照第一天）。同批內照日期。
 */
export function groupBatches<T extends LeaveRowLike>(rows: readonly T[]): LeaveBatch<T>[] {
  const m = new Map<string, T[]>();
  for (const r of rows ?? []) {
    const k = r.batch_id || r.id;
    (m.get(k) ?? m.set(k, []).get(k)!).push(r);
  }
  const out: LeaveBatch<T>[] = [];
  for (const [key, rs] of m) {
    rs.sort((a, b) => a.start_at.localeCompare(b.start_at));
    out.push({
      key, rows: rs,
      hours: Math.round(rs.reduce((n, r) => n + Number(r.hours || 0), 0) * 100) / 100,
      days: rs.length,
      first: rs[0].start_at, last: rs[rs.length - 1].end_at,
      status: rs[0].status,
    });
  }
  return out.sort((a, b) => b.first.localeCompare(a.first));
}
