/**
 * 房源 → Airbnb 房源頁網址（2026-10-12 David：「每個房源若有 airbnb 可以直接連結過去」）。
 *
 * 一間房的 listing 編號有兩個地方：
 *   `properties.airbnb_listing_id`　主要那一個
 *   `property_listings`（migration_127）一間房掛好幾個 listing 時，多的放這裡；`is_current` 是現在在用的
 *
 * ★ 主要的優先；沒有才用 property_listings 裡 `is_current` 的，再沒有就用任一個。
 * ★ 沒有就回 null —— 畫面整顆不出現，不連到一個猜的網址。
 */
export type ListingRow = { listing_id: string | number | null; property_id: string | null; is_current?: boolean | null };

const ok = (v: unknown): string | null => {
  const s = String(v ?? '').trim();
  return /^\d{3,}$/.test(s) ? s : null;
};

export function airbnbUrl(listingId: string | number | null | undefined): string | null {
  const id = ok(listingId);
  return id ? `https://www.airbnb.com/rooms/${id}` : null;
}

/** property_id → 網址 */
export function airbnbLinks(
  props: readonly { id: string; airbnb_listing_id?: string | number | null }[],
  listings: readonly ListingRow[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of props) { const u = airbnbUrl(p.airbnb_listing_id); if (u) out[p.id] = u; }
  const sorted = [...listings].sort((a, b) => Number(!!b.is_current) - Number(!!a.is_current));
  for (const l of sorted) {
    if (!l.property_id || out[l.property_id]) continue;
    const u = airbnbUrl(l.listing_id); if (u) out[l.property_id] = u;
  }
  return out;
}
