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
 * 【兩個階段，中間隔著一張表】（2026-08-14 使用者決定）
 *
 *   階段一  爬取     Airbnb ──→ airbnb_snapshots
 *           去重、跟上次比、寫快照。**完全不碰 orders。**
 *
 *   階段二  對帳     airbnb_snapshots ──→ orders ＋ 建議清單
 *           決定要改什麼、不改什麼、什麼只出建議。
 *
 * 【為什麼要隔一張表，不直接拿爬回來的資料去對】
 *
 * 直接對的話，對帳範圍被爬取範圍綁死：今天只爬了最近三個月，
 * 那今天就只有最近三個月被對到。而改了一條規則想重算歷史時，
 * 唯一的辦法是把整個 Airbnb 再爬一次 —— 幾千次 API 請求，
 * 而且會被限流。
 *
 * 隔一張表之後：
 *   · 對帳的輸入是**整張快照表**，不是今天抓到的那幾筆
 *   · 改了規則就重跑對帳，一次 API 都不用打
 *   · 爬取中斷／失敗不影響已經存下來的東西
 *   · 「Airbnb 到底說多少」變成一句 SQL，不用開瀏覽器去翻
 *
 * 快照是 Airbnb 的鏡像 —— ERP 的訂單表已經被人改過、被規則擋過，
 * 早就不是原貌了。要對帳就得有一份沒被動過的東西可以對。
 *
 *
 * ============================================================
 * 【ERP 只自動做兩件事】（2026-08-14 使用者決定）
 *
 *   1. 新訂單     沒見過的確認碼 → 直接新增
 *   2. 取消       取消且無收入 → 整筆作廢、金額歸零
 *                 取消但有收入 → 訂單狀態改成取消
 *
 * **其餘一律只出建議，人工對。**
 * 金額、房源、房客姓名、住宿起訖 —— 一個字都不自動改。
 *
 *
 * 【為什麼只有這兩件】
 *
 * 這兩件事有一個共同點：**它們不會蓋掉任何人的判斷。**
 *
 *   新增   之前沒有這筆，沒有東西可以被蓋掉
 *   取消   只會讓營收變小
 *
 * 而少算與多算的成本不對稱：少算會有人發現（錢對不上、有人來問），
 * 多算不會 —— 一筆已取消的訂單躺在營收裡看起來完全正常，
 * 永遠沒有人會去查。所以自動化只往這個方向動。
 *
 * 其他每一個欄位都可能是某個人某天刻意調過的。2026-08-12 晚上
 * 有人把一筆從 95,231.63 改成 124,346，隔天早上 06:06 同步改回去，
 * 中午另一個人又改成 158,720 —— 兩個人都以為是自己沒存到。
 * 那次的教訓不是「要判斷得更聰明」，是**根本不要自動改**。
 *
 *
 * 【不自動改的代價，以及補網在哪裡】
 *
 * 住宿起訖是唯一一個代價不在錢上的：縮住沒更新，系統以為房間
 * 還有人，可能推掉真的訂單；延住沒更新，行事曆說房間是空的
 * 而實際上有人住 —— 那會重複出租，比多算營收更難收拾。
 *
 * 補網是訂單頁的「👀防呆」：它抓得到同一間房的期間重疊。
 * 但補網要人去按，所以日期的建議分級不能放到最低。
 *
 *
 * 完全不碰（任何情況）：收款、押金、帳號、備註、發票、移房。
 *
 *
 * ============================================================
 * 【為什麼「不覆蓋」還要一筆一筆列出來】
 *
 * 只是不覆蓋的話，你今天的修正保住了，但明天的新訂單還是會掛錯 ——
 * 問題從「被改回去」變成「新的一直掛錯」，而後者更難發現。
 *
 * 所以每一條建議都要講得出：差多少、往哪個方向、為什麼。
 * 「金額不一致」是一份焦慮清單；
 * 「應增加 $70,320，少了搭檔收款」是一件可以做完的事。
 */

/**
 * 爬蟲上次在 Airbnb 看到的樣子。
 *
 * ============================================================
 * 【為什麼要記這個】
 *
 * 沒有快照的話，比對只回答得了一句：ERP 跟 Airbnb 不一樣。
 * 它回答不了真正要緊的那句：**是誰動了？**
 *
 *   · Airbnb 昨天說 105,479、今天說 175,799 → Airbnb 改了，今天才發生
 *   · Airbnb 一直說 175,799，ERP 一直是 105,479 → 舊帳，等人去修
 *
 * 兩者現在混在同一份清單裡、長得一模一樣。結果每天早上看到的
 * 都是同一批熟面孔，真正今天才變的那一筆藏在裡面 ——
 * 幾天之後就沒有人在看那份清單了。
 *
 * 而且有了快照才講得出原因：「搭檔收款從 $0 變成 $70,320」
 * 比「金額不一致」有用得多 —— 前者直接告訴你該怎麼改。
 */
export type Snapshot = {
  code: string;
  listing_id?: string | null;
  guest?: string | null;
  start_date?: string | null;
  end_date?: string | null;
  nights?: number | null;
  status_key?: string | null;
  earnings?: number | null;
  /** 已經取過絕對值 */
  cohost?: number | null;
  revenue?: number | null;
  /** 上一次變動改了什麼。對帳晚幾小時跑也還講得出原因 */
  change_note?: string | null;
  changed_at?: string | null;
  /** 在掃描範圍內卻沒出現 = 在 Airbnb 上不見了 */
  missing_since?: string | null;
  last_seen?: string | null;
  seen_count?: number | null;
};

/* ══════════════════════════════════════════════════════
 * 階段一：爬回來的東西 ⇄ 快照
 * ══════════════════════════════════════════════════════ */

/** 要寫進 airbnb_snapshots 的一列 */
export type SnapshotRow = {
  code: string;
  listing_id: string | null;
  guest: string | null;
  start_date: string | null;
  end_date: string | null;
  nights: number | null;
  status_key: string | null;
  earnings: number;
  cohost: number;
  revenue: number;
  last_seen: string;
  changed_at: string | null;
  change_note: string | null;
  missing_since: null;
  raw: unknown;
  seen_count: number;
};

/**
 * 把爬回來的一筆變成要寫進快照的一列。
 *
 * 【為什麼 changed_at 沒變就要寫回舊值，不是省略這個欄位】
 * PostgREST 的批次 upsert 取所有列的欄位聯集 —— 某幾列少了某個鍵
 * 就會被填成 null，把「上次是什麼時候變的」整批抹掉，而且不報錯。
 * 明寫回舊值是唯一不依賴那個行為的做法。
 *
 * 【為什麼 missing_since 一律清成 null】
 * 這一輪看到它了，那它就不是不見了 —— 不清的話，一筆曾經
 * 因為掃描範圍沒涵蓋而被標記過的訂單，會永遠掛著失蹤的記號。
 */
export function snapshotRowOf(
  m: Incoming, prev: Snapshot | null | undefined, nowIso: string,
): SnapshotRow {
  const { revenue } = revenueOf(m);
  const changes = snapshotChanges(prev, m);
  return {
    code: txt(m.code),
    listing_id: m.listingId == null ? null : String(m.listingId),
    guest: m.guest ?? null,
    start_date: m.start || null,
    end_date: m.end || null,
    nights: m.nights ?? null,
    status_key: m.statusKey ?? null,
    earnings: num(m.earnings),
    cohost: Math.abs(num(m.cohost)),
    revenue,
    last_seen: nowIso,
    changed_at: changes.length ? nowIso : (prev?.changed_at ?? null),
    change_note: changes.length ? changes.join('、') : (prev?.change_note ?? null),
    missing_since: null,
    raw: m,
    seen_count: (Number(prev?.seen_count) || 0) + 1,
  };
}

/**
 * 把快照變回「一筆待對帳的資料」。
 *
 * 階段二讀的是快照而不是爬蟲的 payload，所以要走這一步轉回來 ——
 * 決策邏輯只有一份，兩個階段共用同一組規則。
 */
export function incomingOf(s: Snapshot): Incoming {
  return {
    code: s.code,
    listingId: s.listing_id ?? null,
    guest: s.guest ?? null,
    start: s.start_date ?? null,
    end: s.end_date ?? null,
    nights: s.nights ?? null,
    statusKey: s.status_key ?? null,
    earnings: s.earnings ?? 0,
    cohost: s.cohost ?? 0,
  };
}

/**
 * 在掃描範圍內卻沒出現的 = 在 Airbnb 上不見了。
 *
 * ============================================================
 * 【scope 的合約：那是「窮舉範圍」，不是「涵蓋範圍」】
 *
 * 呼叫端給的 scope 必須滿足一句話：
 *
 *     「這段入住日區間裡的訂單，我這一輪**全部**抓到了。」
 *
 * 只有在這個前提下，「沒看到」才等於「不存在」。
 *
 * 【2026-08-14 就是這裡踩到的】
 *
 * 第一版讓爬蟲送三趟抓取的 **min/max 入住日**。但那三趟是三個
 * 不相連的切片，其中「最近已結束」那趟只取前 100 筆 ——
 * 100 筆以前的歷史訂單永遠不會出現，卻落在 min~max 之間。
 *
 * 結果 203 筆完全正常的訂單被標成失蹤，包括 Erin $175,800、
 * Michael $41,316 這些明顯還在的單。
 *
 * min/max 描述的是「我碰過哪些日期」，不是「我掃遍了哪些日期」。
 * 兩者差一個字，結論差 203 筆。
 *
 * 現在爬蟲只宣告「未來與進行中」那一趟的範圍（from = 今天），
 * 因為只有那一趟是真的翻到取完。
 *
 * @param scope 這一輪**保證全抓**的入住日區間。沒給就是 null
 * @param runStart 這一輪開始的時間。比它舊的 last_seen 就是這輪沒看到
 */
export function findMissing(
  snaps: Snapshot[],
  scope: { from?: string | null; to?: string | null } | null,
  runStart: string,
): Snapshot[] {
  if (!scope?.from || !scope?.to) return [];
  return snaps.filter((s) => {
    if (!s.start_date) return false;
    if (s.start_date < scope.from! || s.start_date > scope.to!) return false;
    if (s.missing_since) return false;              // 已經標記過了，不重複報
    return !s.last_seen || s.last_seen < runStart;  // 這一輪沒看到
  });
}

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
  /** 用來講「延住幾晚／縮住幾晚」—— 只寫日期的話他還要自己算 */
  nights?: number | null;
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

/**
 * 退房後幾天內，金額還跟著 Airbnb 走。
 *
 * ============================================================
 * 【為什麼不是退房當天就鎖】
 *
 * Airbnb 的金額在退房**之後**還會動：最終結算、事後退款、
 * 客訴賠償、清潔費爭議。退房當天就鎖的話，那些最終數字
 * 永遠進不了系統 —— 而它們才是真正該入帳的金額。
 *
 * 【為什麼要鎖】
 *
 * 過了結算期的訂單，那個月八成已經對過帳、開過發票。
 * 這時候金額被自動改掉，改的是一個已經結掉的月份 ——
 * 帳面上憑空多出或少掉一筆，而且沒有人會知道是什麼時候發生的。
 *
 * 7 天是「還在變動中」與「已經定案」的分界。要更保守就設 0
 * （退房就鎖），要完全不管退房就設一個很大的數字。
 */
export const AMOUNT_GRACE_DAYS = 7;

/**
 * 小於這個金額的差不進建議清單。
 *
 * ============================================================
 * 【為什麼要有門檻】
 *
 * 2026-08-14 第一次跑，9 條金額建議裡大多長這樣：
 *
 *     HMZBX24YZT   163,251 → 163,250.62      差 0.38
 *     HME2KKYA3T    23,657 → 23,657.30       差 0.30
 *
 * 那是 Airbnb 的小數與我們存的整數之間的進位差，不是錯帳。
 *
 * 更糟的是原因那句話：兩邊四捨五入後顯示同一個數字，於是變成
 * 「Airbnb 一直是 $163,251，系統裡是 $163,251 —— 這個差是我們這邊調過的」
 * 讀起來像系統壞了。
 *
 * 這種列的成本不只是佔一行 —— 它讓整份清單失去「出現在這裡就要處理」
 * 的意義。一份九成是雜訊的清單，第三天就沒有人看了。
 */
export const AMOUNT_EPSILON = 1;

const DAY = 86400000;
const dayNum = (d: string) => new Date(`${d}T00:00:00Z`).getTime() / DAY;

/**
 * 這筆訂單的金額算不算「已經定案」。
 *
 * @param today 傳進來而不是直接 new Date() —— 測試才穩定
 */
export function isSettled(
  checkout: string | null | undefined, today: string | null | undefined,
  graceDays = AMOUNT_GRACE_DAYS,
): boolean {
  if (!checkout || !today) return false;   // 不知道就當作還沒定案
  return dayNum(today) - dayNum(checkout) > graceDays;
}

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
  /**
   * 為什麼會不一樣、該怎麼想。
   *
   * 【為什麼原因要在這裡算，不是在畫面上】
   * 畫面只看得到 from 與 to。「105,479 → 175,799」看不出所以然，
   * 但比對的當下知道搭檔收款從 0 變成 70,320 —— 那句話直接就是答案。
   * 錯過這個時間點就再也算不出來了。
   */
  reason?: string;
  /** Airbnb 那邊今天才變的（跟上次的快照不同）。舊帳沒有這個記號。 */
  airbnbChanged?: boolean;
  /** 蓋掉這個欄位的預設分級。同一種差異的輕重可能因狀況而不同 */
  severity?: Severity;
};

/**
 * 建議的嚴重度。
 *
 * 【為什麼要分】
 * 不分的話每天最多的那一種（住宿起訖 —— 而且系統已經改好了）
 * 會把真正要處理的蓋掉。清單一長，人就整份不看了。
 */
export type Severity = 'high' | 'mid' | 'low';

export const SEVERITY_OF: Record<string, Severity> = {
  // 營收數字會錯
  金額: 'high',
  對不到房源: 'high',      // 訂單根本沒進系統，那筆錢完全不存在
  待人工判斷: 'high',
  '在 Airbnb 找不到': 'high',   // ERP 有、Airbnb 沒有 —— 那筆錢可能不該算
  // 營收歸屬會錯 —— 錢進來了，但算到別的物業頭上
  房源: 'mid',
  // 系統已經改好了，只是通知你一聲
  住宿起訖: 'low',
  房客姓名: 'low',
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

/* ══════════════════════════════════════════════════════
 * 去重
 * ══════════════════════════════════════════════════════ */

/**
 * 同一批資料裡同一個確認碼只留一筆。
 *
 * ============================================================
 * 【為什麼一定要做】
 *
 * 爬蟲翻頁時同一筆訂單出現在兩頁是**常態** —— Airbnb 的分頁是依
 * 時間切的，邊界那幾筆會重複。
 *
 * 不去重的話，同一個確認碼會走兩次 decide()，兩次都判斷
 * 「這是新訂單」，然後**插入兩列**。而重複的訂單在報表上
 * 看起來完全正常，只是那個月多了一筆錢：
 *
 *   2026-07  多算 33,053
 *   2026-08  多算 782,102
 *
 * 【為什麼留後面那一筆】
 *
 * 爬蟲抓明細是一筆一筆補上去的，後面那次通常資料更完整
 * （尤其是搭檔收款 —— 它只在明細裡）。留前面那筆會拿到淨額。
 *
 * 但如果後面那筆反而少了搭檔收款，就留有值的那個 ——
 * 明細抓失敗時 cohost 會是 null，那不代表真的沒有搭檔收款。
 */
export function dedupe(items: Incoming[]): { items: Incoming[]; dropped: number } {
  const byCode = new Map<string, Incoming>();
  let dropped = 0;
  for (const m of items) {
    const code = txt(m.code);
    if (!code) continue;
    const prev = byCode.get(code);
    if (!prev) { byCode.set(code, m); continue; }
    dropped++;
    // 明細抓失敗時 cohost 是 null；別讓那一筆蓋掉抓到的那筆
    const keepPrev = Math.abs(num(prev.cohost)) > 0 && !(Math.abs(num(m.cohost)) > 0);
    byCode.set(code, keepPrev ? prev : m);
  }
  return { items: [...byCode.values()], dropped };
}

/* ══════════════════════════════════════════════════════
 * 原因
 * ══════════════════════════════════════════════════════ */

const cash = (n: number) => '$' + Math.round(n).toLocaleString('en-US');

/**
 * 跟上次比，Airbnb 那邊改了什麼。
 *
 * 【為什麼要逐項講，不只說「變了」】
 * 「金額變了」讀完還是不知道要做什麼。「延住 4 晚」與
 * 「搭檔收款從 0 變成 70,320」要採取的行動完全不同 ——
 * 前者要看行事曆有沒有撞，後者是我們的公式一直算錯。
 *
 * @returns 沒有快照（第一次看到）或沒有變化時回空陣列
 */
export function snapshotChanges(prev: Snapshot | null | undefined, m: Incoming): string[] {
  if (!prev) return [];
  const out: string[] = [];
  const { revenue } = revenueOf(m);
  const cohost = Math.abs(num(m.cohost));

  const wasCancelled = /cancel/i.test(txt(prev.status_key));
  if (wasCancelled !== isCancelled(m)) {
    out.push(isCancelled(m) ? '狀態改成「已取消」' : '取消被撤回，恢復成正常訂單');
  }

  if (txt(prev.start_date) !== txt(m.start) || txt(prev.end_date) !== txt(m.end)) {
    const before = num(prev.nights), after = num(m.nights);
    const n = after && before && after !== before
      ? `（${before} 晚 → ${after} 晚）` : '';
    out.push(`住宿改成 ${txt(m.start)}~${txt(m.end)}${n}`);
  }

  const prevCohost = Math.abs(num(prev.cohost));
  if (prevCohost !== cohost) {
    out.push(`搭檔收款 ${cash(prevCohost)} → ${cash(cohost)}`);
  }

  const prevEarn = num(prev.earnings);
  if (prevEarn !== num(m.earnings)) {
    out.push(`你賺得 ${cash(prevEarn)} → ${cash(num(m.earnings))}`);
  }

  // 上面都沒抓到但總額仍然不同 —— 講一句總比沉默好
  if (!out.length && num(prev.revenue) !== revenue) {
    out.push(`金額 ${cash(num(prev.revenue))} → ${cash(revenue)}`);
  }
  return out;
}

/**
 * 這一筆算不算「Airbnb 剛改過」。
 *
 * 階段二拿到的 prev 就是快照本身（已經是今天的樣子），所以逐欄比
 * 一定相同 —— 靠的是快照上那句 change_note。
 * 階段一拿到的是上一輪的快照，靠的是逐欄比。兩條路都要走得通。
 */
const didChange = (prev: Snapshot | null | undefined, m: Incoming) =>
  !!txt(prev?.change_note) || snapshotChanges(prev, m).length > 0;

/**
 * 把太舊的變動記號忘掉。
 *
 * ============================================================
 * 【為什麼需要這個】
 *
 * change_note 是會留著的 —— 一筆三個月前改過搭檔收款的訂單，
 * 那句話到今天都還在。直接拿來當「這次才改的」，那個標記就會
 * 永遠亮著，而清單上永遠亮著的標記等於沒有標記。
 *
 * 所以對帳時先過這一層：只有 changed_at 比 since 新的才算數。
 *
 * 【為什麼不是在對帳當下重算】
 * 重算不出來 —— 舊值在爬取那一刻就被蓋掉了。
 * 那句話只有覆蓋前的最後一秒講得出來，之後只能選擇要不要採信。
 */
export function forgetStaleChange(s: Snapshot, since: string): Snapshot {
  if (s.changed_at && s.changed_at >= since) return s;
  return { ...s, change_note: null, changed_at: null };
}

/**
 * 金額為什麼不一樣，以及該怎麼想。
 *
 * ============================================================
 * 【判斷順序是刻意的 —— 先講最能行動的那一句】
 *
 * 1. Airbnb 今天改了      → 講改了什麼。這是新事件，也最好處理
 * 2. ERP 剛好等於淨額     → 少了搭檔收款。這是系統性的算法錯，
 *                            而且一講就能確認：差額正好等於搭檔收款
 * 3. ERP 是 0             → 從來沒填過
 * 4. 都不是               → Airbnb 一直是這個數字，是我們這邊調過
 *
 * 第 2 種是這個專案最貴的一種錯：每一筆有搭檔的訂單都少算，
 * 少算的比例每筆不同，看報表完全看不出哪裡不對。
 */
export function amountAdvice(
  erpAmount: number, m: Incoming,
  /**
   * 上次的樣子，或（階段二用）快照上already算好的那句話。
   *
   * 對帳可能比爬取晚幾小時甚至隔天跑 —— 那時候舊值已經被蓋掉，
   * 「從多少變成多少」再也算不出來。所以爬取當下就把那句話存進
   * change_note，對帳直接拿來用。
   */
  prev?: Snapshot | null,
): { direction: '增加' | '減少' | '相同'; delta: number; reason: string; airbnbChanged: boolean } {
  const { revenue } = revenueOf(m);
  const delta = Math.round(revenue - erpAmount);
  const direction = delta > 0 ? '增加' : delta < 0 ? '減少' : '相同';
  const cohost = Math.abs(num(m.cohost));

  // 快照上有現成的那句話就用它 —— 那是覆蓋前的最後一刻算出來的
  const noted = txt(prev?.change_note);
  const changes = noted ? [noted] : snapshotChanges(prev, m);
  const airbnbChanged = changes.length > 0;

  let reason: string;
  if (airbnbChanged) {
    reason = `Airbnb 這次改了：${changes.join('、')}`;
  } else if (cohost > 0 && Math.abs(erpAmount - num(m.earnings)) < 1) {
    // 差額正好等於搭檔收款 —— 一算就能確認的鐵證
    reason = `系統裡記的是淨額，少了搭檔收款 ${cash(cohost)}`
      + `（${cash(num(m.earnings))} ＋ ${cash(cohost)} ＝ ${cash(revenue)}）`;
  } else if (!erpAmount) {
    reason = '系統裡是 0，從來沒填過';
  } else {
    reason = `Airbnb 一直是 ${cash(revenue)}，系統裡是 ${cash(erpAmount)}`
      + ' —— 這個差是我們這邊調過的';
  }

  const head = direction === '相同' ? '' : `應${direction} ${cash(Math.abs(delta))}。`;
  return { direction, delta, reason: head + reason, airbnbChanged };
}

/**
 * 決定這一筆要做什麼。
 *
 * @param exist 既有訂單；沒有就是 null（新增）
 * @param prop  listing_id 對到的房源；對不到就是 null
 */
export function decide(
  m: Incoming, exist: Existing | null, prop: PropRef | null,
  ctx: { prev?: Snapshot | null; today?: string | null } = {},
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

  /* ══════════════════════════════════════════════════
   * 既有訂單：只有「取消」會動，其餘一律只出建議
   * ══════════════════════════════════════════════════ */
  const patch: Record<string, unknown> = {};

  /*
   * 取消狀態。這是既有訂單上**唯一**會被自動改的東西。
   *
   * 為什麼它可以自動：取消只會讓營收變小。少算有人會發現（錢對不上、
   * 有人來問），多算不會 —— 一筆已取消的訂單躺在營收裡看起來完全正常，
   * 永遠沒有人會去查。
   */
  if (exist.source !== source) {
    patch.source = source;
    patch.fee_type = fee_type;
  }

  /** 這筆訂單「還在變動中」還是「已經定案」—— 決定建議有多急 */
  const settled = isSettled(exist.checkout, ctx.today);
  /** 附在原因後面的狀態註記。哪一筆更該小心，一眼看得出來 */
  const tags = [
    exist.manually_edited ? '有人工編輯過' : '',
    settled ? '' : '還在結算中，可能還會再變',
  ].filter(Boolean);
  const withTags = (s: string) => tags.length ? `${s}（${tags.join('；')}）` : s;

  /*
   * 金額。
   *
   * 【為什麼一個字都不改】（2026-08-14 使用者決定）
   *
   * 金額是營收。它被靜靜改掉的代價，遠大於晚一天更新 ——
   * 2026-08-12 就發生過：有人把一筆從 95,231.63 改成 124,346，
   * 隔天早上 06:06 同步改回去，中午另一個人又改成 158,720。
   * 兩個人都以為是自己沒存到。
   *
   * 【還沒定案的差異為什麼降級】
   * 訂單還在住、或剛退房，Airbnb 的數字之後還會再動（最終結算、
   * 事後退款、客訴賠償）。現在去對，很可能過幾天要再對一次 ——
   * 那種「做了但白做」的事會讓人開始整份清單都不看。
   */
  const erpAmount = num(exist.amount);
  // 1 元以下的差是小數進位，不是錯帳 —— 見 AMOUNT_EPSILON
  if (Math.abs(erpAmount - revenue) >= AMOUNT_EPSILON) {
    const a = amountAdvice(erpAmount, m, ctx.prev);
    diffs.push({
      code: m.code, field: '金額',
      from: String(erpAmount), to: String(revenue),
      reason: withTags(a.reason),
      airbnbChanged: a.airbnbChanged,
      severity: settled ? 'high' : 'mid',
    });
  }

  /*
   * 住宿起訖。
   *
   * 【這一條不改是有代價的，代價不在錢上】
   * 縮住沒更新的話，系統以為房間還有人，可能推掉真的訂單；
   * 延住沒更新的話，行事曆說房間是空的而實際上有人住 ——
   * 那會導致重複出租，比多算營收更難收拾。
   *
   * 所以它雖然只是建議，分級不能放到最低。訂單頁的「👀防呆」
   * 抓得到期間重疊，那是這條規則的補網 —— 但補網要人去按。
   */
  const dateChanged =
    (m.start && txt(exist.checkin) !== txt(m.start)) ||
    (m.end && txt(exist.checkout) !== txt(m.end));
  if (dateChanged) {
    const before = num(exist.nights), after = num(m.nights);
    const shift = after && before && after !== before
      ? (after > before ? `延住 ${after - before} 晚` : `縮住 ${before - after} 晚`)
      : '日期調整';
    diffs.push({
      code: m.code, field: '住宿起訖',
      from: `${txt(exist.checkin)}~${txt(exist.checkout)}`,
      to: `${txt(m.start)}~${txt(m.end)}`,
      reason: withTags(`${shift}。系統沒有跟著改 —— 日期會改變營收攤提的月份，`
        + '而且行事曆不更新可能會重複出租，建議改一下'),
      airbnbChanged: didChange(ctx.prev, m),
      severity: 'mid',
    });
  }

  /*
   * 房源。不一致幾乎都是「listing 在 ERP 對到的房源已經過時」——
   * 例如對照表還指著停用的「舊-A15」。那份清單就是搬對照表的依據。
   */
  if (prop && exist.property_id !== prop.id) {
    const empty = !exist.property_id;
    diffs.push({
      code: m.code, field: '房源',
      from: txt(exist.property_raw) || txt(exist.property_id) || '(空白)',
      to: prop.name,
      listingId: txt(m.listingId),
      reason: withTags(empty
        ? `這筆訂單沒有房源，Airbnb 的 listing（${txt(m.listingId)}）對到「${prop.name}」。`
          + '沒有房源的訂單在報表上是一個沒有歸屬的數字'
        : `這個 listing（${txt(m.listingId)}）在系統裡對到「${prop.name}」，`
          + '但這筆訂單掛的是別的房源。到「房源管理」把對照改好，隔天這一列會自己消失'),
      severity: empty ? 'high' : 'mid',
    });
  }

  // 房客姓名。仍然算出來（API 回應查得到），但不進建議清單 ——
  // Airbnb 顯示名跟正式姓名本來就不會一樣，那不是一件待辦
  const curGuest = txt(exist.guest_name);
  const newGuest = txt(m.guest);
  if (newGuest && curGuest !== newGuest) {
    diffs.push({ code: m.code, field: '房客姓名', from: curGuest || '(空白)', to: newGuest });
  }

  if (!Object.keys(patch).length) {
    return { decision: { kind: 'skip', code: m.code, reason: '沒有要自動改的' }, diffs };
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
  severity: Severity;
  /** 為什麼、該怎麼做。只有比對的當下算得出來 */
  reason?: string;
  /** Airbnb 那邊今天才變的。舊帳沒有這個記號 */
  airbnbChanged?: boolean;
  extra?: Record<string, unknown>;
};

/**
 * 不進建議清單的差異。
 *
 * 【為什麼把房客姓名拿掉】（2026-08-14 使用者決定）
 * Airbnb 顯示名（Michael Hu、暱稱、中英夾雜）跟我們登記的正式姓名
 * 本來就不會一樣，而且**永遠不會被修好** —— 它不是一件待辦。
 *
 * 自清的清單只有在「空了就代表沒事」時才有意義。放一堆永遠清不掉的
 * 東西進去，幾週之後清單長到沒有人看，真正要處理的那幾筆就被淹掉了。
 *
 * 姓名仍然會補（空的時候），也還在 API 回應裡看得到 —— 只是不佔清單。
 */
const NOT_AN_ISSUE = new Set(['房客姓名']);

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
  const out: Issue[] = s.diffs
    .filter((d) => !NOT_AN_ISSUE.has(d.field))
    .map((d) => ({
      code: d.code,
      field: d.field,
      from: d.from,
      to: d.to,
      listingId: d.listingId,
      severity: d.severity ?? SEVERITY_OF[d.field] ?? 'mid',
      reason: d.reason,
      airbnbChanged: !!d.airbnbChanged,
      extra: d.listingId && staleOnly[d.listingId]
        ? { 停用對照: staleOnly[d.listingId] } : {},
    }));

  for (const a of s.attention) {
    out.push({
      code: a.code, field: '待人工判斷', to: a.reason,
      severity: 'high',
      reason: 'Airbnb 顯示已取消且無收入，但系統裡標記為已收款。'
        + '錢真的進來過就不能自動歸零 —— 要你判斷是退款了還是狀態記錯了',
    });
  }

  for (const [listingId, n] of Object.entries(s.unmatched)) {
    out.push({
      code: listingId, field: '對不到房源', listingId,
      to: `${n} 筆訂單沒有進來`,
      severity: 'high',
      reason: staleOnly[listingId]
        ? `這個 listing 只對到已停用的「${staleOnly[listingId]}」。`
          + '到「房源管理」把 listing_id 搬到現行的那間房'
        : '這個 listing 在系統裡沒有任何對照，訂單根本沒進來 ——'
          + '那筆錢在報表上完全不存在。到「房源管理」補上對照',
      extra: staleOnly[listingId] ? { 停用對照: staleOnly[listingId] } : {},
    });
  }

  /*
   * 排序：先看今天才變的，再依嚴重度。
   *
   * 兩個維度而不是一個 —— 「今天才變的」是新事件（多半好處理，
   * 而且錯過就會沉進舊帳裡），嚴重度是後果大小。
   * 只按嚴重度排的話，新事件會被一整排陳年的高風險項目蓋住。
   */
  const RANK: Record<Severity, number> = { high: 0, mid: 1, low: 2 };
  return out.sort((a, b) =>
    Number(!!b.airbnbChanged) - Number(!!a.airbnbChanged)
    || RANK[a.severity] - RANK[b.severity]
    || a.code.localeCompare(b.code));
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
