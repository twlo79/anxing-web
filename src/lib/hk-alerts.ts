/**
 * 未來提醒。（2026-09-16 使用者：「房務管理多一個未來提醒，包含退租提醒／退房提醒」
 * ＋「多一個契約結束提醒，主要是租辦公室與公司登記的契約」）
 *
 * ══════════════════════════════════════════════════════════
 * 三塊，不是兩塊：
 *
 *     退租提醒　　長租契約到期　　　　　→ 要開始找下一個房客、要排點交清潔
 *     退房提醒　　短租訂單退房　　　　　→ 要排清潔、備品、接下一組
 *     契約結束　　公司登記／辦公室到期　→ 要問要不要續約
 *
 * ★★★ 第三塊為什麼要單獨切出來：
 *   公司登記與辦公室**沒有人住在裡面**。混在退租提醒裡的話，
 *   管家會照著那張表去排退房清潔 —— 而那間房根本沒有人。
 *   用詞也不對:公司登記不叫「退租」。
 *
 * ★★ 切法是「是不是 company／office」的**二分**，
 *   不是「挑這兩種出來另外列」。三種類別加起來就是全部 ——
 *   日後 `contracts.type` 多一種，它會掉進退租那塊而不是**從畫面上消失**。
 *   （消失的東西沒有人會回報，因為他不知道那裡本來有東西。）
 *
 * ★ 算式一律走 `exitsSoon()`，這裡不重寫。差一天的規則有 59 個測試釘著，
 *   在這裡另外寫一份的話，同一張契約會在兩頁顯示不同的天數。
 * ══════════════════════════════════════════════════════════
 *
 * ★ 寫在 `.ts` 不是 `.tsx` —— 測試環境不處理 JSX。
 */

import { type Exit, type Stay, ENDING_DAYS, LEAVING_DAYS } from './room-calendar.ts';

/* ══════════ 天數窗口 ══════════ */

/**
 * 可以選的天數。`0` ＝ 全部（往後不設上界）。
 *
 * ★★★ 2026-09-16 使用者：「不要有 hardcode 什麼時候」。
 *   原本標題上印著「契約在 180 天內到期」—— 那行字等於把一個
 *   **他改不動的決定**印在畫面上。現在窗口是按出來的。
 *
 * ★★ `ENDING_DAYS` ／ `LEAVING_DAYS` 因此降級成**預設值**，
 *   不再是規則本身。房源狀態那兩顆旋鈕照舊用它們。
 */
export const ALERT_WINDOWS = [7, 14, 30, 90, 180, 0] as const;
export type AlertWindow = (typeof ALERT_WINDOWS)[number];

/** 預設 30 天。三塊共用一個窗口，30 是三件事都還讀得完的長度 */
export const DEFAULT_WINDOW: AlertWindow = 30;

/**
 * 「全部」實際傳給 `exitsSoon()` 的上界。
 *
 * ★ 十年。`Infinity` 不行 —— `daysBetween()` 回的是有限數字，
 *   但拿 Infinity 去做 `.lte(addDays(today, Infinity))` 會生出 `Invalid Date`，
 *   而那個查詢會**回成功、0 列**（README 坑 C 的另一種形狀）。
 */
export const WIN_ALL = 3650;

/** 選單上的字。`0` → `全部` */
export function winLabel(w: number): string {
  return w === 0 ? '全部' : `${w} 天`;
}

/** 真正拿去篩的天數。`0` → `WIN_ALL` */
export function winDays(w: number): number {
  return w === 0 ? WIN_ALL : w;
}

/**
 * 網址上的 `?win=` 轉回窗口。
 *
 * ★ 認不得就回預設，不是回 0（＝全部）。網址被改壞時
 *   跳出一整頁「往後十年」比跳回預設難發現得多。
 *
 * ★★★ 先擋掉空的再 `Number()` —— `Number('')`、`Number(null)`、
 *   `Number('   ')` 全部是 **0**，而 0 在這裡的意思是「全部」。
 *   少了這一行，`?win=` 空著或參數根本不存在時就會安靜地
 *   打開一整頁「往後十年」，而畫面上只是「怎麼這麼多筆」。
 *   （測試先抓到的就是這一條。）
 */
export function parseWin(raw: string | null | undefined): AlertWindow {
  const s = (raw ?? '').trim();
  if (!/^\d+$/.test(s)) return DEFAULT_WINDOW;
  const n = Number(s);
  return (ALERT_WINDOWS as readonly number[]).includes(n) ? (n as AlertWindow) : DEFAULT_WINDOW;
}

/* ══════════ 契約類別 ══════════ */

/** `contracts.type` 的中文。跟契約頁同一組字（那邊叫 `TYPE_LABEL`） */
export const CONTRACT_TYPE_LABEL: Record<string, string> = {
  longterm: '長租', company: '公司登記', office: '辦公室',
};
export function contractTypeLabel(t: string | null | undefined): string {
  return CONTRACT_TYPE_LABEL[t ?? ''] ?? (t || '未分類');
}

/**
 * 是不是「沒有人住」的那一類 —— 公司登記與辦公室。
 *
 * ★★★ 用 `=== 'company' || === 'office'` 而不是 `!== 'longterm'`，
 *   兩種寫法在今天完全等價，但意思相反:
 *   前者是「這兩種是特例」，後者是「只有長租是正常的」。
 *   日後多一種類別（例如短期辦公），前者讓它掉進退租那塊 ——
 *   **看得到而且分錯了**，總比從畫面上消失好。
 */
export function isBizContract(ctype: string | null | undefined): boolean {
  return ctype === 'company' || ctype === 'office';
}

/**
 * 把契約的提醒分成「退租」與「契約結束」兩堆。
 *
 * ★ 回的是兩個陣列而不是一個帶旗標的 —— 畫面要的是兩張表，
 *   在畫面上 `.filter()` 兩次的話，那條規則就會在 `.tsx` 裡各寫一次，
 *   而 `.tsx` 裡的判斷式測不到。
 */
export function splitContractExits(exits: readonly Exit[]): { lease: Exit[]; biz: Exit[] } {
  const lease: Exit[] = [];
  const biz: Exit[] = [];
  for (const e of exits) {
    (isBizContract(e.stay.ctype) ? biz : lease).push(e);
  }
  return { lease, biz };
}

/* ══════════ 畫面上的字 ══════════ */

/**
 * 「還有 N 天」。
 *
 * ★ 0 寫「就是今天」不寫「還有 0 天」—— 後者讀起來像「還有時間」，
 *   而那正是今天要處理的那一筆。
 */
export function daysLabel(n: number): string {
  if (n === 0) return '就是今天';
  if (n < 0) return `已經過了 ${-n} 天`;
  return `還有 ${n} 天`;
}

/**
 * 紅／琥珀／一般。
 *
 * ★★★ 門檻**固定**在 7 ／ 30，不跟著天數選擇器跑。
 *   跟著跑的話，選「7 天」時整頁都是紅的 —— 那就等於沒有標色，
 *   而標色要回答的是「這幾筆裡哪些最急」。
 */
export const HOT_DAYS = 7;
export const WARM_DAYS = 30;
export function exitTone(n: number): 'hot' | 'warm' | 'calm' {
  if (n <= HOT_DAYS) return 'hot';
  if (n <= WARM_DAYS) return 'warm';
  return 'calm';
}

/* ══════════ 權限 ══════════ */

/**
 * 誰看得到這個分頁。（2026-09-16 使用者：「管家 主管 會計 總經理 都能讀」）
 *
 * ★★★ 房務（cleaner）不在名單裡 —— 他們不管退租退房。
 * ★★ 這一份**不是** `canEdit`:房務管理頁現有的 `canEdit`
 *   （會計／主管／總經理）少了管家。直接借用的話，
 *   管家點進房務管理會**看不到這個分頁**，而他正是最需要它的人。
 * ★ 不渲染而不是灰掉 —— 灰掉的分頁會讓人一直去點。
 */
export const ALERT_ROLES = ['housekeeper', 'accountant', 'manager', 'super_admin'] as const;
export function canSeeAlerts(role: string | null | undefined): boolean {
  return (ALERT_ROLES as readonly string[]).includes(role ?? '');
}

/* ══════════ 預設值（沿用房源狀態那兩支） ══════════ */
export { ENDING_DAYS, LEAVING_DAYS };
export type { Exit, Stay };
