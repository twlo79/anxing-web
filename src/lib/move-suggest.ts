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
 *     · 搬過去那間的零碎空檔不能變多
 *     · 兩間加起來的零碎空檔晚數要變少 → 省多少就是 gain
 *
 * ★ 只列建議，不動資料（David：「先不要做行為，方便記下就好」）。
 * ★ 只動還沒入住的短租／私下訂單；契約、訂金、已入住的不動。只在傳進來的房（同一個物業）裡找。
 * ★ 只做整段移 —— 部分移要客人中途換房，為了填兩三晚通常不划算。
 * ============================================================
 */

export type MoveSuggestion = {
  stayId: string; guest: string | null;
  from: Ymd; to: Ymd;              // 訂單的入住、退房日
  fromRoom: string; toRoom: string;
  gapFrom: Ymd; gapTo: Ymd;        // 原房間的零碎空檔（gapTo＝空檔後第一個有人的晚）
  gapNights: number;
  freedNights: number;             // 移完原房間連續空幾晚（在看的範圍內）
  gain: number;                    // 兩間加起來少了幾晚零碎空檔
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

/** 移完之後，原房間包住那個空檔的連續空晚數 */
function freeRunAround(st: readonly Stay[], day: Ymd, from: Ymd, to: Ymd): number {
  const occ = (d: Ymd) => st.some((s) => occupies(s, d));
  let a = day; while (a > from && !occ(addDays(a, -1))) a = addDays(a, -1);
  let b = day; while (b < to && !occ(b)) b = addDays(b, 1);
  return Math.round((new Date(`${b}T00:00:00`).getTime() - new Date(`${a}T00:00:00`).getTime()) / 86400000);
}

/** 能不能動：還沒入住的短租／私下訂單 */
export const movable = (s: Stay, today: Ymd) =>
  s.kind === 'order' && (s.tone === 'short' || s.tone === 'private') && !!s.start && !!s.end && s.start > today;

export function suggestMoves(
  rooms: readonly string[], stays: readonly Stay[], today: Ymd, days = 60, maxGap = 3, limit = 10,
): MoveSuggestion[] {
  const winTo = addDays(today, days);
  const by = new Map<string, Stay[]>(rooms.map((r) => [r, []]));
  for (const s of stays) by.get(s.room)?.push(s);
  const best = new Map<string, MoveSuggestion>();

  for (const R of rooms) {
    const stR = by.get(R)!;
    for (const g of smallGaps(stR, today, winTo, maxGap)) {
      // 空檔兩邊的那兩筆：退房日＝空檔第一天的、入住日＝空檔後第一晚的
      const sides = stR.filter((s) => movable(s, today) && (s.end === g.from || s.start === g.to));
      for (const X of sides) {
        const without = stR.filter((s) => s.id !== X.id);
        const beforeR = gapNightsOf(stR, today, winTo, maxGap);
        const afterR = gapNightsOf(without, today, winTo, maxGap);
        for (const T of rooms) {
          if (T === R) continue;
          const stT = by.get(T)!;
          // 那間這幾晚要整段空
          let ok = true;
          for (let d = X.start!; d < X.end!; d = addDays(d, 1)) if (stT.some((s) => occupies(s, d))) { ok = false; break; }
          if (!ok) continue;
          const moved = { ...X, room: T };
          const beforeT = gapNightsOf(stT, today, winTo, maxGap);
          const afterT = gapNightsOf([...stT, moved], today, winTo, maxGap);
          if (afterT > beforeT) continue;                 // 不能在那間製造新的零碎空檔
          const gain = (beforeR + beforeT) - (afterR + afterT);
          if (gain <= 0) continue;
          const cand: MoveSuggestion = {
            stayId: X.id, guest: X.guest ?? null, from: X.start!, to: X.end!, fromRoom: R, toRoom: T,
            gapFrom: g.from, gapTo: g.to, gapNights: g.n,
            freedNights: freeRunAround(without, g.from, today, winTo), gain,
          };
          const cur = best.get(X.id);
          if (!cur || cand.gain > cur.gain) best.set(X.id, cand);
        }
      }
    }
  }
  return [...best.values()].sort((a, b) => b.gain - a.gain || a.from.localeCompare(b.from)).slice(0, limit);
}

/** 「📋 複製全部」的文字 */
export function suggestionsText(list: readonly MoveSuggestion[], estate: string): string {
  const md = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
  return [`移房建議・${estate}`, ...list.map((s, i) =>
    `${i + 1}. ${s.fromRoom}→${s.toRoom} ${s.guest ?? ''} ${md(s.from)}～${md(s.to)}｜${s.fromRoom} 空檔 ${md(s.gapFrom)}～${md(s.gapTo)}（${s.gapNights} 晚）→ 移完連續空 ${s.freedNights} 晚（−${s.gain} 晚）`)].join('\n');
}
