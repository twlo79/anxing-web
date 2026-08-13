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
 * 【規則：人碰過的不動，但有三個例外】（2026-08-13 使用者決定）
 *
 * 只要這筆訂單有人工編輯過（data_audit 裡有一列 user_id 不是 null 的
 * update），爬蟲就不動它的**金額、房源、房客姓名** —— 只把差異列出來。
 *
 * 例外（不管有沒有被人改過，一律照做）：
 *
 *   1. 取消且無收入 → 整筆作廢、金額歸零
 *   2. 訂單狀態（取消／正常）
 *   3. 住宿起訖 —— 變短變長都更新
 *
 *
 * 【為什麼是這三個】
 *
 * 背後的原則是：**會讓營收變小的自動套用，會讓營收變大的只回報。**
 *
 * 這兩種錯的成本不對稱。少算會有人發現（錢對不上、有人來問）；
 * 多算不會 —— 一筆已取消的訂單躺在營收裡看起來完全正常，
 * 永遠沒有人會去查。所以自動化只往安全的方向動。
 *
 * 住宿起訖是唯一的補充：它兩個方向都更新，理由跟營收無關而是**行事曆**。
 * 縮住不更新的話系統以為房間還有人，可能推掉真的訂單；
 * 延住不更新的話行事曆說房間是空的，而實際上有人住 ——
 * 那會導致重複出租，比多算營收更難收拾。
 *
 *
 * 【為什麼不做成「改過的欄位才鎖」】
 *
 * data_audit 存的是欄位層級的（`{"amount": [95231.63, 158720]}`），
 * 所以技術上分得出他改的是哪一欄。但那會讓同一筆訂單
 * 「A 欄位會動、B 欄位不會」，行為變得聰明而難以預測。
 * 使用者選了固定規則 —— 記得住比精準更重要。
 *
 *
 * ============================================================
 * 【沒被碰過的訂單：多一件事】
 *
 * 金額、房源、房客姓名「空的時候會自動填」。
 * 被碰過的則連空的都不填 —— 那個空可能就是他刻意清掉的。
 *
 * 完全不碰（任何情況）：收款、押金、帳號、備註、發票、移房。
 *
 *
 * ============================================================
 * 【金額為什麼不再一律更新】（2026-08-13）
 *
 * 8/12 晚上有人把一筆訂單從 95,231.63 改成 124,346，隔天早上 06:06
 * 同步把它改回 95,231.63，中午另一個人又改成 158,720 ——
 * 兩個人都以為是自己沒存到。
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
  /**
   * 有沒有人工編輯過。
   *
   * 從 data_audit 推出來（有一列 user_id 不是 null 的 update），
   * 不是新開一個欄位 —— 那張表已經是這件事的真相，
   * 而且是**回溯的**：2026-08 之前的人工修改也算數。
   */
  manually_edited?: boolean;
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
  field: '房源' | '房客姓名' | '住宿起訖' | '金額';
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
 * 收入怎麼算：**「你賺得」＋「搭檔收款」**。
 *
 * ============================================================
 * 【為什麼要加起來】
 *
 * Airbnb 列表上的 Total Payout 是**扣掉搭檔收款之後**的淨額。
 * 以 Erin Tran（HMPTCBX2H9）為例：
 *
 *   28 晚房費          207,118.00
 *   清潔費               3,000.00
 *   月租折扣            -2,071.18
 *   平台服務費 15.5%   -32,247.26
 *   搭檔收款           -70,319.83   ← 這一筆被扣掉了
 *   ─────────────────────────────
 *   Total (TWD)        105,479.73   ← 列表上顯示的就是這個
 *
 * 搭檔收款那筆錢還是這間房產生的營收，只是分給了 co-host。
 * 用淨額當營收的話，每一筆有搭檔的訂單都會少算一大截 ——
 * 而且少算的比例每筆不同，看報表完全看不出哪裡不對。
 *
 * 這正是人工修正一直在做的事：David 手動把 95,231.63 改成 158,720，
 * 差額 63,488 就是那筆訂單當時的搭檔收款。他每改一筆，
 * 就是在手算這個加法。
 *
 *
 * ============================================================
 * 【所以爬蟲每一筆都要抓明細】
 *
 * 搭檔收款只出現在 StayHostingDetailsQuery 的明細裡，列表 API 沒有。
 * 原本只在 earnings 為 0 時才去抓明細（那是「整筆被 co-host 拆走」
 * 的極端情況）—— 但部分拆走的訂單同樣被少算，而那種看起來很正常。
 *
 * 代價是每一筆都要多打一次 API。值得：算錯的營收沒有人看得出來。
 */
export function revenueOf(m: Incoming): { revenue: number; viaCohost: boolean } {
  const earn = num(m.earnings);
  // 明細裡搭檔收款是負數（那是被扣掉的），取絕對值加回來
  const cohost = Math.abs(num(m.cohost));
  return { revenue: earn + cohost, viaCohost: cohost > 0 };
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
    ? (viaCohost ? 'Airbnb 取消收入(含搭檔收款)' : 'Airbnb 取消收入')
    : (viaCohost ? '含搭檔收款(Co-host payout)' : null);

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

  // A 級：取消狀態一律更新
  if (exist.source !== source) patch.source = source;
  patch.fee_type = fee_type;

  /*
   * 金額。**有值就不覆蓋**，不一致列出來。
   *
   * 金額是營收 —— 它被靜靜改掉的代價，遠大於晚一天更新。
   * （取消歸零走的是上面那條 void 的路，不經過這裡。）
   */
  if (!num(exist.amount) && !exist.manually_edited) {
    patch.amount = revenue;                    // 空的或 0 才填
  } else if (num(exist.amount) !== revenue) {
    diffs.push({
      code: m.code, field: '金額',
      from: String(num(exist.amount)),
      to: String(revenue),
    });
  }

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
    // 人改過的連空的都不填 —— 那個空可能就是他刻意清掉的
    if (!exist.property_id && !exist.manually_edited) {
      patch.estate_id = prop.estate_id;
      patch.property_id = prop.id;
      patch.property_raw = prop.name;
    } else if (exist.property_id !== prop.id) {
      diffs.push({
        code: m.code, field: '房源',
        from: txt(exist.property_raw) || txt(exist.property_id),
        to: prop.name,
        listingId: txt(m.listingId),
      });
    }
  }

  // B 級：房客姓名。空的（或當初填了 (unknown)）才補
  const curGuest = txt(exist.guest_name);
  const newGuest = txt(m.guest);
  if (newGuest) {
    if ((!curGuest || curGuest === '(unknown)') && !exist.manually_edited) {
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

/**
 * 一筆「還沒解決的差異」，要寫進 sync_issues。
 *
 * 【為什麼跟 Diff 分開】
 * Diff 是「這一筆比對出什麼」，Issue 是「畫面上要顯示什麼、怎麼修」——
 * 後者多了對不到房源與待人工判斷這兩種（它們不是欄位差異，
 * 但同樣是一條要人去處理的事）。
 */
export type Issue = {
  code: string;
  field: string;
  from?: string;
  to?: string;
  listingId?: string;
  extra?: Record<string, unknown>;
};

/**
 * 把統計轉成待辦清單。
 *
 * 【為什麼「對不到房源」用 listing_id 當 code】
 * 同一個 listing 通常一次對不到好幾筆訂單。用訂單編號當鍵的話，
 * 同一件事會變成十列 —— 而要修的只有一個地方（對照表裡那個 listing）。
 *
 * @param staleOnly listing_id → 它目前只對到的那個「停用房源」名稱。
 *                  那通常就是元兇，附在清單上省得他自己去查。
 */
export function toIssues(s: Summary, staleOnly: Record<string, string> = {}): Issue[] {
  const out: Issue[] = s.diffs.map((d) => ({
    code: d.code,
    field: d.field,
    from: d.from,
    to: d.to,
    listingId: d.listingId,
    extra: d.listingId && staleOnly[d.listingId]
      ? { 停用對照: staleOnly[d.listingId] } : {},
  }));

  for (const a of s.attention) {
    out.push({ code: a.code, field: '待人工判斷', to: a.reason });
  }

  for (const [listingId, n] of Object.entries(s.unmatched)) {
    out.push({
      code: listingId, field: '對不到房源', listingId,
      to: `${n} 筆訂單沒有進來`,
      extra: staleOnly[listingId] ? { 停用對照: staleOnly[listingId] } : {},
    });
  }
  return out;
}

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
