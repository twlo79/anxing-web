/**
 * 訂單存檔前的檢查（純函式）。
 *
 * 分成「擋下來」與「提醒」兩種，而且刻意分得很清楚：
 *
 *   擋 = 這筆資料一定是錯的（迄日早於起日）
 *   提醒 = 可能是錯的，但也可能是真的（房價談得比較低）
 *
 * 把「可能是錯的」也拿來擋，使用者遲早會遇到擋錯的情況，
 * 而那時他只能放棄輸入 —— 系統就變成他工作的阻礙而不是幫手。
 * 反過來把「一定是錯的」做成提醒，那筆錯資料就會進資料庫。
 */

/* ============================================================
 * 日期
 * ============================================================ */

/**
 * 起日與迄日。
 *
 * 【為什麼一定要擋】
 * 現在完全沒有檢查。日期填反的話 nights 會被 Math.max(0, …) 算成 0，
 * 訂單照樣存進去 —— 畫面上看不出異常，但那筆的營收攤提、
 * 入住天數統計、房源佔用率全部是錯的，而且沒有人會發現。
 *
 * @param source 一次性收入只有一個日期欄位（迄日等於起日），所以允許相等。
 *               住宿訂單至少要一晚。
 */
export function checkDates(
  source: string, checkin: string, checkout: string,
): string | null {
  if (!checkin) return '請填起日';
  if (source === 'oneoff') return null;      // 只有一個日期欄位，畫面上沒有迄日
  if (!checkout) return '請填迄日';
  if (checkout < checkin) return `迄日（${checkout}）早於起日（${checkin}），請確認是不是填反了`;
  if (checkout === checkin) return '迄日與起日相同（0 晚）。住宿訂單至少要一晚；如果這是一次性收入，請把「來源」改成一次性收入';
  return null;
}

/* ============================================================
 * 均價
 * ============================================================ */

/** 用來算均價的歷史訂單。只需要這三個欄位。 */
export type PastOrder = { checkin: string | null; nights: number | null; amount: number | null };

/**
 * 低於均價幾成要提醒（使用者指定：5 成）。
 *
 * 【為什麼訂得這麼低】
 * 提醒的價值來自它很少出現。門檻放寬（例如 9 成）的話，平常議價
 * 讓一點就會跳，幾次之後就沒有人看了 —— 那時真正該被攔下來的那筆
 * （少打一個 0，也就是只有 10%）會跟著被忽略。
 *
 * 5 成基本上只抓「數量級錯了」與「明顯不對的價格」，
 * 正常的折扣、長住優惠、淡季價都不會跳。
 */
export const LOW_PRICE_RATIO = 0.5;

/**
 * 均價至少要幾筆資料才算數。
 *
 * 一兩筆算出來的「均價」只是那一兩筆本身。拿它當基準的話，
 * 第三筆只要價格不同就會跳提醒 —— 那不是異常，那是資料太少。
 */
export const MIN_SAMPLE = 3;

/** 過去多久的資料算數（天）。房價會變，三年前的價格不能拿來比今天。 */
export const LOOKBACK_DAYS = 365;

export type PriceCheck = {
  /** 每晚均價；資料不足時是 null */
  avg: number | null;
  /** 這筆的每晚單價 */
  nightly: number | null;
  sample: number;
  /** 要不要提醒 */
  low: boolean;
  message: string;
};

/**
 * 這筆的每晚單價跟同房源的歷史均價比。
 *
 * 【為什麼比「每晚單價」而不是總額】
 * 住三晚 9,000 跟住一晚 3,000 是同一個價。比總額的話，
 * 短天數的訂單每一筆都會跳提醒 —— 而那是最常見的情況。
 *
 * @param past 同房源、過去一年的訂單（呼叫端負責篩選）
 */
export function checkPrice(
  amount: number, nights: number, past: PastOrder[],
): PriceCheck {
  const none = (message = '') =>
    ({ avg: null, nightly: null, sample: 0, low: false, message });

  if (!nights || nights <= 0 || !amount || amount <= 0) return none();

  // 只取「有晚數、有金額」的。0 晚的一次性收入混進來的話會把均價拉低，
  // 而拉低的均價會讓真正該提醒的那筆通過。
  const usable = past.filter((p) =>
    (p.nights ?? 0) > 0 && (p.amount ?? 0) > 0);
  if (usable.length < MIN_SAMPLE) {
    return none(usable.length
      ? `同房源只有 ${usable.length} 筆歷史訂單，還算不出可靠的均價`
      : '');
  }

  /*
   * 用「總金額 ÷ 總晚數」而不是「每筆單價再平均」。
   *
   * 後者會讓一筆一晚的訂單跟一筆三十晚的訂單一樣重 ——
   * 而三十晚那筆通常是長住優惠價，權重放大之後會把均價整個拉歪。
   */
  const sumAmt = usable.reduce((n, p) => n + (p.amount ?? 0), 0);
  const sumNt = usable.reduce((n, p) => n + (p.nights ?? 0), 0);
  const avg = Math.round(sumAmt / sumNt);
  const nightly = Math.round(amount / nights);

  if (!avg) return none();
  const low = nightly < avg * LOW_PRICE_RATIO;

  return {
    avg, nightly, sample: usable.length, low,
    message: low
      ? `每晚 $${nightly.toLocaleString()}，低於這間房過去一年的均價 `
        + `$${avg.toLocaleString()}（${Math.round((nightly / avg) * 100)}%，共 ${usable.length} 筆）。`
        + `確定金額沒填錯嗎？`
      : '',
  };
}

/** 均價的取樣起日（YYYY-MM-DD）。 */
export function lookbackFrom(today: Date = new Date()): string {
  const d = new Date(today.getTime() - LOOKBACK_DAYS * 86400000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
