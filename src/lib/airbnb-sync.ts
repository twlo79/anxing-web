/**
 * Airbnb 同步：每一筆抓回來的訂單，決定要對 ERP 做什麼。
 *
 * ============================================================
 * 【識別碼是 Airbnb 的確認碼，不是姓名＋期間】
 *
 * 一度考慮用「姓名＋住宿期間＋listing」比對。那會壞掉，而且壞得很貴：
 * 那三個欄位都會變，識別碼一變就會產生**重複訂單**。
 *
 * 2026-07 的真實例子：
 *   Michael      2026-06-29~07-09  $41,316  JPR2F
 *   Michael Hu   2026-06-29~07-09  $41,316  JPR2F
 * 同一筆，因為名字差兩個字變成兩列，當月營收多算 33,053。
 *
 * 確認碼是 Airbnb 給的，延住、改名、換房都不會變。所以它才是鑰匙。
 *
 *
 * ============================================================
 * 【欄位分三級】（使用者決定）
 *
 *   A 一律更新：金額、來源／取消狀態、住宿起訖
 *       Airbnb 是這些的唯一真相。不跟著改的話，
 *       營收會攤提在錯的月份，取消的單會繼續被算進營收。
 *
 *   B 只在空的時候填：房源、房客姓名
 *       我們會手動修正這兩個。爬蟲不該贏 ——
 *       但**被擋下來時一定要講出來**，否則對照表永遠是錯的，
 *       新訂單會一直掛到錯的房源，而且沒有人會發現。
 *
 *   C 完全不碰：收款、押金、帳號、備註、發票、移房
 *
 *
 * ============================================================
 * 【為什麼「不覆蓋」還要回報】
 *
 * 只是不覆蓋的話，你今天的修正保住了，但明天的新訂單還是會掛錯 ——
 * 問題從「被改回去」變成「新的一直掛錯」，而後者更難發現。
 * 所以差異要列出來，那份清單就是「對照表該怎麼搬」的作業。
 */

/** 爬蟲送進來的一筆 */
export type Incoming = {
  /** Airbnb 確認碼。唯一識別，永遠不變。 */
  code: string;
  listingId: string | null;
  guest: string | null;
  start: string | null;
  end: string | null;
  nights: number | null;
  statusKey: string | null;
  earnings: number | string | null;
  /** 搭檔收款。earnings 為 0 時整筆可能走這裡。 */
  cohost: number | string | null;
};

/** ERP 裡既有的那一筆（只取決策需要的欄位） */
export type Existing = {
  order_key: string;
  source: string | null;
  property_id: string | null;
  property_raw: string | null;
  guest_name: string | null;
  checkin: string | null;
  checkout: string | null;
  amount: number | null;
  paid: boolean | null;
};

/** listing_id 對到的房源 */
export type PropRef = { id: string; name: string; estate_id: string | null };

export type Decision =
  | { kind: 'insert'; row: Record<string, unknown> }
  | { kind: 'update'; code: string; patch: Record<string, unknown> }
  | { kind: 'void'; code: string }
  /** 取消且無收入，但已收過款 —— 不能自動歸零，交人工 */
  | { kind: 'attention'; code: string; reason: string }
  | { kind: 'skip'; code: string; reason: string }
  | { kind: 'unmatched'; code: string; listingId: string };

export type Diff = {
  code: string;
  field: '房源' | '房客姓名' | '住宿起訖';
  from: string;
  to: string;
  /** 房源不一致時附上 listing_id —— 那是修對照表要用的 */
  listingId?: string;
};

const num = (v: unknown) => {
  if (typeof v === 'number') return v;
  const n = parseFloat(String(v ?? '').replace(/[^0-9.-]/g, ''));
  return isNaN(n) ? 0 : n;
};

const txt = (v: unknown) => (v == null ? '' : String(v).trim());

/**
 * 收入怎麼算：以 earnings 為主，為 0 時看搭檔收款
 * （整筆被 co-host 拆走的情況）。
 */
export function revenueOf(m: Incoming): { revenue: number; viaCohost: boolean } {
  const earn = num(m.earnings);
  const cohost = Math.abs(num(m.cohost));
  return earn > 0
    ? { revenue: earn, viaCohost: false }
    : { revenue: cohost, viaCohost: cohost > 0 };
}

export const isCancelled = (m: Incoming) => /cancel/i.test(txt(m.statusKey));

/**
 * 決定這一筆要做什麼。
 *
 * @param exist 既有訂單；沒有就是 null（新增）
 * @param prop  listing_id 對到的房源；對不到就是 null
 */
export function decide(
  m: Incoming, exist: Existing | null, prop: PropRef | null,
): { decision: Decision; diffs: Diff[] } {
  const diffs: Diff[] = [];
  const { revenue, viaCohost } = revenueOf(m);
  const cancelled = isCancelled(m);

  // ── 取消 ────────────────────────────────────────
  if (cancelled && revenue <= 0) {
    if (!exist) return { decision: { kind: 'skip', code: m.code, reason: '取消且無收入' }, diffs };
    if (exist.source === 'airbnb_cancelled') {
      return { decision: { kind: 'skip', code: m.code, reason: '已作廢過' }, diffs };
    }
    /*
     * 已收款的取消單不自動歸零 —— 錢真的進來過，
     * 自動抹掉會讓營收憑空少一筆，而且沒有痕跡。
     */
    if (exist.paid) {
      return {
        decision: { kind: 'attention', code: m.code, reason: '已收款但 Airbnb 顯示取消' },
        diffs,
      };
    }
    return { decision: { kind: 'void', code: m.code }, diffs };
  }

  // 未取消且完全沒有收入 —— 還沒結算，先不進 ERP
  if (!cancelled && revenue <= 0) {
    return { decision: { kind: 'skip', code: m.code, reason: '尚無收入' }, diffs };
  }

  const source = cancelled ? 'oneoff' : 'airbnb';
  const fee_type = cancelled ? '取消費' : null;
  const note = cancelled
    ? (viaCohost ? 'Airbnb 取消收入(搭檔收款)' : 'Airbnb 取消收入')
    : (viaCohost ? '搭檔收款(Co-host payout)' : null);

  // ── 新增 ────────────────────────────────────────
  if (!exist) {
    // 對不到房源的新訂單只能跳過 —— 硬塞一筆沒有房源的訂單，
    // 它會在報表上變成一個沒有歸屬的數字，比不進來更難查
    if (!prop) {
      return {
        decision: { kind: 'unmatched', code: m.code, listingId: txt(m.listingId) },
        diffs,
      };
    }
    return {
      decision: {
        kind: 'insert',
        row: {
          order_key: m.code, source,
          estate_id: prop.estate_id, property_id: prop.id, property_raw: prop.name,
          guest_name: txt(m.guest) || '(unknown)',
          checkin: m.start, checkout: m.end, nights: m.nights ?? null,
          amount: revenue, fee_type, note, imported_via: 'auto',
        },
      },
      diffs,
    };
  }

  // ── 更新既有 ────────────────────────────────────
  const patch: Record<string, unknown> = {};

  // A 級：金額與來源一律更新
  if (num(exist.amount) !== revenue) patch.amount = revenue;
  if (exist.source !== source) patch.source = source;
  patch.fee_type = fee_type;

  // A 級：住宿起訖也一律更新，但改了要講出來
  if (m.start && txt(exist.checkin) !== txt(m.start)) {
    diffs.push({ code: m.code, field: '住宿起訖',
      from: `${txt(exist.checkin)}~${txt(exist.checkout)}`,
      to: `${txt(m.start)}~${txt(m.end)}` });
    patch.checkin = m.start;
  }
  if (m.end && txt(exist.checkout) !== txt(m.end)) {
    if (!patch.checkin) {
      diffs.push({ code: m.code, field: '住宿起訖',
        from: `${txt(exist.checkin)}~${txt(exist.checkout)}`,
        to: `${txt(m.start)}~${txt(m.end)}` });
    }
    patch.checkout = m.end;
  }
  if (patch.checkin || patch.checkout) patch.nights = m.nights ?? null;

  /*
   * B 級：房源。**有值就不覆蓋**，但不一致要列出來。
   *
   * 這裡的不一致幾乎都是「listing 在 ERP 對到的房源已經過時」——
   * 例如對照表還指著停用的「舊-A15」。那份清單就是搬對照表的依據。
   */
  if (prop) {
    if (!exist.property_id) {
      patch.estate_id = prop.estate_id;
      patch.property_id = prop.id;
      patch.property_raw = prop.name;
    } else if (exist.property_id !== prop.id) {
      diffs.push({
        code: m.code, field: '房源',
        from: txt(exist.property_raw) || exist.property_id,
        to: prop.name,
        listingId: txt(m.listingId),
      });
    }
  }

  // B 級：房客姓名。空的（或當初填了 (unknown)）才補
  const curGuest = txt(exist.guest_name);
  const newGuest = txt(m.guest);
  if (newGuest) {
    if (!curGuest || curGuest === '(unknown)') {
      patch.guest_name = newGuest;
    } else if (curGuest !== newGuest) {
      diffs.push({ code: m.code, field: '房客姓名', from: curGuest, to: newGuest });
    }
  }

  // 只有 fee_type 一個欄位代表其實沒有實質變化
  const meaningful = Object.keys(patch).filter((k) => k !== 'fee_type');
  if (!meaningful.length && exist.source === source) {
    return { decision: { kind: 'skip', code: m.code, reason: '沒有變化' }, diffs };
  }

  return { decision: { kind: 'update', code: m.code, patch }, diffs };
}

export type Summary = {
  inserted: number; updated: number; voided: number;
  skipped: number; unmatched: Record<string, number>;
  attention: { code: string; reason: string }[];
  diffs: Diff[];
};

/** 把一批決策整理成統計 —— 給回傳用 */
export function summarize(results: { decision: Decision; diffs: Diff[] }[]): Summary {
  const s: Summary = {
    inserted: 0, updated: 0, voided: 0, skipped: 0,
    unmatched: {}, attention: [], diffs: [],
  };
  for (const { decision, diffs } of results) {
    s.diffs.push(...diffs);
    switch (decision.kind) {
      case 'insert': s.inserted++; break;
      case 'update': s.updated++; break;
      case 'void': s.voided++; break;
      case 'skip': s.skipped++; break;
      case 'attention': s.attention.push({ code: decision.code, reason: decision.reason }); break;
      case 'unmatched':
        s.unmatched[decision.listingId] = (s.unmatched[decision.listingId] ?? 0) + 1;
        break;
    }
  }
  return s;
}
