/**
 * 出勤頁的純邏輯（時間換算、月曆、簽核狀態）。
 *
 * 抽出來是為了能測 —— 這裡面每一條錯掉都會變成薪資算錯，
 * 而薪資算錯不會噴錯誤，只會有人月底發現少了幾小時。
 */

/* ============================================================
 * 【時區：datetime-local 一定要自己補 +08:00】
 *
 * <input type="datetime-local"> 給的是 "2026-08-10T09:00"，沒有時區。
 * 丟給 new Date() 會用**裝置的時區**解讀。
 *
 * 手機時區設成別的地方（出國忘了改回來、或是買來就設錯）的話，
 * 同樣一個 09:00 會存成不同的時刻，而且看起來完全正常 ——
 * 請假單顯示 09:00、資料庫存的是 09:00+09:00，扣的時數會差一小時。
 *
 * 公司在台灣，上下班時間就是台北時間。寫死 +08:00，不看裝置。
 * ============================================================ */

export const TW_OFFSET = '+08:00';

/** "2026-08-10T09:00" → "2026-08-10T09:00:00+08:00" */
export function toTaipeiIso(local: string): string {
  if (!local) return '';
  const s = local.length === 16 ? `${local}:00` : local;
  return `${s}${TW_OFFSET}`;
}

/** Date → "2026-08-10T09:00"（台北時間），給 datetime-local 當預設值 */
export function toLocalInput(d: Date): string {
  const tw = new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  const p = (n: number) => String(n).padStart(2, '0');
  return `${tw.getFullYear()}-${p(tw.getMonth() + 1)}-${p(tw.getDate())}`
    + `T${p(tw.getHours())}:${p(tw.getMinutes())}`;
}

/** 今天（台北）"2026-08-10" */
export function twToday(now: Date = new Date()): string {
  const tw = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  const p = (n: number) => String(n).padStart(2, '0');
  return `${tw.getFullYear()}-${p(tw.getMonth() + 1)}-${p(tw.getDate())}`;
}

/**
 * 兩個時間差幾小時，四捨五入到小數兩位。
 *
 * 跟資料庫 request_leave 的算法一致（epoch 差 / 3600，round 2）——
 * 前端先算出來只是為了讓人在送出前看到「這樣是 4 小時」，
 * 兩邊算法不同的話畫面說 4、實際扣 4.02，沒有人查得出來。
 */
export function hoursBetween(startIso: string, endIso: string): number {
  const a = new Date(startIso).getTime();
  const b = new Date(endIso).getTime();
  if (Number.isNaN(a) || Number.isNaN(b) || b <= a) return 0;
  return Math.round(((b - a) / 3600000) * 100) / 100;
}

/* ============================================================
 * 簽核狀態
 *
 * 只顯示「送審中」是不夠的 —— 等了三天的人要知道是卡在主管
 * 還是卡在總經理，才知道該去問誰。
 * ============================================================ */

export type LeaveRow = {
  status: string;
  manager_at?: string | null;
  admin_at?: string | null;
  reject_reason?: string | null;
};

export type VoteState = { text: string; tone: 'wait' | 'ok' | 'no' };

/** 請假：兩票（主管＋總經理） */
export function leaveVote(r: LeaveRow): VoteState {
  if (r.status === 'approved') return { text: '已核可', tone: 'ok' };
  if (r.status === 'rejected') {
    return { text: r.reject_reason ? `已駁回：${r.reject_reason}` : '已駁回', tone: 'no' };
  }
  if (r.status === 'cancelled') return { text: '已取消', tone: 'no' };
  if (r.manager_at && !r.admin_at) return { text: '主管已簽，等總經理', tone: 'wait' };
  if (!r.manager_at && r.admin_at) return { text: '總經理已簽，等主管', tone: 'wait' };
  return { text: '等主管與總經理', tone: 'wait' };
}

/** 加班：主管一票 */
export function otVote(r: LeaveRow): VoteState {
  if (r.status === 'approved') return { text: '已核可', tone: 'ok' };
  if (r.status === 'rejected') {
    return { text: r.reject_reason ? `已駁回：${r.reject_reason}` : '已駁回', tone: 'no' };
  }
  if (r.status === 'cancelled') return { text: '已取消', tone: 'no' };
  return { text: '等主管核可', tone: 'wait' };
}

/* ============================================================
 * 月曆
 * ============================================================ */

/**
 * 產生月曆的格子（週日起算，固定 6 列 42 格）。
 *
 * **固定 6 列**，不是「需要幾列給幾列」—— 列數會變的話，
 * 切換月份時整個版面會上下跳動，按鈕的位置也跟著跑。
 *
 * 回傳的每一格都帶 inMonth，讓上下月的日期可以淡化但仍然看得到
 * （月初月底跨月的班表要對得起來）。
 */
export type Cell = { date: string; day: number; inMonth: boolean; dow: number };

export function monthGrid(year: number, month1: number): Cell[] {
  const first = new Date(Date.UTC(year, month1 - 1, 1));
  const start = new Date(first);
  start.setUTCDate(1 - first.getUTCDay()); // 退到當週週日
  const out: Cell[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(start);
    d.setUTCDate(start.getUTCDate() + i);
    const p = (n: number) => String(n).padStart(2, '0');
    out.push({
      date: `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`,
      day: d.getUTCDate(),
      inMonth: d.getUTCMonth() === month1 - 1 && d.getUTCFullYear() === year,
      dow: d.getUTCDay(),
    });
  }
  return out;
}

/** 上一個／下一個月（會跨年） */
export function shiftMonth(year: number, month1: number, delta: number): [number, number] {
  const m = month1 - 1 + delta;
  return [year + Math.floor(m / 12), ((m % 12) + 12) % 12 + 1];
}

/* ============================================================
 * 補登申請的日期限制
 * ============================================================ */

/**
 * 補登只能補「今天以前」。
 *
 * 補未來的日期在制度上沒有意義（那天還沒發生），
 * 但真正的問題是它會被 apply_attendance_fix 寫成一筆未來的出勤紀錄，
 * 而出勤表是照日期掃的 —— 那筆會一直躺在那裡，月結時才有人發現。
 */
export function checkFixDate(workDate: string, today: string = twToday()): string | null {
  if (!workDate) return '要補哪一天？';
  if (workDate > today) return '補登只能補今天或今天以前的日期。未來的班還沒上，補不了。';
  // 超過兩個月的補登多半是月結已經結過了，擋下來讓他去找主管走人工
  const d = new Date(`${workDate}T00:00:00+08:00`).getTime();
  const t = new Date(`${today}T00:00:00+08:00`).getTime();
  if ((t - d) / 86400000 > 62) {
    return '這一天已經超過兩個月，出勤表多半結過了。\n請直接找主管處理，不要走補登。';
  }
  return null;
}
