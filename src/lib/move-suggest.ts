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
 * ★★ 閒置怎麼算（2026-10-20 David 定案）：
 *   「比對這張訂單入住前的閒置晚數，跟移完房有沒有減少；減少的晚數越多越好。
 *    閒置＝這張訂單起 − 上一張訂單迄。A04 上一張單迄是很久之前，閒置就會很多。」
 *
 *   原房：這張單跟旁邊那張中間空幾晚（零碎空檔，3 晚以下才會被列出來）
 *   候選：搬過去後，跟那間同一邊最近的那張中間空幾晚
 *     · 空檔在這張單前面 → 這張的入住日 − 那間上一張的退房日（沒有上一張就從今天算）
 *     · 空檔在這張單後面 → 那間下一張的入住日 − 這張的退房日（沒有下一張就算到 60 天底）
 *   只列「搬過去空得比較少」的房；空得越少（減少越多）越好。
 */
export type MoveCandidate = { toRoom: string;
  /** 搬過去後這張單旁邊空幾晚。0＝接上 */
  after: number };
/** 一張要移的訂單：原房間、旁邊的零碎空檔、搬到各間之後旁邊空幾晚（少的在前，第一個是最佳） */
export type MoveSuggestion = {
  stayId: string; guest: string | null;
  from: Ymd; to: Ymd;              // 訂單的入住、退房日
  fromRoom: string;
  gapFrom: Ymd; gapTo: Ymd;        // 原房間的零碎空檔（gapTo＝空檔後第一個有人的晚）
  gapNights: number;
  /** 空檔在這張單的哪一邊 */
  side: 'before' | 'after';
  before: number;                  // 原房：這張單旁邊空幾晚（＝gapNights）
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

/** 能不能動：還沒入住的短租／私下訂單 */
export const movable = (s: Stay, today: Ymd) =>
  s.kind === 'order' && (s.tone === 'short' || s.tone === 'private') && !!s.start && !!s.end && s.start > today;

/** 搬到這間後，這張單 side 那一邊空幾晚（沒單就算到今天／60 天底） */
export function sideGap(stT: readonly Stay[], start: Ymd, end: Ymd, side: 'before' | 'after', today: Ymd, winTo: Ymd): number {
  const occ = (d: Ymd) => stT.some((s) => occupies(s, d));
  let k = 0;
  if (side === 'before') { for (let d = addDays(start, -1); d >= today && !occ(d); d = addDays(d, -1)) k++; }
  else { for (let d = end; d < winTo && !occ(d); d = addDays(d, 1)) k++; }
  return k;
}

export function suggestMoves(
  rooms: readonly string[], stays: readonly Stay[], today: Ymd, days = 60, maxGap = 3, limit = 10, maxCands = 4,
): MoveSuggestion[] {
  const winTo = addDays(today, days);
  const by = new Map<string, Stay[]>(rooms.map((r) => [r, []]));
  for (const s of stays) by.get(s.room)?.push(s);
  const out = new Map<string, MoveSuggestion>();

  for (const R of rooms) {
    const stR = by.get(R)!;
    for (const g of smallGaps(stR, today, winTo, maxGap)) {
      // 空檔兩邊的那兩筆：入住日＝空檔後第一晚的（空檔在它前面）、退房日＝空檔第一天的（空檔在它後面）
      const sides = stR.filter((s) => movable(s, today) && (s.start === g.to || s.end === g.from));
      for (const X of sides) {
        if (out.has(X.id)) continue;
        const side: 'before' | 'after' = X.start === g.to ? 'before' : 'after';
        const cands: MoveCandidate[] = [];
        for (const T of rooms) {
          if (T === R) continue;
          const stT = by.get(T)!;
          let ok = true;           // 那間這幾晚要整段空
          for (let d = X.start!; d < X.end!; d = addDays(d, 1)) if (stT.some((s) => occupies(s, d))) { ok = false; break; }
          if (!ok) continue;
          const after = sideGap(stT, X.start!, X.end!, side, today, winTo);
          if (after < g.n) cands.push({ toRoom: T, after });
        }
        if (!cands.length) continue;
        cands.sort((a, b) => a.after - b.after || a.toRoom.localeCompare(b.toRoom, 'en', { numeric: true }));
        out.set(X.id, {
          stayId: X.id, guest: X.guest ?? null, from: X.start!, to: X.end!, fromRoom: R,
          gapFrom: g.from, gapTo: g.to, gapNights: g.n, side, before: g.n, cands: cands.slice(0, maxCands),
        });
      }
    }
  }
  /* 減少越多的排前面 */
  return [...out.values()]
    .sort((a, b) => (b.before - b.cands[0].after) - (a.before - a.cands[0].after) || a.from.localeCompare(b.from))
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
