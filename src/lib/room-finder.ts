import { addDays, eachDay, lastNightOf, occupies, type Stay, type Ymd } from './room-calendar.ts';
import { movable } from './move-suggest.ts';

/**
 * ============================================================
 * 找房（房源狀態頁的「🔍 找房」，2026-10-19 David 過審 A 案）
 *
 *   輸入：住宿起、退房日（退房那晚不算）、一個物業裡的房、那段期間的佔用
 *   輸出三種之一：
 *     full  整段空房 —— 每一晚都沒人的房
 *     mix   只能拼   —— 沒有整段空的，但同一個物業裡幾間接起來剛好蓋滿（換房次數最少的，最多 3 組）
 *     none  沒有空房 —— 有某幾晚整個物業都滿，拼也拼不起來（寫出是哪幾晚）
 *
 * ★ 只在傳進來的那幾間裡找 —— 呼叫端只傳同一個物業的房（David：「不要跨物業移房」）。
 * ★ 訂金／未確認的也算佔用：那幾晚已經答應別人了。
 * ============================================================
 */

export type FinderSeg = { room: string; from: Ymd; to: Ymd; nights: number };
export type FinderResult =
  | { kind: 'full'; rooms: string[]; nights: number }
  | { kind: 'mix'; plans: FinderSeg[][]; nights: number }
  | { kind: 'none'; fullNights: Ymd[]; nights: number }
  | { kind: 'bad'; message: string };

/** 這段住幾晚（退房那天不算）。日期不對回 0 */
export function nightsBetween(from: Ymd, to: Ymd): number {
  if (!from || !to) return 0;
  const n = Math.round((new Date(`${to}T00:00:00`).getTime() - new Date(`${from}T00:00:00`).getTime()) / 86400000);
  return n > 0 ? n : 0;
}

/** 找房起訖的擋門訊息；null ＝ 可以找 */
export function finderError(from: Ymd, to: Ymd, maxNights = 92): string | null {
  if (!from || !to) return '住宿起與退房日都要填';
  const n = nightsBetween(from, to);
  if (n <= 0) return '退房日要在住宿起之後';
  if (n > maxNights) return `一次最多找 ${maxNights} 晚`;
  return null;
}

export function findRooms(rooms: readonly string[], stays: readonly Stay[], from: Ymd, to: Ymd, maxPlans = 3): FinderResult {
  const bad = finderError(from, to);
  if (bad) return { kind: 'bad', message: bad };
  const nights = eachDay({ from, to: addDays(to, -1) });
  const N = nights.length;
  const by = new Map<string, Stay[]>();
  for (const s of stays) (by.get(s.room) ?? by.set(s.room, []).get(s.room)!).push(s);
  /** free[r][i]：第 r 間房第 i 晚空不空 */
  const free = rooms.map((r) => nights.map((d) => !(by.get(r) ?? []).some((s) => occupies(s, d))));

  const full = rooms.filter((_, r) => free[r].every(Boolean));
  if (full.length) return { kind: 'full', rooms: full, nights: N };

  const fullNights = nights.filter((_, i) => free.every((f) => !f[i]));
  if (fullNights.length || !rooms.length) return { kind: 'none', fullNights, nights: N };

  /** 從第 i 晚起，第 r 間連續空幾晚 */
  const run = (r: number, i: number) => { let j = i; while (j < N && free[r][j]) j++; return j - i; };

  /*
   * 最少換房次數：從第 i 晚起最少要幾段。每一步都住到那間房空到的最後一晚 ——
   *   住短一點再換不會讓總段數變少（區間覆蓋的貪婪性質），所以只需要看每間房的「最長那一段」。
   */
  const memo = new Map<number, number>();
  const best = (i: number): number => {
    if (i >= N) return 0;
    if (memo.has(i)) return memo.get(i)!;
    let m = Infinity;
    for (let r = 0; r < rooms.length; r++) { const k = run(r, i); if (k > 0) m = Math.min(m, 1 + best(i + k)); }
    memo.set(i, m);
    return m;
  };
  const min = best(0);
  if (!Number.isFinite(min)) return { kind: 'none', fullNights: [], nights: N };

  /* 列出段數最少的組合（同一段數裡，第一段住得久的排前面），最多 maxPlans 組 */
  const plans: FinderSeg[][] = [];
  const walk = (i: number, acc: FinderSeg[], prev: number) => {
    if (plans.length >= maxPlans) return;
    if (i >= N) { plans.push(acc); return; }
    const opts = rooms.map((_, r) => ({ r, k: run(r, i) }))
      .filter((o) => o.k > 0 && o.r !== prev && 1 + best(i + o.k) === best(i))
      .sort((a, b) => b.k - a.k || rooms[a.r].localeCompare(rooms[b.r], 'en', { numeric: true }));
    for (const o of opts) {
      walk(i + o.k, [...acc, { room: rooms[o.r], from: nights[i], to: addDays(nights[i + o.k - 1], 1), nights: o.k }], o.r);
      if (plans.length >= maxPlans) return;
    }
  };
  walk(0, [], -1);
  return { kind: 'mix', plans, nights: N };
}

/** 拼房建單時每一段分多少錢：照晚數攤，零頭給最後一段（加起來一定等於總價） */
export function splitPrice(total: number, segs: readonly { nights: number }[]): number[] {
  const t = Math.round(Number(total) || 0);
  const all = segs.reduce((n, s) => n + s.nights, 0);
  if (!all) return segs.map(() => 0);
  const out = segs.map((s) => Math.floor((t * s.nights) / all));
  out[out.length - 1] += t - out.reduce((a, b) => a + b, 0);
  return out;
}

/*
 * ══════════ 找房的建議（2026-10-20 David 過審：A 推薦那間、C 移一張單）══════════
 * 跟移房建議同一個原則：零碎空檔（夾在兩筆中間、maxGap 晚以下）越少越好。
 * ★ 只列建議、不動資料。
 */

/** 排進 [from, to) 之後，前後各留下幾晚零碎空檔。null＝那一邊很空（不算零碎） */
export function fitOf(st: readonly Stay[], from: Ymd, to: Ymd, maxGap = 3): { before: number | null; after: number | null; waste: number } {
  const occ = (d: Ymd) => st.some((s) => occupies(s, d));
  let before: number | null = null;
  for (let k = 0; k <= maxGap; k++) if (occ(addDays(from, -1 - k))) { before = k; break; }
  let after: number | null = null;
  for (let k = 0; k <= maxGap; k++) if (occ(addDays(to, k))) { after = k; break; }
  return { before, after, waste: (before ?? 0) + (after ?? 0) };
}

export type FinderPick = { room: string; why: string };

/** A：好幾間都整段空的時候，推薦排進去最不留零碎空檔的那間。分不出高下 → null */
export function recommendRoom(rooms: readonly string[], stays: readonly Stay[], from: Ymd, to: Ymd, maxGap = 3): FinderPick | null {
  if (rooms.length < 2) return null;
  const sc = rooms.map((r) => {
    const f = fitOf(stays.filter((s) => s.room === r), from, to, maxGap);
    return { r, f, adj: Number(f.before === 0) + Number(f.after === 0) };
  });
  const better = (a: typeof sc[0], b: typeof sc[0]) => a.f.waste - b.f.waste || b.adj - a.adj;
  const best = [...sc].sort(better)[0];
  if (!sc.some((x) => better(best, x) < 0)) return null;
  const why = best.f.waste > 0 ? `排進去只留 ${best.f.waste} 晚零碎空檔（最少）`
    : best.adj === 2 ? '前後都接著別人的訂單，排進去不留零碎空檔'
    : best.adj === 1 ? '接著別人的訂單，排進去不留零碎空檔'
    : '排進去不留零碎空檔';
  return { room: best.r, why };
}

export type FreeByMove = {
  room: string;                    // 客人整段住這間
  stayId: string; guest: string | null; start: Ymd; end: Ymd;   // 擋在中間、要移走的那一張（end＝退房日）
  toRoom: string;                  // 移去哪
};

/**
 * C：沒有整段空房時，看「只移一張還沒入住的短租／私下」能不能空出整段。
 * 那一張要能整段搬到同物業另一間（那幾晚整段空）。移去哪一間挑留下零碎空檔最少的。
 */
export function freeByMoving(
  rooms: readonly string[], stays: readonly Stay[], from: Ymd, to: Ymd, today: Ymd, limit = 3, maxGap = 3,
): FreeByMove[] {
  const nights = eachDay({ from, to: addDays(to, -1) });
  const by = new Map<string, Stay[]>(rooms.map((r) => [r, []]));
  for (const s of stays) by.get(s.room)?.push(s);
  const out: (FreeByMove & { cost: number })[] = [];
  for (const r of rooms) {
    const block = (by.get(r) ?? []).filter((s) => nights.some((d) => occupies(s, d)));
    if (block.length !== 1) continue;
    const s = block[0];
    if (!movable(s, today)) continue;
    const last = lastNightOf(s);
    if (!s.start || !last) continue;
    const span = eachDay({ from: s.start, to: last });
    let pick: { t: string; w: number } | null = null;
    for (const t of rooms) {
      if (t === r) continue;
      const ts = by.get(t) ?? [];
      if (span.some((d) => ts.some((x) => occupies(x, d)))) continue;
      const w = fitOf(ts, s.start, addDays(last, 1), maxGap).waste;
      if (!pick || w < pick.w) pick = { t, w };
    }
    if (!pick) continue;
    const left = (by.get(r) ?? []).filter((x) => x !== s);
    out.push({ room: r, stayId: s.id, guest: s.guest ?? null, start: s.start, end: s.end ?? addDays(last, 1), toRoom: pick.t,
      cost: pick.w + fitOf(left, from, to, maxGap).waste });
  }
  return out.sort((a, b) => a.cost - b.cost || a.room.localeCompare(b.room, 'en', { numeric: true }))
    .slice(0, limit).map(({ cost: _c, ...x }) => x);
}
