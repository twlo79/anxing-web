/**
 * 移房的算法 —— **訂單頁與房源狀態頁共用這一份**（2026-10-12 抽出來）。
 *
 * 以前全部寫在 shortterm/page.tsx 裡。房源狀態頁要在本頁移房
 * （David 2026-10-12：「找房源與移房功能在本頁做，同步狀態到訂單」）——
 * 兩頁各寫一份的話，金額怎麼拆、移房鏈怎麼接、備註怎麼追加，
 * 改了一邊另一邊會安靜地留在舊答案。
 *
 * 寫資料庫的那一步一律走 `move_order` RPC（migration_295），這裡只算。
 */
import { roomFree, nightsLabel, type Busy, type RoomRef } from './room-free.ts';

/** 一段：住哪一間、從哪天開始（第一段的 from 會被當成 checkin） */
export type MoveStay = { room: string; estateId: string | null; propertyId: string | null; from: string };

export type MoveState = {
  grp: string; checkin: string; checkout: string;
  totalNights: number; totalAmount: number;
  guest: string | null; source: string; account: string | null; stays: MoveStay[];
  /**
   * 打開視窗**當下**的房號（migration_246）。
   * ★★★ `stays` 會被使用者改掉，所以「原本住哪」只能在開視窗時記下來。
   *   少了它就算不出 `B01>B03` 的第一段 —— 而那正是使用者要看的東西。
   */
  origRooms: string[];
  /**
   * 原本的備註 —— **第一段**的（`move_order` 把備註寫回第一段）。
   * ★ 移房要**追加**不是覆蓋。
   */
  origNote: string | null;
  /** 這段期間其他人佔著哪些房。不含這一組自己、不含已取消。null ＝ 還在載入 */
  busy: Busy[] | null;
};

export type MoveSeg = MoveStay & { to: string; nights: number; amount: number };

const DAY = 86400000;
const nightsOf = (from: string, to: string) =>
  from && to ? Math.round((new Date(to).getTime() - new Date(from).getTime()) / DAY) : 0;

/** 從資料庫那一組分段（依 checkin 排好）組出移房狀態 */
export function moveStateOf(list: readonly {
  id: string; property_raw?: string | null; estate_id?: string | null; property_id?: string | null;
  checkin: string; checkout: string; amount?: number | string | null; note?: string | null;
  guest_name?: string | null; source?: string; account?: string | null;
}[], grp: string): MoveState {
  const first = list[0], last = list[list.length - 1];
  return {
    grp, checkin: first.checkin, checkout: last.checkout,
    totalNights: Math.max(1, nightsOf(first.checkin, last.checkout)),
    totalAmount: list.reduce((a, x) => a + Number(x.amount || 0), 0),
    guest: first.guest_name ?? null, source: first.source ?? '', account: first.account ?? null,
    stays: list.map((x) => ({ room: x.property_raw ?? '', estateId: x.estate_id ?? null, propertyId: x.property_id ?? null, from: x.checkin })),
    origRooms: list.map((x) => (x.property_raw ?? '').trim()).filter(Boolean),
    origNote: first.note ?? null,
    busy: null,
  };
}

/**
 * 各段的起訖、晚數、金額。
 * ★ 金額照晚數比例拆，**最後一段吃尾差** —— 加起來一定等於原本的總額。
 */
export function moveSegments(m: MoveState): MoveSeg[] {
  const segs: MoveSeg[] = m.stays.map((s, i) => {
    const from = i === 0 ? m.checkin : s.from;
    const to = i < m.stays.length - 1 ? m.stays[i + 1].from : m.checkout;
    return { ...s, from, to, nights: nightsOf(from, to), amount: 0 };
  });
  let used = 0;
  segs.forEach((seg, i) => {
    seg.amount = i < segs.length - 1 ? Math.round(m.totalAmount * seg.nights / m.totalNights) : m.totalAmount - used;
    used += seg.amount;
  });
  return segs;
}

/** 擋下來的原因；可以移就回 null */
export function moveError(m: MoveState): string | null {
  const segs = moveSegments(m);
  if (segs.some((s) => !s.room)) return '每段都要選房源';
  for (let i = 1; i < segs.length; i++) {
    if (!m.stays[i].from) return '每個移房都要填移入日期';
    if (new Date(segs[i].from) <= new Date(segs[i - 1].from)) return '移入日期需晚於前一段';
  }
  if (segs.some((s) => s.nights < 1)) return '每段至少 1 晚(日期需在期間內)';
  // 選的房那一段有人住 → 擋（2026-10-06：整段都空才能移）
  if (m.busy) {
    for (let i = 0; i < segs.length; i++) {
      const sg = segs[i];
      const ref = { id: sg.propertyId ?? '', name: sg.room, estate_id: sg.estateId };
      if (!roomFree(m.busy, ref, sg.from, sg.to)) return `第 ${i + 1} 段 ${sg.room} 在 ${nightsLabel(sg.from, sg.to)} 有人住 —— 換一間`;
    }
  }
  return null;
}

/**
 * ★★★ 完整的移房鏈（migration_246）：原本住哪 ＋ 這次的各段，相鄰重複的去掉。
 *     B01 → B03           → ['B01','B03']
 *     B01 → B01>B03（拆段）→ ['B01','B03']   （第一段沒變，不重複記）
 */
export function moveChain(origRooms: readonly string[], segRooms: readonly string[]): string[] {
  const out: string[] = [];
  for (const r of [...origRooms, ...segRooms]) {
    const room = (r ?? '').trim();
    if (room && room !== out[out.length - 1]) out.push(room);
  }
  return out;
}

/**
 * 移房要寫回第一段的 `move_chain` 與 `note`；房號沒變就回空物件（不動備註）。
 *
 * ★★★ 備註**追加**，不是覆蓋（2026-09-14 使用者指定）—— 備註是人手打的，
 *   系統擦掉不會有任何提示。已經有同一條鏈就不再加一次。
 */
export function movePatch(m: MoveState, segs: readonly MoveSeg[]): { move_chain?: string; note?: string } {
  const chain = moveChain(m.origRooms, segs.map((s) => s.room));
  if (chain.length < 2) return {};
  const text = chain.join('>');
  const line = `移房 ${text}`;
  const prev = (m.origNote ?? '').trim();
  return { move_chain: text, note: prev.includes(line) ? prev : (prev ? `${prev}\n${line}` : line) };
}

/** `move_order` RPC 的 p_segs */
export function moveRpcSegs(segs: readonly MoveSeg[]) {
  return segs.map((sg) => ({
    estate_id: sg.estateId, property_id: sg.propertyId, room: sg.room,
    from: sg.from, to: sg.to, nights: sg.nights, amount: sg.amount,
  }));
}

/* ══════════ 房源狀態頁的兩種快速移房 ══════════ */

/** 整段移房：只剩一段、房換掉 */
export function wholeMove(m: MoveState, r: RoomRef): MoveState {
  return { ...m, stays: [{ room: r.name, estateId: r.estate_id, propertyId: r.id, from: m.checkin }] };
}

/**
 * 部分移房：第一段留在原房到 `day`，`day` 起住 `r`。
 * ★ 只給原本是一段的單用 —— 已經分段的單要到訂單頁調（`canQuickMove`）。
 */
export function splitMove(m: MoveState, day: string, r: RoomRef): MoveState {
  const s0 = m.stays[0];
  return { ...m, stays: [{ ...s0, from: m.checkin }, { room: r.name, estateId: r.estate_id, propertyId: r.id, from: day }] };
}

/** 本頁能不能移：已經分成兩段以上的單，在本頁只看得到其中一段，改要回訂單頁 */
export function canQuickMove(m: MoveState): boolean {
  return m.stays.length === 1;
}

/** 「部分移房」可以選的日子：第二晚 ～ 最後一晚（第一天換＝整段換，退房日換＝沒換） */
export function splitDays(m: MoveState): string[] {
  const out: string[] = [];
  const t0 = new Date(m.checkin + 'T00:00:00Z').getTime();
  const n = nightsOf(m.checkin, m.checkout);
  for (let i = 1; i < n; i++) out.push(new Date(t0 + i * DAY).toISOString().slice(0, 10));
  return out;
}

/** [from, to) 每一晚的日期 */
export function nightsIn(from: string, to: string): string[] {
  const out: string[] = [];
  const t0 = new Date(from + 'T00:00:00Z').getTime();
  const n = nightsOf(from, to);
  for (let i = 0; i < n; i++) out.push(new Date(t0 + i * DAY).toISOString().slice(0, 10));
  return out;
}

/**
 * 移房清單：**只列同一個物業**（2026-10-12 David：「不要跨物業移房」），房號排序。
 *   free　　整段都空 —— 可以直接選
 *   partly　只有部分晚數空 —— 列出來但不能選，寫「幾晚有人」叫人改用「部分移房」
 * 每晚都有人的不列（列了也沒用）。`selfId` 是目前住的那間（不列）。
 * ★ 原房沒設物業（estateId null）就一間都不列 —— 不知道是哪個物業，不能猜。
 */
export function moveCandidates<T extends RoomRef>(
  busy: readonly Busy[], rooms: readonly T[], from: string, to: string,
  selfId: string | null, estateId: string | null,
): { free: T[]; partly: { room: T; busyNights: number }[] } {
  const pool = rooms.filter((r) => r.id !== selfId && !!estateId && r.estate_id === estateId)
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant', { numeric: true }));
  const nights = nightsIn(from, to);
  const free: T[] = [], partly: { room: T; busyNights: number }[] = [];
  for (const r of pool) {
    if (roomFree(busy, r, from, to)) { free.push(r); continue; }
    const busyNights = nights.filter((d) => !roomFree(busy, r, d, nightsIn(d, to)[1] ?? to)).length;
    if (busyNights < nights.length) partly.push({ room: r, busyNights });
  }
  return { free, partly };
}

/* ══════════ 清掉移房紀錄（2026-10-14 David：「不然我要一直用 SQL」）══════════ */

type MoveRec = { move_chain?: string | null; move_group?: string | null; note?: string | null };

/** 拿掉 movePatch 追加的那一行「移房 A13>B03」；其他備註原封不動。空了回 null */
export function stripMoveLine(note: string | null | undefined, chain: string): string | null {
  const line = `移房 ${chain.trim()}`;
  const out = (note ?? '').split('\n').filter((l) => l.trim() !== line).join('\n').trim();
  return out || null;
}

/**
 * 「不是移房，清掉紀錄」能不能按。
 * ★ 拆成好幾段的（有 move_group）不行 —— 那是真的分兩間住，清標籤會讓另一段變成孤兒。
 */
export function canClearMove(o: MoveRec): boolean {
  return !!(o.move_chain ?? '').trim() && !o.move_group;
}

/** 清掉移房紀錄要寫回的兩欄 */
export function clearMovePatch(o: MoveRec): { move_chain: null; note: string | null } | null {
  if (!canClearMove(o)) return null;
  return { move_chain: null, note: stripMoveLine(o.note, o.move_chain as string) };
}

/**
 * 「編輯」把房源改回移房前那一間（鏈的第一個）＝移錯了、搬回去 → 紀錄一起清掉。
 * 不清的話會留著「A13>B03」而人其實住 A13，標籤在說謊。
 */
export function moveRevertPatch(o: MoveRec & { property_raw?: string | null }) {
  if (!canClearMove(o)) return null;
  const first = (o.move_chain as string).split('>')[0]?.trim();
  if (!first || (o.property_raw ?? '').trim() !== first) return null;
  return clearMovePatch(o);
}
