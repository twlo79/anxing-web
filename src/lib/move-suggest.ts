import { addDays, occupies, type Stay, type Ymd } from './room-calendar.ts';

/**
 * ============================================================
 * 移房建議（房源狀態「💡 移房建議」，2026-10-20 David 過審）
 *
 *   【David】「移房通常的原因是：訂單中間有閒置日期無法運用 → 把訂單移到另一間，中間閒置日期減少」
 *
 *   零碎空檔＝夾在兩筆中間、maxGap 晚以下的空房（賣不掉的那幾晚）。
 *   對每個零碎空檔旁邊的那一筆，試著**整段**搬到同物業的別間：
 *     · 那間這幾晚要整段空
 *     · 移完整個物業的零碎空檔晚數（閒置）要變少
 *   每張單列出所有能搬的房（候選），照移完的閒置晚數由少到多；最少的那個是最佳。
 *
 * ★ 只列建議，不動資料（David：「先不要做行為，方便記下就好」）。
 * ★ 只動還沒入住的短租／私下訂單；契約、訂金、已入住的不動。只在傳進來的房（同一個物業）裡找。
 * ★ 只做整段移 —— 部分移要客人中途換房，為了填兩三晚通常不划算。
 * ============================================================
 */

/**
 * snug：搬過去接得上幾邊（0～2）—— 前一晚、退房那晚有人住各算一邊。
 * ★ 閒置一樣多時，接得上的排前面（2026-10-20 David：「B05 應該是最好的」——
 *   B05 前一筆剛好在入住那天退房，搬過去不留縫；空房 A04 閒置一樣但把房間切開）。
 */
export type MoveCandidate = { toRoom: string; after: number; snug: number;
  /** 搬過去會切開的那一段空房有幾晚（前後空著的加起來）。越短越好 —— 整段空著的房盡量留著（David：「A04 應該盡量空著」） */
  room: number;
  /**
   * 這 60 天整段沒有單的房。★ 一律排最後（David 2026-10-20：「A04 只是沒單所以算不出閒置，它是最差的」）——
   *   空房的閒置算出來是 0，只是因為沒有單可以夾出空檔；搬進去等於把一間完整的空房切開。
   */
  empty: boolean };
/** 一張要移的訂單：原房間、旁邊的零碎空檔、移到各間之後整個物業的閒置晚數（少的在前，第一個是最佳） */
export type MoveSuggestion = {
  stayId: string; guest: string | null;
  from: Ymd; to: Ymd;              // 訂單的入住、退房日
  fromRoom: string;
  gapFrom: Ymd; gapTo: Ymd;        // 原房間的零碎空檔（gapTo＝空檔後第一個有人的晚）
  gapNights: number;
  before: number;                  // 現在整個物業的閒置晚數
  cands: MoveCandidate[];          // 照 after 由少到多；[0] 是最佳
};

type Gap = { from: Ymd; to: Ymd; n: number };

/** 一間房在 [from, to) 這幾晚的零碎空檔（兩邊都要有人住、且 ≤ maxGap 晚） */
export function smallGaps(stays: readonly Stay[], from: Ymd, to: Ymd, maxGap: number): Gap[] {
  const out: Gap[] = [];
  const occ = (d: Ymd) => stays.some((s) => occupies(s, d));
  let d = from;
  while (d < to) {
    if (occ(d)) { d = addDays(d, 1); continue; }
    let e = d; while (e < to && !occ(e)) e = addDays(e, 1);
    const n = Math.round((new Date(`${e}T00:00:00`).getTime() - new Date(`${d}T00:00:00`).getTime()) / 86400000);
    if (e < to && occ(addDays(d, -1)) && n <= maxGap) out.push({ from: d, to: e, n });
    d = e;
  }
  return out;
}
const gapNightsOf = (st: readonly Stay[], from: Ymd, to: Ymd, maxGap: number) =>
  smallGaps(st, from, to, maxGap).reduce((a, g) => a + g.n, 0);

/** 能不能動：還沒入住的短租／私下訂單 */
export const movable = (s: Stay, today: Ymd) =>
  s.kind === 'order' && (s.tone === 'short' || s.tone === 'private') && !!s.start && !!s.end && s.start > today;

export function suggestMoves(
  rooms: readonly string[], stays: readonly Stay[], today: Ymd, days = 60, maxGap = 3, limit = 10, maxCands = 4,
): MoveSuggestion[] {
  const winTo = addDays(today, days);
  const by = new Map<string, Stay[]>(rooms.map((r) => [r, []]));
  for (const s of stays) by.get(s.room)?.push(s);
  const gapOf = new Map<string, number>(rooms.map((r) => [r, gapNightsOf(by.get(r)!, today, winTo, maxGap)]));
  /*
   * ★ 閒置＝整個物業所有房間的零碎空檔晚數加總（David：「最優＝把訂單間的閒置日期縮短，越少越好」）。
   *   移一張單只會動到兩間房，所以 after ＝ before − 那兩間原本的 ＋ 那兩間移完的。
   */
  const before = [...gapOf.values()].reduce((a, b) => a + b, 0);
  const out = new Map<string, MoveSuggestion>();

  for (const R of rooms) {
    const stR = by.get(R)!;
    for (const g of smallGaps(stR, today, winTo, maxGap)) {
      // 空檔兩邊的那兩筆：退房日＝空檔第一天的、入住日＝空檔後第一晚的
      const sides = stR.filter((s) => movable(s, today) && (s.end === g.from || s.start === g.to));
      for (const X of sides) {
        if (out.has(X.id)) continue;
        const afterR = gapNightsOf(stR.filter((s) => s.id !== X.id), today, winTo, maxGap);
        const cands: MoveCandidate[] = [];
        for (const T of rooms) {
          if (T === R) continue;
          const stT = by.get(T)!;
          let ok = true;           // 那間這幾晚要整段空
          for (let d = X.start!; d < X.end!; d = addDays(d, 1)) if (stT.some((s) => occupies(s, d))) { ok = false; break; }
          if (!ok) continue;
          const afterT = gapNightsOf([...stT, { ...X, room: T }], today, winTo, maxGap);
          const after = before - gapOf.get(R)! - gapOf.get(T)! + afterR + afterT;
          const snug = Number(stT.some((s) => occupies(s, addDays(X.start!, -1)))) + Number(stT.some((s) => occupies(s, X.end!)));
          const occT = (d: Ymd) => stT.some((s) => occupies(s, d));
          let free = 0;
          for (let d = addDays(X.start!, -1); d >= today && !occT(d); d = addDays(d, -1)) free++;
          for (let d = X.end!; d < winTo && !occT(d); d = addDays(d, 1)) free++;
          const empty = !stT.some((s) => !!s.start && !!s.end && s.start < winTo && (s.end > today || occupies(s, today)));
          if (after < before) cands.push({ toRoom: T, after, snug, room: free, empty });
        }
        if (!cands.length) continue;
        cands.sort((a, b) => Number(a.empty) - Number(b.empty) || a.after - b.after || b.snug - a.snug || a.room - b.room || a.toRoom.localeCompare(b.toRoom, 'en', { numeric: true }));
        out.set(X.id, {
          stayId: X.id, guest: X.guest ?? null, from: X.start!, to: X.end!, fromRoom: R,
          gapFrom: g.from, gapTo: g.to, gapNights: g.n, before, cands: cands.slice(0, maxCands),
        });
      }
    }
  }
  return [...out.values()]
    .sort((a, b) => a.cands[0].after - b.cands[0].after || a.from.localeCompare(b.from))
    .slice(0, limit);
}

/** 「📋 複製全部」的文字 */
export function suggestionsText(list: readonly MoveSuggestion[], estate: string): string {
  const md = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
  return [`移房建議・${estate}`, ...list.map((s, i) =>
    `${i + 1}. ${s.guest ?? ''} ${md(s.from)}～${md(s.to)}：${s.fromRoom}→${s.cands[0].toRoom}（閒置 ${s.before}→${s.cands[0].after}）`
    + (s.cands.length > 1 ? `｜候選 ${s.cands.slice(1).map((c) => `${c.toRoom}(${c.after})`).join('、')}` : '')
    + `｜${s.fromRoom} 空 ${md(s.gapFrom)}～${md(s.gapTo)}（${s.gapNights} 晚）`)].join('\n');
}
