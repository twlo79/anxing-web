/**
 * 帳本：安幸 / 愛皮 / 洪鯊。
 *
 * ============================================================
 * 【為什麼要有這支】（2026-08-22）
 *
 * 系統原本只記安幸（包租代管）的錢。現在多兩家:
 *
 *     洪鯊  投資公司   股利、利息、處分損益
 *     愛皮  旅行社     團費、機票住宿代收代付
 *
 * 完整企劃見 `docs/企劃-其他收支帳-愛皮洪鯊.md`。
 *
 *
 * ============================================================
 * 【這支存在的唯一理由：篩選只寫一次】
 *
 * ★★ 現有的每一支收入／支出查詢，如果不加 `book = 'anxing'`，
 *    **兩家的錢會混進安幸的數字裡，而金額看起來完全正常**。
 *
 * 十幾個檔案各寫一次 `.eq('book', 'anxing')` 的話，
 * 漏掉一支不會報錯 —— 只會有某張報表悄悄多算兩家公司的錢，
 * 而發現的時候通常是年底對帳對不起來。
 *
 * 所以全站只有這一份清單、一支篩選函式。
 *
 *
 * 【為什麼寫在 .ts 不是 .tsx】
 * 測試環境不處理 JSX。這裡的判斷直接決定「哪些錢算進哪張報表」。
 */

export const BOOKS = ['anxing', 'aipi', 'hongsha'] as const;
export type Book = (typeof BOOKS)[number];

/** 預設帳本。既有資料全部是它（migration_159 回填）。 */
export const DEFAULT_BOOK: Book = 'anxing';

/** 「其他收支帳」那一頁涵蓋的 —— 不含安幸。 */
export const OTHER_BOOKS = ['aipi', 'hongsha'] as const satisfies readonly Book[];

export const BOOK_LABEL: Record<Book, string> = {
  anxing: '安幸',
  aipi: '愛皮',
  hongsha: '洪鯊',
};

/** 業務別。給頁面標題與空狀態的文案用。 */
export const BOOK_BIZ: Record<Book, string> = {
  anxing: '包租代管',
  aipi: '旅行社',
  hongsha: '投資公司',
};

/** 不認得的值一律當安幸 —— 不要讓一筆錢因為值怪掉就從所有報表上消失。 */
export function toBook(v: string | null | undefined): Book {
  return (BOOKS as readonly string[]).includes(v ?? '') ? (v as Book) : DEFAULT_BOOK;
}

export const isOtherBook = (v: string | null | undefined) => toBook(v) !== 'anxing';

export const bookLabel = (v: string | null | undefined) => BOOK_LABEL[toBook(v)];

/* ══════════════ 收入側 ══════════════ */

/**
 * 訂單的「來源」多一個值。
 *
 * ★ 它會出現在營收表的來源篩選與顏色標籤裡 —— 那是刻意的，
 *   一眼看得出哪幾筆不是安幸的。
 */
export const OTHER_BIZ_SOURCE = 'other_biz';

/**
 * 選了「其他事業體收入」時要藏起來的欄位。
 *
 * 使用者確認:兩家**沒有房源、不收押金、都是一次性收入**。
 *
 * ★ 押金一定要藏 —— 留著會有人誤填，而誤填的押金會跑進押金管理頁
 *   變成一筆「要退給誰」的錢，而根本沒有人收過那筆錢。
 */
export function incomeFieldsHidden(source: string | null | undefined) {
  const other = source === OTHER_BIZ_SOURCE;
  return {
    property: other,   // 沒有房源
    deposit: other,    // 不收押金
    dateRange: other,  // 一次性收入只要一個日期，不要起訖
  };
}

/** 收入表單右邊那一欄的標籤：安幸叫「物業」，其他事業體叫「事業體」。 */
export const incomePartyLabel = (source: string | null | undefined) =>
  (source === OTHER_BIZ_SOURCE ? '事業體' : '物業');

/**
 * 押金這一欄該不該顯示（2026-08-22 使用者指定）。
 *
 * 兩種情況沒有押金:
 *
 *   平台代收   Airbnb / Agoda 的錢是平台收的，押金不經過我們手上
 *   其他事業體 投資公司與旅行社不收押金
 *
 * ★ 不顯示而不是顯示「—」。「—」那一行**永遠是空的**，
 *   而每一行永遠是空的欄位都在教使用者「這一頁有些東西不用看」。
 */
const PLATFORM_SOURCES = ['airbnb', 'agoda', 'airbnb_cancelled'] as const;

/**
 * ★★★ Airbnb 例外（2026-09-01 使用者:「airbnb 可放入 額外押金
 * 加入後一樣會到 暫收付管理 可開放」）。
 *
 * 上面那段「平台代收」的道理沒有變 —— **房費**確實是平台收的。
 * 但寵物押金不是房費:房客帶寵物來的時候，那筆錢是我們自己當場收的，
 * 錢真的在我們手上，所以它必須進暫收付管理，才退得出去。
 *
 * ★ Agoda 與其他事業體**維持鎖住**。使用者只講了 Airbnb，
 *   而「順便一起開」是在替沒有人要求的情境做決定 ——
 *   Agoda 沒有寵物政策的話，那一欄會永遠是空的
 *   （而永遠是空的欄位在教使用者「這一頁有些東西不用看」，見上）。
 *
 * ★★ `airbnb_cancelled` 也不開:已取消的訂單不會有人帶寵物來。
 */
const DEPOSIT_OK_PLATFORMS = ['airbnb'] as const;

export const hasDeposit = (source: string | null | undefined) =>
  (DEPOSIT_OK_PLATFORMS as readonly string[]).includes(source ?? '')
  || (!(PLATFORM_SOURCES as readonly string[]).includes(source ?? '')
      && source !== OTHER_BIZ_SOURCE);

/* ══════════════ 支出側 ══════════════ */

/** 請款項目的用途多一個值。`estate_id` / `property_id` 一律 null。 */
export const OTHER_BIZ_PURPOSE = 'other_biz';

/* ══════════════ 一致性 ══════════════ */

export type Verdict = { ok: true } | { ok: false; error: string };

/**
 * 來源／用途與 book 對不對得起來。
 *
 * ★ 資料庫也會擋（migration_160 的 `pri_book_guard`）——
 *   這裡先擋一次是為了**在按下去之前就講清楚**。
 *   讓它走到資料庫的話，使用者看到的是一句 SQL 例外訊息。
 */
export function checkIncomeBook(source: string | null | undefined, book: string | null | undefined): Verdict {
  const isOther = source === OTHER_BIZ_SOURCE;
  const b = toBook(book);
  if (isOther && b === 'anxing') {
    return { ok: false, error: '請選擇事業體（愛皮或洪鯊）' };
  }
  if (!isOther && b !== 'anxing') {
    return { ok: false, error: '這筆來源不是「其他事業體收入」，不能記在愛皮／洪鯊的帳上' };
  }
  return { ok: true };
}

/**
 * 一張請款單只能有一本帳。
 *
 * 用途是每個項目各自選的，所以一張單理論上可以一項正隆、一項愛皮 ——
 * 那樣支出產生時會拆進兩本帳，而總額對不起來時
 * 沒有人知道該去哪一本查。
 *
 * 回傳**還沒對齊的項目名稱**，不是一句「有項目不對」——
 * 十七個項目的單子上，後者等於沒說。
 */
export function misbookedItems(
  book: string | null | undefined,
  items: { item_name?: string | null; purpose_type?: string | null }[],
): string[] {
  const other = toBook(book) !== 'anxing';
  return (items ?? [])
    .filter((i) => (i.purpose_type === OTHER_BIZ_PURPOSE) !== other)
    .map((i, n) => (i.item_name ?? '').trim() || `第 ${n + 1} 項`);
}

/**
 * 這張單的項目能選哪些用途。
 *
 * 第一項選了之後其餘項目就被鎖定 —— 前端靠它限制下拉選項。
 */
export function allowedPurposes(book: string | null | undefined): string[] {
  return toBook(book) === 'anxing' ? ['estate', 'office'] : [OTHER_BIZ_PURPOSE];
}

/* ══════════════ 查詢 ══════════════ */

/**
 * 幫查詢加上帳本條件。**每一支收入／支出查詢都要經過它。**
 *
 * ★ 不給 book 就是安幸 —— 既有查詢加上這一行之後行為完全不變，
 *   所以可以安心地一支一支補，不用擔心改壞現有報表。
 */
export function withBook<T extends { eq: (col: string, val: string) => T }>(
  q: T, book: Book = DEFAULT_BOOK,
): T {
  return q.eq('book', book);
}

/**
 * 「＋ 增加項目」時，新項目的用途要不要先填好（2026-08-25 使用者:
 * 「不混，但可以多張應該是再填入 —— 開了直接填入一樣的事業體」）。
 *
 * ============================================================
 * 【★★ 只繼承「其他事業體」，不繼承物業】
 *
 * 兩者看起來都是「照抄上一項比較快」，但性質完全不同:
 *
 *   其他事業體 → 一張單只能有一本帳（misbookedItems ＋ pri_book_guard
 *                兩邊都擋）。所以新項目**只有這一個合法值**，
 *                填進去不是猜，是把唯一的答案先寫好。
 *
 *   物業       → 一張安幸的單可以一項正隆、一項時兆，那是常態。
 *                照抄的話會安靜地把第二項算到第一項的物業頭上 ——
 *                而金額、科目、備註全都對，只有物業錯，
 *                沒有任何一張報表會報錯。
 *
 * CLAUDE.md:「對不上的不猜。少填一個看得到、補得回來；
 * 填錯一個沒有人會發現。」物業就是「對不上」的那一種。
 */
export function newItemPurpose(
  items: { purpose_type?: string | null }[] | null | undefined,
): { purpose_type: string; estate_id: null; property_id: null } {
  const other = (items ?? []).some((i) => i.purpose_type === OTHER_BIZ_PURPOSE);
  return {
    purpose_type: other ? OTHER_BIZ_PURPOSE : 'estate',
    estate_id: null,
    property_id: null,
  };
}

/**
 * 這張單需不需要**主管那一票**（migration_160）。
 *
 * ============================================================
 * 【為什麼要有名字】（2026-08-25 使用者:「主管免核 但還有計算 2 筆耶」）
 *
 * 愛皮／洪鯊的單只要總經理一票。這條規則原本只寫在**畫面上**:
 *
 *     const skipMgr = isOtherBook(r.book);      // voteLine() 裡
 *
 * 而其他兩個地方沒有:
 *
 *   · 「待主管核可」那張卡  → 把免核的單也算進去,數字永遠降不到 0
 *   · 主管的「核可」按鈕    → 同一列寫著「主管（免核）」卻按得下去
 *
 * 兩個症狀都不會報錯。第一個更糟:那張卡是**待辦清單**，
 * 上面永遠掛著兩筆做不掉的事,看的人只會學會忽略它 ——
 * 然後真的有單在等的時候也一起忽略。
 *
 * ★ 一條規則三個地方用，就必須有名字。
 */
export const needsManagerVote = (book: string | null | undefined) => !isOtherBook(book);
