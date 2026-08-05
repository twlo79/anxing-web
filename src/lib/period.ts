/**
 * 期間與日期格式的單一定義。
 *
 * 【為什麼需要這支】
 * 2026-08-05 財務儀表板的營收顯示 0，實際上那個月有 124 筆認列、八百多萬。
 * 原因是查詢把 `revenue_recognitions.ym` 當成 'YYYY-MM' 來比，
 * 但那一欄存的是六碼的 'YYYYMM'。
 *
 * 而它**不會報錯**：字串比較下 '202608' >= '2026-08' 成立（'0' 的字碼大於 '-'）、
 * '202608' <= '2026-08' 不成立，所以整個區間被排除，畫面安靜地顯示營收 0。
 * 「這個月沒生意」跟「查詢寫錯」在畫面上長得一模一樣 —— 那種錯最難發現。
 *
 * 各頁自己 slice 遲早會再出一次同樣的事，所以格式只在這裡定義一次，
 * 而且有測試釘住。
 */

/** 認列月份的儲存格式：六碼、無連字號。`revenue_recognitions.ym` 就長這樣。 */
export type Ym = string;

/** 'YYYY-MM-DD' → 'YYYYMM'。日期欄位（spent_on / checkin）換算成認列月份用。 */
export function ymOf(dateStr: string): Ym {
  return dateStr.slice(0, 4) + dateStr.slice(5, 7);
}

/** 'YYYYMM' → 'YYYY-MM'。只給畫面顯示,不要拿去跟資料庫比對。 */
export function ymShow(ym: Ym): string {
  return ym.slice(0, 4) + '-' + ym.slice(4, 6);
}

/** 'YYYYMM' → 'MM'。圖表軸標籤用,寬度有限只放月份。 */
export function ymMonth(ym: Ym): string {
  return ym.slice(4, 6);
}

/**
 * 今天往前推 n 個月的**月初**。
 * 用 setDate(1) 先把日期歸位再減月份 —— 不這樣做的話,
 * 3/31 減一個月會跑到 3/3（2 月沒有 31 號,JS 會往後溢位）。
 */
export function monthsAgo(n: number, today = new Date()): string {
  const d = new Date(today);
  d.setDate(1);
  d.setMonth(d.getMonth() - n);
  return localDate(d);
}

/** 今天,'YYYY-MM-DD'。 */
export function todayStr(today = new Date()): string {
  return localDate(today);
}

/**
 * Date → 'YYYY-MM-DD'，用**本地時區**。
 *
 * 不用 toISOString().slice(0,10) —— 那個是 UTC。台灣 +8，
 * 凌晨 0 點到 8 點之間會回傳前一天，「本月」的起日就會少一天。
 */
function localDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 列表用的日期顯示。空值一律顯示 '—'，不要出現 'null' 或空白格。 */
export function fmtDate(d: string | null | undefined): string {
  if (!d) return '—';
  return d.slice(0, 10);
}

/** 短版日期 'MM-DD'。同一年的資料列表用,省掉重複的年份。 */
export function fmtDateShort(d: string | null | undefined): string {
  if (!d) return '—';
  return d.slice(5, 10);
}

/** 時間戳 → 'MM-DD HH:mm'。編輯紀錄那種「什麼時候做的」用。 */
export function fmtAt(ts: string | null | undefined): string {
  if (!ts) return '—';
  return ts.slice(5, 16).replace('T', ' ');
}
