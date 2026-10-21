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
  /** 'cancel' ＝ 取消通知信、'modify' ＝ 修改通知信（2026-10-21）；沒帶＝訂房通知 */
  event?: string | null;
  /** 修改通知信的「原始訂單」那一段（用來確認系統裡的金額是不是同一套算法） */
  old_checkin?: string | null;
  old_checkout?: string | null;
  old_amount?: string | number | null;
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

/*
 * ══════════ 取消通知信（2026-10-21 David：「抓取消訂單，送到安幸上工」）══════════
 * 跟爬蟲作廢取消單同一招（airbnb-reconcile）：來源改 airbnb_cancelled、金額歸 0。
 *   · 系統裡沒有這張 → 不建（取消的單本來就不該出現），回 not_found
 *   · 已經作廢過 → 不動
 *   · ★ 已經標「已收款」→ 不自動歸零，回 attention 讓人看（錢真的進來過，抹掉會沒痕跡）
 *   · Airbnb 有收取消費的話，之後爬蟲同步會把金額補回來
 */
export type CancelExist = { id: string; source: string | null; paid: boolean | null; checkin: string | null; checkout: string | null; note: string | null } | null;
export type CancelDecision =
  | { kind: 'not_found' }
  | { kind: 'skip'; reason: string }
  | { kind: 'attention'; reason: string }
  | { kind: 'void'; patch: { source: string; amount: number; fee_type: null; note: string }; warnings: string[] };

export function otaCancelDecision(
  exist: CancelExist, b: { checkin?: string | null; checkout?: string | null; email_id?: string | null }, today: string,
): CancelDecision {
  if (!exist) return { kind: 'not_found' };
  if (exist.source === 'airbnb_cancelled') return { kind: 'skip', reason: '已經是取消單了' };
  if (exist.source !== 'airbnb') return { kind: 'attention', reason: `這張單的來源是「${exist.source ?? ''}」不是 Airbnb —— 沒有自動作廢，請人看一下` };
  if (exist.paid) return { kind: 'attention', reason: '這張單已經標「已收款」—— 沒有自動歸零，請人確認要不要退或作廢' };
  const warnings: string[] = [];
  const ci = otaDate(b.checkin), co = otaDate(b.checkout);
  if (ci && exist.checkin && ci !== exist.checkin) warnings.push(`信上入住 ${ci}，系統是 ${exist.checkin}`);
  if (co && exist.checkout && co !== exist.checkout) warnings.push(`信上退房 ${co}，系統是 ${exist.checkout}`);
  const mail = (b.email_id ?? '').trim();
  return { kind: 'void', warnings, patch: {
    source: 'airbnb_cancelled', amount: 0, fee_type: null,
    note: [`Airbnb 已取消,無收入（取消通知信 ${today}${mail ? `・Gmail ${mail}` : ''}）`, (exist.note ?? '').trim()].filter(Boolean).join('\n'),
  } };
}

/*
 * ══════════ 修改通知信（2026-10-21 David：「Airbnb 訂單修改通知，縮短」）══════════
 *   · 系統裡沒有這張 → 照新的資料建一張（訂房信可能漏掉了）—— route 那邊走一般建單
 *   · 已取消、不是 Airbnb、移過房的 → attention，不自動改（移過房的拆成好幾段，自動改會對不上）
 *   · 日期照「修改後」改，晚數重算
 *   · ★ 金額：系統裡的金額 ＝ 信上「原始訂單款項」（或還是 0）才換成新的 ——
 *     不相等代表爬蟲已經寫過實收（算法不同），那就不動金額、提醒等爬蟲同步
 */
export type ModifyExist = {
  id: string; source: string | null; amount: number | null; checkin: string | null; checkout: string | null;
  note: string | null; move_chain: string | null;
} | null;
export type ModifyDecision =
  | { kind: 'not_found' }
  | { kind: 'bad'; error: string }
  | { kind: 'skip'; reason: string }
  | { kind: 'attention'; reason: string }
  | { kind: 'update'; patch: Record<string, unknown>; changes: string[]; warnings: string[] };

const money = (v: string | number | null | undefined) => Number(String(v ?? '').replace(/[^0-9.-]/g, '')) || 0;

export function otaModifyDecision(exist: ModifyExist, b: OtaEmailBody, today: string): ModifyDecision {
  const ci = otaDate(b.checkin), co = otaDate(b.checkout);
  if (!ci) return { kind: 'bad', error: `修改後的入住「${b.checkin ?? ''}」不是日期` };
  if (!co) return { kind: 'bad', error: `修改後的退房「${b.checkout ?? ''}」不是日期` };
  const nights = nightsOf(ci, co);
  if (nights <= 0) return { kind: 'bad', error: `修改後退房 ${co} 沒有晚於入住 ${ci}` };
  if (!exist) return { kind: 'not_found' };
  if (exist.source === 'airbnb_cancelled') return { kind: 'attention', reason: '系統裡這張已經是取消單 —— 沒有自動改，請人看一下' };
  if (exist.source !== 'airbnb') return { kind: 'attention', reason: `來源是「${exist.source ?? ''}」不是 Airbnb —— 沒有自動改` };
  if (exist.move_chain) return { kind: 'attention', reason: `這張移過房（${exist.move_chain.split('>').join('→')}）—— 拆成好幾段，沒有自動改日期，請人手動改` };

  const patch: Record<string, unknown> = {};
  const changes: string[] = [], warnings: string[] = [];
  if (ci !== exist.checkin || co !== exist.checkout) {
    patch.checkin = ci; patch.checkout = co; patch.nights = nights;
    changes.push(`${exist.checkin ?? '?'}～${exist.checkout ?? '?'} → ${ci}～${co}（${nights} 晚）`);
  }
  const newAmt = money(b.amount), oldAmt = money(b.old_amount), cur = Math.round(Number(exist.amount) || 0);
  if (newAmt > 0 && newAmt !== cur) {
    if (cur === 0 || (oldAmt > 0 && cur === Math.round(oldAmt))) {
      patch.amount = newAmt;
      changes.push(`金額 ${cur.toLocaleString()} → ${newAmt.toLocaleString()}`);
    } else {
      warnings.push(`金額沒改：系統是 ${cur.toLocaleString()}（爬蟲同步的實收），信上原始 ${oldAmt.toLocaleString()} → 修改後 ${newAmt.toLocaleString()}，等爬蟲同步`);
    }
  }
  if (!changes.length) return { kind: 'skip', reason: warnings[0] ?? '日期、金額都跟系統一樣，沒有要改的' };
  const mail = (b.email_id ?? '').trim();
  patch.note = [`Airbnb 修改通知 ${today}：${changes.join('・')}${mail ? `（Gmail ${mail}）` : ''}`, (exist.note ?? '').trim()].filter(Boolean).join('\n');
  return { kind: 'update', patch, changes, warnings };
}
