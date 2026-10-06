/**
 * 移房找空房（2026-10-06 David：「要整段都空著的才能移」「以實際住的晚數，不算退房日」）。
 *
 * 一筆「佔用」＝ 某間房的一段**晚**：first ＝ 第一晚、last ＝ 最後一晚（含）。
 *   訂單：first ＝ checkin，last ＝ checkout 前一天（退房日當天可以接新客）
 *   契約：first ＝ start_date，last ＝ end_date（契約的迄就是最後一晚）
 * 一段要住 [from, to) ＝ 第一晚 from、最後一晚 to 前一天。
 * 兩段有任何一晚重疊 ＝ 佔用.first ≤ 要住的最後一晚 且 佔用.last ≥ from。
 *
 * ★ 自己這筆（整組移房分段）不算佔用 —— 不然原房永遠不空。呼叫端撈資料時先排掉。
 * ★ 已取消的訂單不算佔用 —— 呼叫端撈資料時先排掉（cancelled_on is null）。
 */

export type Busy = { propertyId: string | null; estateId: string | null; room: string; first: string; last: string };
export type RoomRef = { id: string; name: string; estate_id: string | null };

const pad = (n: number) => String(n).padStart(2, '0');
/** YYYY-MM-DD 的前一天（不受時區影響） */
export function dayBefore(d: string): string {
  const [y, m, dd] = d.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, dd) - 86400000);
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** 訂單 → 佔用（checkout 那天不算） */
export function busyOfOrder(o: { property_id?: string | null; estate_id?: string | null; property_raw?: string | null;
                                  checkin?: string | null; checkout?: string | null }): Busy | null {
  if (!o.checkin || !o.checkout || o.checkout <= o.checkin) return null;
  return { propertyId: o.property_id ?? null, estateId: o.estate_id ?? null, room: (o.property_raw ?? '').trim(),
           first: o.checkin, last: dayBefore(o.checkout) };
}
/** 契約 → 佔用（end_date 那天算） */
export function busyOfContract(c: { property_id?: string | null; estate_id?: string | null; room?: string | null;
                                     start_date?: string | null; end_date?: string | null }): Busy | null {
  if (!c.start_date || !c.end_date || c.end_date < c.start_date) return null;
  return { propertyId: c.property_id ?? null, estateId: c.estate_id ?? null, room: (c.room ?? '').trim(),
           first: c.start_date, last: c.end_date };
}

/** 這一筆佔用是不是這間房的（有 property_id 比 id；沒有就比 物業＋房號） */
export function busyIsRoom(b: Busy, r: RoomRef): boolean {
  if (b.propertyId) return b.propertyId === r.id;
  return b.room === r.name && (!b.estateId || !r.estate_id || b.estateId === r.estate_id);
}

/** 這間房在 [from, to) 每一晚都空嗎 */
export function roomFree(busy: readonly Busy[], r: RoomRef, from: string, to: string): boolean {
  if (!from || !to || to <= from) return false;
  const lastNight = dayBefore(to);
  return !busy.some((b) => busyIsRoom(b, r) && b.first <= lastNight && b.last >= from);
}

/** [from, to) 整段都空的房，依房號排 */
export function freeRooms<T extends RoomRef>(busy: readonly Busy[], rooms: readonly T[], from: string, to: string): T[] {
  return rooms.filter((r) => roomFree(busy, r, from, to));
}

/** 顯示用：「10/08 ～ 10/14」—— 第一晚到最後一晚（退房日不算）*/
export function nightsLabel(from: string, to: string): string {
  if (!from || !to || to <= from) return '—';
  const md = (d: string) => `${d.slice(5, 7)}/${d.slice(8, 10)}`;
  return `${md(from)} ～ ${md(dayBefore(to))}`;
}
