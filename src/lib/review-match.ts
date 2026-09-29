/**
 * 評價 → 房源：用訂單反查（匯入評價的第二層備援，第一層是 listing_id 對照表）。
 *
 * 舊做法只比「房客＋退房日」完全相同。2026-09-29 踩到：Airbnb 評價寫 9/24～9/29，
 * 訂單是 9/24～9/28（提前退房一天），退房日差一天就對不到，落進「未對應」。
 *
 * 現在三關，前一關對到就停；每一關都**只採計唯一解**，同名房客同一天住兩間就跳過不猜：
 *   ① 房客＋退房日 完全相同
 *   ② 房客＋入住日 完全相同
 *   ③ 房客＋退房日 差一天以內
 */
export type OrderStay = { guest_name: string | null; checkin: string | null; checkout: string | null; property_id: string | null };

const norm = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();

function shiftDay(d: string, n: number): string {
  const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

/** 先把訂單整理成三張索引，之後每則評價 O(1) 查 */
export function buildStayIndex(orders: OrderStay[]) {
  const byOut: Record<string, Set<string>> = {};
  const byIn: Record<string, Set<string>> = {};
  for (const o of orders) {
    if (!o.guest_name || !o.property_id) continue;
    const g = norm(o.guest_name);
    if (o.checkout) (byOut[`${g}|${o.checkout}`] ||= new Set()).add(o.property_id);
    if (o.checkin) (byIn[`${g}|${o.checkin}`] ||= new Set()).add(o.property_id);
  }
  return { byOut, byIn };
}

const only = (s?: Set<string>) => (s && s.size === 1 ? Array.from(s)[0] : null);

/** 回房源 id；對不到或不唯一 → null。`how` 說是哪一關對到的（給統計用） */
export function matchStay(
  idx: ReturnType<typeof buildStayIndex>,
  guest: string | null | undefined, checkin: string | null, checkout: string | null,
): { propertyId: string | null; how: 'checkout' | 'checkin' | 'checkout±1' | null } {
  const g = norm(guest);
  if (!g) return { propertyId: null, how: null };
  if (checkout) {
    const p = only(idx.byOut[`${g}|${checkout}`]);
    if (p) return { propertyId: p, how: 'checkout' };
  }
  if (checkin) {
    const p = only(idx.byIn[`${g}|${checkin}`]);
    if (p) return { propertyId: p, how: 'checkin' };
  }
  if (checkout) {
    // 差一天：兩邊各看一次，兩邊都對到但不同間 → 不猜
    const cands = new Set<string>();
    for (const d of [shiftDay(checkout, -1), shiftDay(checkout, 1)]) {
      const p = only(idx.byOut[`${g}|${d}`]);
      if (p) cands.add(p);
    }
    if (cands.size === 1) return { propertyId: Array.from(cands)[0], how: 'checkout±1' };
  }
  return { propertyId: null, how: null };
}
