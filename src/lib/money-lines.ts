/**
 * 多幣別金額的「一列一種幣別」模型。
 *
 * 【在解決什麼】
 * 原本的表單是「台幣一個欄位 ＋ 其他幣別一份清單」。兩個地方都能填金額，
 * 使用者得先判斷這筆該填哪邊；而且台幣被特別對待，看起來像兩種不同的東西。
 *
 * 現在統一成一份清單，台幣只是其中一列。
 *
 * 【儲存格式完全不變 —— 這點很重要】
 * 資料庫那邊仍然是：
 *
 *     訂單金額  orders.amount      台幣總額（含外幣換算後的部分）
 *               orders.fx_revenue  **非台幣**的明細 {cur, amt, rate}
 *     押金      orders.deposit     台幣押金
 *               orders.fx_deposit  **非台幣**的明細 {cur, amt}
 *
 * 營收報表、押金管理頁、Excel 全都在讀這幾個欄位。改儲存格式等於要動整條線，
 * 而這次要解決的只是「表單長得不一致」—— 那是畫面的問題，不是資料的問題。
 *
 * 所以這裡做的是雙向轉換：讀出來攤成清單，存回去再拆成「台幣 + 其他」。
 */

export const TWD = 'TWD';

export type Line = {
  cur: string;
  amt: number;
  /** 換匯率。台幣恆為 1；押金不換匯（原幣退還），一律 1。 */
  rate: number;
};

/** 資料庫裡的非台幣明細。押金沒有 rate。 */
export type StoredFx = { cur: string; amt: number; rate?: number };

const num = (n: unknown) => Number(n) || 0;

/** 一列換算成台幣。 */
export const lineTwd = (l: Line) => num(l.amt) * num(l.rate);

/** 非台幣各列換算後的台幣合計。 */
export function fxTwd(fx: StoredFx[]): number {
  return (fx ?? []).reduce((a, f) => a + num(f.amt) * num(f.rate ?? 1), 0);
}

/**
 * 資料庫 →  畫面清單。
 *
 * 台幣那一列**一定存在**（即使是 0）—— 沒有的話使用者要先按「新增」才填得了台幣，
 * 而台幣是最常用的那一種，不該比外幣難填。它也一定排第一。
 *
 * @param twdTotal 訂單是 orders.amount（台幣總額，含外幣換算）；押金是 orders.deposit（純台幣）
 * @param fx       非台幣明細
 * @param mode     'revenue' 要換匯（amount 是總額，要扣掉外幣部分才是台幣本體）
 *                 'deposit' 不換匯（deposit 本來就只有台幣）
 */
export function toLines(twdTotal: number | null | undefined, fx: StoredFx[] | null | undefined, mode: 'revenue' | 'deposit'): Line[] {
  const list = (fx ?? []).filter((f) => f && f.cur);
  const twdOwn = mode === 'revenue'
    // amount 是「台幣 + 外幣換算」的總額，扣掉外幣才是台幣本體。
    // 夾在 0 以上 —— 舊資料若有換算誤差，負數會讓畫面出現 -3 元的台幣列。
    ? Math.max(0, Math.round(num(twdTotal) - fxTwd(list)))
    : Math.round(num(twdTotal));

  return [
    { cur: TWD, amt: twdOwn, rate: 1 },
    ...list.map((f) => ({ cur: f.cur, amt: num(f.amt), rate: mode === 'revenue' ? num(f.rate ?? 0) : 1 })),
  ];
}

/**
 * 畫面清單 → 資料庫。
 *
 * 台幣可能被拆成好幾列（使用者自己按了兩次新增又都選 TWD），這裡加總成一列。
 * 不加總的話 orders.deposit 只會拿到其中一列，其餘無聲消失。
 */
export function fromLines(lines: Line[], mode: 'revenue' | 'deposit'): { twd: number; fx: StoredFx[] } {
  const clean = (lines ?? []).filter((l) => l && l.cur && num(l.amt) !== 0);
  const twdOwn = clean.filter((l) => isTwd(l.cur)).reduce((a, l) => a + num(l.amt), 0);
  const others = clean.filter((l) => !isTwd(l.cur));

  const fx: StoredFx[] = others.map((l) => (mode === 'revenue'
    ? { cur: l.cur, amt: num(l.amt), rate: num(l.rate) }
    : { cur: l.cur, amt: num(l.amt) }));

  return {
    // 訂單金額存的是總額（台幣 + 外幣換算）；押金不換匯，只存台幣那部分
    twd: mode === 'revenue' ? Math.round(twdOwn + fxTwd(fx)) : Math.round(twdOwn),
    fx,
  };
}

export const isTwd = (cur: string) => (cur || '').trim().toUpperCase() === TWD;

/** 畫面上的台幣合計（訂單金額用）。押金不換匯，加總沒有意義。 */
export function totalTwd(lines: Line[]): number {
  return Math.round((lines ?? []).reduce((a, l) => a + lineTwd(l), 0));
}

/**
 * 存檔前的檢查。回傳錯誤訊息，沒問題回 null。
 *
 * 只擋「填了金額卻沒填匯率」——那會讓一筆外幣營收算成 0 元靜靜溜進報表。
 * 其餘的空列、0 元列在 fromLines() 會被濾掉，不用擋。
 */
export function validateLines(lines: Line[], mode: 'revenue' | 'deposit'): string | null {
  for (const l of lines ?? []) {
    if (!num(l.amt)) continue;
    if (!l.cur?.trim()) return '幣別沒有填';
    if (mode === 'revenue' && !isTwd(l.cur) && !(num(l.rate) > 0)) {
      return `${l.cur.toUpperCase()} 有金額但沒有匯率`;
    }
  }
  return null;
}

/** 新增一列時的預設。已經有台幣了就給空白幣別，讓使用者自己打。 */
export function blankLine(lines: Line[]): Line {
  return { cur: lines.some((l) => isTwd(l.cur)) ? '' : TWD, amt: 0, rate: 1 };
}
