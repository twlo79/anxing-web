/**
 * OTA 訂房通知信 → 訂單（2026-10-06 David：「看信，然後導入訂單」）。
 *
 * Make.com 流程：Gmail 看信 → Text parser 抓欄位 → Set variables → HTTP 打 /api/import/ota-email。
 * 這支只做**純邏輯**（驗證、正規化、組訂單），route 只負責讀寫資料庫 —— 判斷式放這裡才測得到。
 *
 * ★★ 只新增、不覆蓋：order_key 已經存在（爬蟲先同步到了、或同一封信跑兩次）就回 exists，一個欄位都不動。
 *    金額、房客名稱之後由 Airbnb 爬蟲（airbnb-sync）補上 —— 它認的是同一個 order_key（訂房編號）。
 */

export type OtaEmailBody = {
  source?: string | null;    // 'Airbnb' / 'Agoda' / 'Booking'（主旨第一個字）
  ota_no?: string | null;    // 訂房編號，例如 HMABCD1234
  checkin?: string | null;   // 2026-10-11 或 2026/10/11
  checkout?: string | null;
  property?: string | null;  // 物業名稱，例如 時兆
  unit?: string | null;      // 房號，例如 A15
  guest?: string | null;     // 有抓到就帶
  amount?: string | number | null;
  email_id?: string | null;  // Gmail 的信件 id，寫在備註裡好回查
};

/** 來源 → orders.source。認不得的回 null（不要猜成私下）*/
export function otaSource(s: string | null | undefined): 'airbnb' | 'agoda' | null {
  const t = (s ?? '').trim().toLowerCase();
  if (t.startsWith('airbnb')) return 'airbnb';
  if (t.startsWith('agoda')) return 'agoda';
  return null;
}

/** 日期正規化成 YYYY-MM-DD；格式不對回 null */
export function otaDate(s: string | null | undefined): string | null {
  const m = /^\s*(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})\s*日?\s*$/.exec(s ?? '');
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export const nightsOf = (ci: string, co: string) =>
  Math.round((new Date(co).getTime() - new Date(ci).getTime()) / 86400000);

/** 房號正規化 —— 跟 /api/import/orders 的 normUnit 同一套 */
export function normUnit(s: string | null | undefined): string {
  return (s || '').toUpperCase()
    .replace(/開封|時兆|正隆|亞曼尼|台視|JPR|RMJ|NEW|舊|整層|（[^）]*）|\([^)]*\)|房|樓|層|棟|\s/g, '')
    .replace(/A0*(\d)/g, 'A$1').replace(/B0*(\d)/g, 'B$1');
}

export type OtaParsed = {
  order_key: string; source: 'airbnb' | 'agoda'; checkin: string; checkout: string; nights: number;
  estate_name: string | null; property_raw: string | null; guest_name: string | null; amount: number; email_id: string | null;
};

/** 驗證＋正規化。錯了回一句話（Make 會把它顯示在模組上）*/
export function parseOtaEmail(b: OtaEmailBody): { ok: true; v: OtaParsed } | { ok: false; error: string } {
  const key = (b.ota_no ?? '').trim();
  if (!key) return { ok: false, error: 'ota_no（訂房編號）是空的 —— Text parser 沒抓到' };
  const source = otaSource(b.source);
  if (!source) return { ok: false, error: `source「${b.source ?? ''}」認不得 —— 只收 Airbnb／Agoda` };
  const checkin = otaDate(b.checkin), checkout = otaDate(b.checkout);
  if (!checkin) return { ok: false, error: `checkin「${b.checkin ?? ''}」不是日期` };
  if (!checkout) return { ok: false, error: `checkout「${b.checkout ?? ''}」不是日期` };
  const nights = nightsOf(checkin, checkout);
  if (nights <= 0) return { ok: false, error: `退房 ${checkout} 沒有晚於入住 ${checkin}` };
  const amt = Number(String(b.amount ?? '0').replace(/[^0-9.-]/g, '')) || 0;
  return { ok: true, v: {
    order_key: key, source, checkin, checkout, nights,
    estate_name: (b.property ?? '').trim() || null,
    property_raw: (b.unit ?? '').trim() || null,
    guest_name: (b.guest ?? '').trim() || null,
    amount: Math.max(0, amt),
    email_id: (b.email_id ?? '').trim() || null,
  } };
}

/** 從物業清單對出 estate_id：名稱相等，或信上的名稱包含物業名（「時兆大樓」→ 時兆）*/
export function matchEstate<T extends { id: string; name: string }>(estates: readonly T[], name: string | null): T | null {
  if (!name) return null;
  return estates.find((e) => e.name === name) ?? estates.find((e) => name.includes(e.name) || e.name.includes(name)) ?? null;
}

/** 從房源清單對出 property：同物業、房號正規化相等；對不到回 null（房源留空，人再補）*/
export function matchProperty<T extends { id: string; name: string; estate_id: string | null }>(
  props: readonly T[], estateId: string | null, unit: string | null): T | null {
  const u = normUnit(unit);
  if (!u) return null;
  const pool = estateId ? props.filter((p) => p.estate_id === estateId) : props;
  return pool.find((p) => normUnit(p.name) === u) ?? null;
}

/** 要寫進 orders 的那一列 */
export function otaOrderRow(v: OtaParsed, estateId: string | null, propertyId: string | null) {
  return {
    order_key: v.order_key, source: v.source, estate_id: estateId, property_id: propertyId,
    property_raw: v.property_raw, guest_name: v.guest_name,
    checkin: v.checkin, checkout: v.checkout, nights: v.nights,
    amount: v.amount, deposit: 0, paid: false, imported_via: 'email',
    note: `來自 ${v.source === 'airbnb' ? 'Airbnb' : 'Agoda'} 訂房通知信${v.email_id ? `（Gmail ${v.email_id}）` : ''}` +
          (v.amount ? '' : '・金額等爬蟲同步'),
  };
}
