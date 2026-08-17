/**
 * 營收表格「一列怎麼顯示」。**只算字串，不管版面。**
 *
 * ============================================================
 * 【為什麼要有這個檔案】（2026-08-16 使用者指定：九欄合併成六欄）
 *
 * 原本九欄各自一格，合併之後每一格裡有兩行、而且哪一行在上面是有規則的。
 * 那些規則寫在 `.tsx` 裡就測不到 —— 測試環境不處理 JSX。
 *
 * 而這裡每一條規則錯了都**不會有徵兆**:
 *
 *   · 辦公室出租不顯示房源 —— 顯示了會被拿去跟房源營收對帳,對不起來
 *   · 認列起訖缺值時退回訂單起訖 —— 舊資料沒有 period_start
 *   · 同一天的區間要收成一個日期 —— 「07-31~07-31」佔兩倍寬度而沒有多講任何事
 *
 * 版面歪了看一眼就知道，這些錯不會。
 */

import { isOffice, isCompany } from './revenue-report.ts';

export type RevRow = {
  source: string;
  estate_name: string | null;
  property_raw: string | null;
  guest_name: string | null;
  checkin: string;
  checkout: string;
  period_start: string | null;
  period_end: string | null;
  fee_type?: string | null;
  item_name?: string | null;
  total_amount: number;
  total_nights: number;
  month_nights: number;
  month_amount: number;
};

/** 兩行一格。`main` 是主要那行（大字），`sub` 是底下的灰字。sub 為空就只顯示一行 */
export type TwoLine = { main: string; sub: string };

const DASH = '—';

/**
 * 房源欄:房源在上、物業在下。
 *
 * 【為什麼房源是主要那行】（使用者指定）
 * 找一列的時候人腦裡想的是「B5 那筆」，不是「時兆的那筆」。
 * 物業是用來確認的 —— B5 有可能在兩棟都有,那時才需要看第二行。
 *
 * 【辦公室與公司登記不顯示房源】
 * 資料上 property_raw 是有值的（契約帶的房號,公司登記在 2F-28），
 * 但那兩類不是租金收入,依物業房源分組時本來就不參與。
 * 顯示房號會讓人以為「這間房這個月有這筆收入」,然後拿去對帳對不起來。
 */
export function roomCell(r: RevRow): TwoLine {
  const noRoom = isOffice(r) || isCompany(r);
  const room = noRoom ? '' : (r.property_raw ?? '').trim();
  const estate = (r.estate_name ?? '').trim();
  // 沒有房源時把物業提上來當主要那行 —— 不然主要那行是空的而第二行有字,
  // 整張表會看起來像少了一格
  if (!room) return { main: estate || DASH, sub: '' };
  return { main: room, sub: estate };
}

/**
 * 一段區間收成一行。
 *
 * 起訖同一天就只寫一個日期 —— 「2026-07-31~2026-07-31」佔兩倍寬度
 * 而沒有比「2026-07-31」多講任何事。單日認列在短租很常見。
 *
 * 結束那一段省略年份（`07-31` 而不是 `2026-07-31`）:同一段區間跨年的情況
 * 極少，而省下來的寬度每一列都在用。跨年時把年份寫回去。
 */
export function rangeText(from: string | null, to: string | null): string {
  const a = (from ?? '').slice(0, 10);
  const b = (to ?? '').slice(0, 10);
  if (!a && !b) return DASH;
  if (!b || a === b) return a || b;
  if (!a) return b;
  // 跨年就兩邊都寫全,不然「2026-12-28~01-03」看不出是隔年
  const sameYear = a.slice(0, 4) === b.slice(0, 4);
  return `${a}~${sameYear ? b.slice(5) : b}`;
}

/**
 * 期間欄:認列在上、訂單在下。
 *
 * 【為什麼認列是主要那行】
 * 這一頁的主角是認列 —— 篩選條件是「認列月份」，總額加的是當期認列。
 * 訂單起訖是拿來理解「為什麼只認列了六天」用的,是解釋不是主體。
 *
 * 【兩段一樣時只留一行】
 * 沒跨月的訂單兩段完全相同（絕大多數短租都是）。
 * 重複印一次不會讓人更確定,只會讓真正跨月的那幾筆**不再顯眼** ——
 * 而那幾筆才是需要看第二行的。
 */
export function periodCell(r: RevRow, orderRangeText?: string): TwoLine {
  // period_start 缺值退回 checkin —— 舊資料沒有這兩欄,
  // 不退回的話那些列的認列期間會是空白
  const recog = rangeText(r.period_start || r.checkin, r.period_end || r.checkout);
  /*
   * 【長租的第二行是契約期間，不是月租單的起訖】
   *
   * 長租的每一張月租單 checkin~checkout 就是那個月 —— 印出來跟認列期間
   * 幾乎一樣，等於什麼都沒說。真正有用的是**這張單屬於哪一份契約**，
   * 而那要另外查 contracts（頁面算好之後從 orderRangeText 傳進來）。
   *
   * 傳空字串代表「查不到契約」—— 那時退回訂單起訖，不要留白。
   */
  const order = orderRangeText || rangeText(r.checkin, r.checkout);
  return { main: recog, sub: recog === order ? '' : order };
}

/**
 * 金額欄:當期認列在上（粗）、訂單總額在下（灰）。
 *
 * 兩者相同時不重複印 —— 理由同 periodCell:重複的那行會稀釋掉
 * 真正有差額的那幾筆。而有差額的正是需要多看一眼的。
 */
export function amountCell(r: RevRow): TwoLine {
  const month = fmtMoney(r.month_amount);
  const total = fmtMoney(r.total_amount);
  return { main: month, sub: month === total ? '' : total };
}

/** 四捨五入再加千分位。營收的小數是分攤除不盡來的,不是真的有零頭 */
export function fmtMoney(n: number | string | null | undefined): string {
  return '$' + Math.round(Number(n) || 0).toLocaleString();
}

/**
 * 認列天數:`6/6` 這種。
 *
 * 分母是 0 的時候只印分子 —— 一次性收入（清潔費、垃圾代收費）沒有晚數,
 * 印成 `0/0` 會讓人以為資料壞了。
 */
export function nightsText(r: RevRow): string {
  if (!r.total_nights) return r.month_nights ? String(r.month_nights) : DASH;
  return `${r.month_nights}/${r.total_nights}`;
}

/**
 * 每晚均價。抽屜裡才顯示。
 *
 * 【為什麼用認列天數而不是總天數】
 * 這一列講的是這個月,拿總額除總天數會得到一個「整筆訂單的均價」——
 * 那個數字在跨月的列上跟這一列完全無關,而它會被拿去比較。
 *
 * 天數是 0 就回 null（不是 0）—— 算不出來跟「每晚 0 元」是兩件事。
 */
export function nightlyRate(r: RevRow): number | null {
  if (!r.month_nights) return null;
  return Math.round(r.month_amount / r.month_nights);
}

/**
 * 這一列跨月了嗎 —— 抽屜要據此決定講不講「為什麼只認列了一部分」。
 *
 * 判斷用天數而不是日期:日期相同但天數不同的情況存在
 * （認列被手動改過），而那正是最需要解釋的一種。
 */
export function isSplit(r: RevRow): boolean {
  return !!r.total_nights && r.month_nights !== r.total_nights;
}
