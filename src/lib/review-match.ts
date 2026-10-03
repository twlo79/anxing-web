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

/**
 * 一個名字可以拿來比對的幾種寫法：全名、第一段（名）。
 *
 * ★ 2026-10-03：訂單補了 Airbnb 全名（「Kevin Chen」）之後，評價那邊還是只有名（「Kevin」）——
 *   兩邊全名比對永遠不相等，於是新評價全部落進「未對應」。
 *   兩邊都拆出「第一段」再比；同名撞到兩間的話照樣不猜（matchStay 裡的 look()）。
 */
export function nameKeys(s: string | null | undefined): string[] {
  const full = norm(s).replace(/\s+/g, ' ');
  if (!full) return [];
  const first = full.split(' ')[0];
  return first && first !== full ? [full, first] : [full];
}

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
    for (const g of nameKeys(o.guest_name)) {
      if (o.checkout) (byOut[`${g}|${o.checkout}`] ||= new Set()).add(o.property_id);
      if (o.checkin) (byIn[`${g}|${o.checkin}`] ||= new Set()).add(o.property_id);
    }
  }
  return { byOut, byIn };
}

/** 回房源 id；對不到或不唯一 → null。`how` 說是哪一關對到的（給統計用） */
export function matchStay(
  idx: ReturnType<typeof buildStayIndex>,
  guest: string | null | undefined, checkin: string | null, checkout: string | null,
): { propertyId: string | null; how: 'checkout' | 'checkin' | 'checkout±1' | null } {
  const keys = nameKeys(guest);
  if (!keys.length) return { propertyId: null, how: null };
  /** 同一關裡，全名與「名」各查一次；兩個都對到但不同間 → 不猜 */
  const look = (tbl: Record<string, Set<string>>, d: string) => {
    // 先用全名：全名就分得出來的（Amy Lin vs Amy Wang）不要被「名」拖下水
    const exact = tbl[`${keys[0]}|${d}`];
    if (exact && exact.size === 1) return Array.from(exact)[0];
    const c = new Set<string>();
    for (const g of keys) { const s = tbl[`${g}|${d}`]; if (s) s.forEach((x) => c.add(x)); }
    return c.size === 1 ? Array.from(c)[0] : null;
  };
  if (checkout) {
    const p = look(idx.byOut, checkout);
    if (p) return { propertyId: p, how: 'checkout' };
  }
  if (checkin) {
    const p = look(idx.byIn, checkin);
    if (p) return { propertyId: p, how: 'checkin' };
  }
  if (checkout) {
    // 差一天：兩邊各看一次，兩邊都對到但不同間 → 不猜
    const cands = new Set<string>();
    for (const d of [shiftDay(checkout, -1), shiftDay(checkout, 1)]) {
      const p = look(idx.byOut, d);
      if (p) cands.add(p);
    }
    if (cands.size === 1) return { propertyId: Array.from(cands)[0], how: 'checkout±1' };
  }
  return { propertyId: null, how: null };
}
