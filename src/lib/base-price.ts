/**
 * ============================================================
 * 基本定價 → 找房報價（2026-10-20 David 過審）
 *
 *   每間房三個價：平日／假日／旺日（properties.price_weekday / price_holiday / price_peak）
 *   每個物業一條「星期幾算哪一種」（estates.price_dow，7 個字母，日→六）
 *     w＝平日、h＝假日、p＝旺日。時兆：日～四平日、五假日、六旺日 → 'wwwwwhp'
 *
 * ★ 算的是「住哪一晚」：週五晚上住＝假日價。退房那天不算。
 * ★ 有任何一晚要用的價沒填 → 整段不報價（回 null），不要報一個少算的數字。
 * ★ 先不做：國定假日、連假、特殊日期、清潔費、長住折扣。
 * ============================================================
 */

export type Ymd = string;
export type DayKind = 'w' | 'h' | 'p';
export const DAY_KIND_LABEL: Record<DayKind, string> = { w: '平日', h: '假日', p: '旺日' };
/** 明細的順序（David 指定的寫法：平日 · 假日 · 旺日） */
const ORDER: DayKind[] = ['w', 'h', 'p'];
export const DEFAULT_DOW = 'wwwwwhp';

export type BasePrice = { w: number | null; h: number | null; p: number | null };
export type QuotePart = { kind: DayKind; nights: number; sum: number };
export type Quote = { total: number; nights: number; parts: QuotePart[] };

export function dowOk(s: unknown): s is string {
  return typeof s === 'string' && /^[whp]{7}$/.test(s);
}

/** 這一晚是平日、假日還是旺日 */
export function dayKind(d: Ymd, dow: string): DayKind {
  const pat = dowOk(dow) ? dow : DEFAULT_DOW;
  return pat[new Date(`${d}T00:00:00Z`).getUTCDay()] as DayKind;
}

/** 設定頁點一下換：平日 → 旺日 → 假日 → 平日 */
export function nextKind(k: DayKind): DayKind {
  return k === 'w' ? 'p' : k === 'p' ? 'h' : 'w';
}

/** 改某一天的種類，回新的 7 字串 */
export function setDow(dow: string, i: number, k: DayKind): string {
  const pat = dowOk(dow) ? dow : DEFAULT_DOW;
  return pat.slice(0, i) + k + pat.slice(i + 1);
}

function addDay(d: Ymd): Ymd {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + 1);
  return t.toISOString().slice(0, 10);
}

/** 住 from 到 to（退房日，不算）的報價。缺價或日期不對 → null */
export function quoteStay(from: Ymd, to: Ymd, price: BasePrice | null | undefined, dow: string): Quote | null {
  if (!price || !from || !to || to <= from) return null;
  const cnt: Record<DayKind, number> = { w: 0, h: 0, p: 0 };
  let n = 0;
  for (let d = from; d < to; d = addDay(d)) {
    cnt[dayKind(d, dow)]++;
    if (++n > 400) return null;
  }
  const parts: QuotePart[] = [];
  for (const k of ORDER) {
    if (!cnt[k]) continue;
    const v = price[k];
    if (v == null || !(v > 0)) return null;
    parts.push({ kind: k, nights: cnt[k], sum: v * cnt[k] });
  }
  return { total: parts.reduce((a, b) => a + b.sum, 0), nights: n, parts };
}

/** 拼房：每一段照那一間的價算。任何一段算不出 → null */
export function quotePlan(
  segs: readonly { room: string; from: Ymd; to: Ymd }[],
  priceOf: (room: string) => BasePrice | null | undefined,
  dow: string,
): { total: number; segs: Quote[] } | null {
  const qs: Quote[] = [];
  for (const sg of segs) {
    const q = quoteStay(sg.from, sg.to, priceOf(sg.room), dow);
    if (!q) return null;
    qs.push(q);
  }
  return { total: qs.reduce((a, b) => a + b.total, 0), segs: qs };
}

const money = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;

/** 平日×5 $6,500 · 假日×1 $1,750 · 旺日×1 $2,100 */
export function partsText(parts: readonly QuotePart[]): string {
  return parts.map((p) => `${DAY_KIND_LABEL[p.kind]}×${p.nights} ${money(p.sum)}`).join(' · ');
}

/** A09 平日×3 $5,250 → A04 平日×2 $2,800 · 假日×1 $2,250 */
export function planText(segs: readonly { room: string }[], qs: readonly Quote[]): string {
  return segs.map((sg, i) => `${sg.room} ${partsText(qs[i]?.parts ?? [])}`).join(' → ');
}

/** 📋 複製報價：時兆 A11　11/17～11/24（7 晚）NT$ 10,350 */
export function quoteLine(estate: string, room: string, from: Ymd, to: Ymd, nights: number, total: number): string {
  const md = (d: Ymd) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
  return `${estate} ${room}　${md(from)}～${md(to)}（${nights} 晚）NT$ ${Math.round(total).toLocaleString('en-US')}`;
}

/** 假日比旺日貴 → 提醒看一下是不是填反（存得進去，只是提醒） */
export function priceWarn(p: BasePrice): boolean {
  return p.h != null && p.p != null && p.h > p.p;
}

/** 設定頁的輸入：空白＝清掉；正整數；其餘擋下 */
export function parseBasePrice(raw: string): { ok: true; value: number | null } | { ok: false; error: string } {
  const s = raw.replace(/[,\s$]/g, '');
  if (!s) return { ok: true, value: null };
  if (!/^\d+$/.test(s)) return { ok: false, error: '價格只能填整數（不含小數）' };
  const v = Number(s);
  if (v <= 0) return { ok: false, error: '價格要大於 0；沒有定價的話留空' };
  if (v > 1_000_000) return { ok: false, error: '價格太大了，確認一下是不是多打了 0' };
  return { ok: true, value: v };
}
