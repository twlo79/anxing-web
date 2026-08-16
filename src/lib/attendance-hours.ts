/**
 * 出勤時數的顯示與計算。**只算數字與字串，不管版面。**
 *
 * ============================================================
 * 【應到 vs 實到】（2026-08-16 使用者指定）
 *
 * 原本的出勤表只有一欄「工作時數」，而它的算法是：
 *
 *     有打卡 或 有請假  →  每日工時 − 請假時數
 *     其餘              →  0
 *
 * 也就是**只要有打卡就算滿 8 小時**，不管實際幾點到幾點走。
 * 遲到兩小時跟準時來，那一欄一模一樣 —— 遲到只出現在另一個小欄位，
 * 而看報表的人不會把兩欄放在一起讀。
 *
 * 現在拆成兩欄：
 *
 *     應到  每日工時 − 請假時數      ← 這是「今天該做多久」
 *     實到  下班 − 上班 − 休息時間    ← 這是「實際做了多久」
 *
 * 兩欄並排，差多少一眼就看得到。
 *
 *
 * ============================================================
 * 【休息時間從設定推導，不寫死 1 小時】
 *
 *     休息 = (下班時間 − 上班時間) − 每日工時
 *          = (18:00 − 09:00) − 8
 *          = 1 小時
 *
 * 寫死 1 的話，哪天有人改成 08:00–17:00 或改成六小時班，
 * 那個 1 就變成錯的 —— 而它不會報錯，只會讓實到永遠少一小時。
 *
 * 推導出負數（設定本身矛盾）時當成 0：那是設定要修的問題，
 * 不該讓實到變成比在公司的時間還長。
 *
 *
 * ============================================================
 * 【為什麼用「幾小時幾分」不用小數】
 *
 * 「7.75 小時」要在腦裡乘 60 才知道是 45 分鐘。出勤表是拿來跟人對話的
 * （「你上禮拜三少了多久」），小數點會讓對話多一個換算步驟。
 */

/** 一天的休息時間（小時）。從上下班時間與每日工時推導。 */
export function breakHours(
  workStart: string | null | undefined,
  workEnd: string | null | undefined,
  dailyHours: number,
): number {
  const span = spanHours(workStart, workEnd);
  if (span == null) return 0;
  return Math.max(0, span - dailyHours);
}

/** "09:00" / "09:00:00" → 小時數。兩個都給才算得出來 */
function spanHours(a: string | null | undefined, b: string | null | undefined): number | null {
  const toH = (s: string | null | undefined) => {
    if (!s) return null;
    const [h, m] = s.split(':');
    const hh = Number(h), mm = Number(m ?? 0);
    return Number.isFinite(hh) && Number.isFinite(mm) ? hh + mm / 60 : null;
  };
  const x = toH(a), y = toH(b);
  if (x == null || y == null) return null;
  // 跨夜班（22:00–06:00）加一天。不處理的話會是負數
  return y >= x ? y - x : y + 24 - x;
}

/**
 * 實到時數。
 *
 * @param inAt  上班打卡（ISO）
 * @param outAt 下班打卡（ISO）
 * @param brk   休息時間（小時），由 `breakHours` 算出來
 *
 * 【只打了上班沒打下班 → null，不是 0】
 * 0 的意思是「那天做了 0 小時」，null 的意思是「算不出來」。
 * 混在一起的話，忘記打下班卡的人會被當成整天沒做事，
 * 而那個 0 加進月合計裡沒有人看得出來。
 */
export function actualHours(
  inAt: string | null | undefined,
  outAt: string | null | undefined,
  brk = 0,
): number | null {
  if (!inAt || !outAt) return null;
  const a = new Date(inAt).getTime(), b = new Date(outAt).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return null;
  return Math.max(0, (b - a) / 3600000 - brk);
}

/**
 * 應到時數 = 每日工時 − 請假時數。
 *
 * @param isWorkday 例假日與國定假日不用到，應到是 0
 */
export function dueHours(dailyHours: number, leaveHours: number, isWorkday: boolean): number {
  if (!isWorkday) return 0;
  return Math.max(0, dailyHours - (leaveHours || 0));
}

/**
 * 小時數 → 「7 小時 45 分」。
 *
 * 不足一小時只寫分（「45 分」）—— 「0 小時 45 分」那個 0 沒有資訊，
 * 只是讓眼睛多讀兩個字。
 *
 * null 回破折號:算不出來跟 0 是兩件事。
 */
export function fmtHM(hours: number | null | undefined): string {
  if (hours == null || !Number.isFinite(hours)) return '—';
  const totalMin = Math.round(hours * 60);
  if (totalMin === 0) return '0 分';
  const sign = totalMin < 0 ? '−' : '';
  const abs = Math.abs(totalMin);
  const h = Math.floor(abs / 60), m = abs % 60;
  if (h === 0) return `${sign}${m} 分`;
  if (m === 0) return `${sign}${h} 小時`;
  return `${sign}${h} 小時 ${m} 分`;
}

/**
 * 遲到／早退的分鐘數 → 可讀字串。
 *
 * 【為什麼超過一小時要換算】（2026-08-16 使用者指定）
 *
 * 「遲到 135 分」要停下來算一下才知道是兩小時多。而遲到的嚴重程度
 * 正是靠那個「多久」在判斷的 —— 需要換算的數字會讓人跳過不看。
 *
 * 未滿一小時維持分鐘:「遲到 45 分」比「遲到 0 小時 45 分」好讀。
 */
export function fmtLate(min: number | null | undefined): string {
  if (min == null || !Number.isFinite(min) || min <= 0) return '';
  if (min < 60) return `${min} 分`;
  const h = Math.floor(min / 60), m = min % 60;
  return m === 0 ? `超過 ${h} 小時` : `超過 ${h} 小時 ${m} 分`;
}

/**
 * 應到與實到的差。正 = 少做，負 = 多做。
 *
 * 回傳 null 代表算不出來（沒打下班卡），呼叫端要跟 0 分開處理。
 */
export function hoursGap(due: number, actual: number | null): number | null {
  if (actual == null) return null;
  return due - actual;
}
