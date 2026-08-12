/**
 * 推播通知的文字（純函式）。
 *
 * ============================================================
 * 【為什麼要有這支】
 *
 * 原本的通知是「爬蟲同步新增 3 筆訂單」—— 那句話沒有任何一個字
 * 能幫你決定要不要點進去。看到了也只能點進去才知道發生什麼事，
 * 幾次之後就不會再點，再幾次之後就把通知關掉。
 *
 * 通知要能被「讀完就結束」：看到 $3,800 的 A15 兩晚，你就知道正常，
 * 不用開。看到 $380，你會立刻開。這才是通知的價值。
 *
 *
 * ============================================================
 * 【重要的欄位放最前面】（使用者決定）
 *
 * 手機通知只保證看得到每一行的開頭 —— 螢幕窄、字級大，
 * 後面被切掉而且**看不出來被切了**。所以順序不是排版問題，
 * 是「哪一個欄位值得被保證看到」。
 *
 *   訂單 → 金額。異常幾乎都是金額異常（少打一個 0、算錯天數）。
 *   評價 → 星等。5 星不用處理，3 星要。星等決定要不要開。
 *
 *
 * ============================================================
 * 【為什麼分隔符是 · 不是 -】
 *
 * 房源名稱本身含 - （「舊-A15」）。用 - 當分隔符的話那一行會變成
 * 「舊-A15 - Kevin」，讀的人分不出哪個是分隔哪個是名字的一部分。
 */

/** 最多列幾筆（使用者決定：4）。 */
export const MAX_LINES = 4;

/** 欄位之間 */
const SEP = ' · ';

/**
 * 千分位。
 *
 * 不用 toLocaleString —— 那會跟著執行環境的 locale 變，
 * 伺服器上可能吐出 "20 000" 或 "20.000"。金額不能有這種不確定性。
 */
export function money(n: number | null | undefined): string {
  const v = Math.round(Number(n) || 0);
  const s = Math.abs(v).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (v < 0 ? '-$' : '$') + s;
}

/**
 * 住宿期間，壓到最短：`7/1–7/5`。
 *
 * 【為什麼不寫完整年份】
 * `2026-07-01~2026-07-05` 是 23 個字，`7/1–7/5` 是 7 個。
 * 差出來的 16 個字在手機通知上就是「房客姓名看不看得到」的差別，
 * 而年份在 99% 的情況下是今年 —— 花掉三分之一的行寬去講一件已知的事。
 *
 * 但**跨年的時候一定要標**，否則 12/28–1/2 看起來像倒退回去。
 *
 * @param today 判斷「今年」用。傳進來而不是直接 new Date()，測試才穩定。
 */
export function stayRange(
  checkin: string | null | undefined,
  checkout: string | null | undefined,
  today: Date = new Date(),
): string {
  const part = (s: string | null | undefined) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s ?? ''));
    return m ? { y: +m[1], md: `${+m[2]}/${+m[3]}` } : null;
  };
  const a = part(checkin);
  const b = part(checkout);
  if (!a && !b) return '';
  if (!a || !b) return (a ?? b)!.md;

  const thisYear = today.getFullYear();
  // 同一年就只標一次 —— 「2027/7/1–2027/7/5」把年份講兩遍，
  // 而多出來的五個字會擠掉後面的欄位
  const left = a.y !== thisYear ? `${a.y}/${a.md}` : a.md;
  const right = b.y !== thisYear && b.y !== a.y ? `${b.y}/${b.md}` : b.md;
  return `${left}–${right}`;
}

/** 星等：整數不補小數（`★5`，不是 `★5.0`） */
export function stars(rating: number | null | undefined): string {
  const n = Number(rating);
  if (!isFinite(n) || n <= 0) return '★－';
  return '★' + (Number.isInteger(n) ? String(n) : n.toFixed(1));
}

/**
 * 把空欄位濾掉再接起來。
 *
 * 不濾的話缺房源那筆會變成「$3,800 ·  · Kevin」——
 * 那個空洞看起來像程式壞了，而實際上只是資料還沒對到房源。
 */
const join = (parts: (string | null | undefined)[]) =>
  parts.map((p) => String(p ?? '').trim()).filter(Boolean).join(SEP);

export type OrderLine = {
  amount: number | null;
  property: string | null;
  guest: string | null;
  checkin: string | null;
  checkout: string | null;
};

/** `$20,000 · A15 · Kevin · 7/1–7/5` */
export function orderLine(o: OrderLine, today: Date = new Date()): string {
  return join([money(o.amount), o.property, o.guest, stayRange(o.checkin, o.checkout, today)]);
}

export type ReviewLine = {
  rating: number | null;
  property: string | null;
  guest: string | null;
};

/** `★3 · A15 · Kevin` */
export function reviewLine(r: ReviewLine): string {
  return join([stars(r.rating), r.property, r.guest]);
}

/**
 * 把多行收成通知內文，超過 MAX_LINES 就自己收尾。
 *
 * 【為什麼要自己截而不是全部丟給手機】
 * 手機會截，但**截在哪裡看不出來**，而且沒有任何提示 ——
 * 讀的人會以為那就是全部。自己截的話至少那句「還有 8 筆」
 * 明確告訴他這則通知不完整，該點進去。
 */
export function importBody(lines: string[], max = MAX_LINES): string {
  if (lines.length <= max) return lines.join('\n');
  const rest = lines.length - max;
  return [...lines.slice(0, max), `⋯還有 ${rest} 筆,點開看`].join('\n');
}

/**
 * 標題帶筆數：`新增 3 筆訂單`。
 *
 * 筆數放標題而不是內文的第一行 —— 標題一定看得到，
 * 而內文的每一行都在跟其他行搶那有限的高度。
 */
export const importTitle = (n: number, unit: string, noun: string) =>
  `新增 ${n} ${unit}${noun}`;
