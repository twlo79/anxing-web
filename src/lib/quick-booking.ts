/**
 * 房源狀態頁「＋ 加訂單」（2026-10-13 David 過審）：私下訂單或契約，一張表單。
 *
 *   1 私下訂單／契約　2 姓名　3 起訖 *　4 物業 *　5 房源 *　6 價格　7 備註
 *
 * ★★ 寫進資料庫的欄位**跟訂單頁、契約頁的「新增」一樣** —— 這裡只是另一個入口，
 *   之後在那兩頁打開這一筆，看到的跟從那兩頁建的沒有兩樣。
 *   沒在這張表單上的（押金、訂金、發票、付款日、加費）一律用那兩頁新增時的預設值。
 *
 * ★ 兩種「迄」不一樣（跟房源狀態同一條規則）：
 *     私下訂單　退房日 —— 最後一晚是前一天，退房日當天可以接新客
 *     契約　　　最後一天 —— 含當日
 */
import { roomFree, type Busy } from './room-free.ts';
import { contractPurpose } from './purpose.ts';
import { monthlyRentToSave } from './earnest.ts';
import { DEFAULT_BOOK } from './book.ts';

export type BookingKind = 'private' | 'contract';

export type BookingDraft = {
  kind: BookingKind;
  name: string;
  from: string;
  to: string;
  estateId: string | null;
  propertyId: string | null;
  room: string;
  /** 私下訂單＝整筆；契約＝月租金。null ＝ 沒填 */
  price: number | null;
  note: string;
};

const DAY = 86400000;
const pad = (n: number) => String(n).padStart(2, '0');
const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(new Date(s + 'T00:00:00Z').getTime());
export function addDays(d: string, n: number): string {
  const t = new Date(new Date(d + 'T00:00:00Z').getTime() + n * DAY);
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}
export const daysBetween = (a: string, b: string) =>
  Math.round((new Date(b + 'T00:00:00Z').getTime() - new Date(a + 'T00:00:00Z').getTime()) / DAY);

/**
 * 這筆佔的是哪幾晚，寫成 [from, to)（room-free 的格式）。
 * 私下訂單 to 是退房日；契約 to 是最後一天 → 要多算一天。
 */
export function occupiedRange(d: Pick<BookingDraft, 'kind' | 'from' | 'to'>): { from: string; to: string } | null {
  if (!isDate(d.from) || !isDate(d.to)) return null;
  const to = d.kind === 'contract' ? addDays(d.to, 1) : d.to;
  return to > d.from ? { from: d.from, to } : null;
}

/** 晚數（私下）／天數（契約） */
export function lengthOf(d: Pick<BookingDraft, 'kind' | 'from' | 'to'>): number {
  const r = occupiedRange(d);
  return r ? daysBetween(r.from, r.to) : 0;
}

/** 畫面上那一句：「住 3 晚…」／「約 6 個月…」 */
export function lengthText(d: Pick<BookingDraft, 'kind' | 'from' | 'to'>): string {
  const n = lengthOf(d);
  if (!n) return '';
  if (d.kind === 'private') return `住 ${n} 晚（最後一晚 ${addDays(d.to, -1).slice(5).replace('-', '/')}，退房日當天可接新客）`;
  const mo = Math.max(1, Math.round(n / 30.44));
  return `約 ${mo} 個月・${n} 天（契約的迄就是最後一天，含當日）`;
}

/** 這間房在這段是不是空的（busy 還沒載好就先當空的，送出前會再擋一次） */
export function draftFree(busy: readonly Busy[] | null, d: BookingDraft): boolean {
  const r = occupiedRange(d);
  if (!busy || !r || !d.room) return true;
  return roomFree(busy, { id: d.propertyId ?? '', name: d.room, estate_id: d.estateId }, r.from, r.to);
}

/**
 * 擋下來的原因；可以送就回 null。
 * ★ 一次只講一件事，照畫面由上往下的順序 —— 人照著改就好。
 */
export function draftError(d: BookingDraft, busy: readonly Busy[] | null): string | null {
  const word = d.kind === 'private' ? '住宿' : '租期';
  if (!d.from || !d.to) return `填${word}起訖`;
  if (!isDate(d.from) || !isDate(d.to)) return `${word}起訖不是有效的日期`;
  if (!occupiedRange(d)) return d.kind === 'private' ? '退房日要在入住日之後' : '最後一天不能早於起租日';
  if (!d.estateId) return '選物業';
  if (!d.room) return '選房源';
  if (d.price != null && (!Number.isFinite(d.price) || d.price < 0)) return '價格不能是負的';
  if (d.kind === 'contract' && !(Number(d.price) > 0)) return '契約要填月租金';
  if (!draftFree(busy, d)) return `${d.room} 這段有人住 —— 換一間，或先移房`;
  return null;
}

const clean = (s: string) => s.trim() || null;

/** orders.insert 的內容（跟訂單頁新增私下訂單同一組欄位與預設值） */
export function orderInsert(d: BookingDraft, now = Date.now()) {
  const nights = lengthOf(d);
  const amount = Math.round(Number(d.price) || 0);
  return {
    source: 'private',
    order_key: `PV_${d.from}_${d.room}_${d.name.trim()}_${now}`,
    imported_via: 'manual',
    purpose_type: 'estate',
    estate_id: d.estateId, property_id: d.propertyId, property_raw: d.room,
    guest_name: clean(d.name),
    checkin: d.from, checkout: d.to, nights,
    amount, deposit: 0, account: null, note: clean(d.note),
    fee_type: null, item_name: null,
    fx_revenue: [], fx_deposit: [],
    pet_deposit: null, earnest_amount: 0, earnest_only: false,
    book: DEFAULT_BOOK, account_code: null,
    invoice_required: false, invoice_title: null, invoice_tax_id: null,
  };
}

/** contracts.insert 的內容（跟契約頁新增同一組欄位；月繳、長租） */
export function contractInsert(d: BookingDraft) {
  const per = Math.round(Number(d.price) || 0);
  const type = 'longterm';
  return {
    estate_id: d.estateId, property_id: d.propertyId, room: d.room,
    tenant_name: clean(d.name), phone: null,
    cadence: 'monthly', type,
    amount_per_period: per > 0 ? per : null,
    monthly_rent: monthlyRentToSave(per, 1),
    earnest_only: false, earnest_amount: 0,
    deposit: 0, fx_deposit: [],
    start_date: d.from, end_date: d.to,
    first_payment_date: null, pay_day: null,
    account: null, note: clean(d.note), active: true, display_name: null,
    name: `${d.name.trim()}-${d.room}`,
    tax_free: false, invoice_required: false, invoice_day: null, invoice_every: 'month',
    invoice_title: null, invoice_tax_id: null, invoice_note: null,
    concessions: [], rent_lines: [],
    purpose_type: contractPurpose({ type, purpose_type: null }),
  };
}
