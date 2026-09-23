/**
 * 契約展延：迄日怎麼往後推、刪掉之後怎麼還原（migration_297）。
 *
 * ============================================================
 * 【★★★ 為什麼這兩支一定要成對測】
 *
 * 展延與刪除延展**本來不是一對逆運算**，而那件事在畫面上看不出來：
 *
 *   `extendEnd()`  算出來的永遠是**月底**（往後推 N 個月的最後一天）
 *   `restoreEnd()` 舊版是用「延展起始月的前一個月底」回推
 *
 * 所以原本的迄日只要不是月底就還原不回去：
 *
 *   2028-10-30 → 展延 → 2028-11-30 → 刪除 → 2028-10-**31**   晚 1 天
 *   2026-12-01 → 展延 → 2027-01-31 → 刪除 → 2026-12-**31**   晚 30 天
 *
 * ★★ 代價不是「日期難看」:迄日往後挪 ＝ 契約多涵蓋一段時間，
 *   而 `gen_contract_orders()` 照迄日重算月租單 —— 跨過月底就**多長一張**，
 *   未收跟著變多，而使用者按的明明是「刪除」。
 *   （2026-09-23 在 17B5 上實際發生。）
 *
 * ★ 修法是展延時把原本的迄日留底（`contracts.pre_extend_end_date`），
 *   刪最早那批時讀回來。留底是 null（09-23 之前的舊契約）才退回回推月底，
 *   而且畫面上要說「沒有留底」。
 *
 * 【為什麼寫在 .ts】測試環境不處理 JSX（CLAUDE.md）——
 * 寫在 page.tsx 裡的日期算式一行都測不到。
 */

/** `YYYY-MM-DD` */
export type Ymd = string;
/** 六碼月份 `YYYYMM` */
export type Ym = string;

const pad = (n: number) => String(n).padStart(2, '0');
const fmt = (d: Date): Ymd => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/**
 * 展延 N 個月之後的租期迄 —— **現有迄日那個月往後推 N 個月的月底**。
 *
 * ★ 用本地時區的 Date 建構子，不要 `new Date('2028-10-30')`（那是 UTC，
 *   台灣會變成前一天）。
 */
export function extendEnd(end: Ymd, n: number): Ymd {
  const [y, m, d] = end.split('-').map(Number);
  if (!y || !m || !d || !(n >= 1)) return end;
  // day = 0 ＝ 上個月的最後一天；月份索引從 0 起算，所以 (m - 1) + 1 + n
  return fmt(new Date(y, m + n, 0));
}

/** 展延之後會長出來的那幾個月（六碼），照順序 */
export function extendYms(end: Ymd, n: number): Ym[] {
  const [y, m] = end.split('-').map(Number);
  const out: Ym[] = [];
  let cy = y, cm = m + 1;                 // 從迄日的下一個月開始
  for (let i = 0; i < n; i++) {
    if (cm > 12) { cm = 1; cy++; }
    out.push(`${cy}${pad(cm)}`);
    cm++;
  }
  return out;
}

/**
 * 刪掉一批延展之後，租期迄要還原成哪一天。
 *
 * @param startYm 那批延展的第一個月（六碼）
 * @param prev    留底的原始迄日；沒有就給 null
 *
 * ★★★ `prev` 有值就用它 —— 那才是真正的還原。
 * ★★ 沒有值時退回「前一個月底」。刪的是**後面那幾批**時這是對的
 *   （前一批展延的結果本來就是月底）；刪的是最早那批而又沒留底時，
 *   它只是**最接近的猜測**，呼叫端要把這件事講在畫面上。
 */
export function restoreEnd(startYm: Ym, prev: Ymd | null): Ymd {
  if (prev) return prev;
  const y = Number(startYm.slice(0, 4)), m = Number(startYm.slice(4, 6));
  return fmt(new Date(y, m - 1, 0));
}

/** 這次回推是「用猜的」嗎 —— 刪最早那批、而且沒有留底 */
export function isGuessedRestore(isFirstBatch: boolean, prev: Ymd | null): boolean {
  return isFirstBatch && !prev;
}
