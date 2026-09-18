import { OTHER_BOOKS } from './book.ts';

/**
 * 營收頁「來源」下拉的篩選規則。
 *
 * ══════════════════════════════════════════════════════════
 * 【使用者 2026-09-18】「來源要多 房務清潔 人事費」
 *
 * ══════════════════════════════════════════════════════════
 * 【★★★ 這兩個不是真的「來源」，是科目】
 *
 * 房務收入寫進 `orders` 時是:
 *
 *     source   = 'oneoff'          ← 來源:其他收入
 *     fee_type = '房務清潔' / '人事費'   ← 會計科目
 *
 * 所以它們在來源那一欄底下是**同一種**，差別在科目。
 * 下拉裡多這兩項＝「其他收入裡面，只看這一類」。
 *
 * ★ 為什麼**不**給它們各自一個真的 source 值（`hk_clean` 之類）:
 *   `source === 'oneoff'` 這個判斷散在 12 支檔案裡（營收報表的分段、
 *   Excel 匯出的每一段小計、期間合計、訂單自檢…）。改資料的話
 *   **漏改一處，那幾筆就從「其他收入」那一段消失而且不會叫** ——
 *   總額少一塊，而畫面上完全正常
 *   （CLAUDE.md:同一條規則寫在好幾個地方，2026-09-01 踩過）。
 *
 * ★★ 所以資料一個字不改，只多兩個篩選條件。清單上那一列的籤
 *   仍然是「其他收入・房務清潔 A02」—— 它同時講了來源與科目，
 *   兩件事都看得到。
 *
 * ══════════════════════════════════════════════════════════
 * 【★★ 為什麼這幾行要在 `.ts` 而不是寫在頁面裡】
 *
 * 「選了這一項會看到哪幾筆」是判斷式,測試環境不處理 JSX ——
 * 寫在 `.tsx` 裡的話**測不到**（CLAUDE.md）。
 * ══════════════════════════════════════════════════════════
 */

/**
 * 科目型選項的值前綴。
 *
 * ★★★ 真的 source 值（airbnb / agoda / private / longterm /
 *   office / company / oneoff / other）沒有一個長這樣 ——
 *   底下的測試會釘住這件事。
 *   前綴撞到的話，選了「房務清潔」會篩出別的東西，
 *   而畫面上只是筆數不對，沒有任何地方會叫
 *   （CLAUDE.md:兩個格式不同的字串拿去比對，2026-09-02 踩過）。
 */
export const SRC_FEE_PREFIX = 'fee:';

/** 這一批收入的 source 值。★ 跟 `revenue-report.ts` 的 ONEOFF 是同一個。 */
export const ONEOFF_SOURCE = 'oneoff';

/**
 * 「其他收入」底下要單獨列出來的科目。
 *
 * ★ 要再多一個（例如「管理費」）就加在這裡，畫面不用改。
 * ★★ 字串要跟寫進 `orders.fee_type` 的**一模一樣** ——
 *   房務那邊寫的是 `fee_type: r.account_code === CODE_LABOR_REV ? '人事費' : '房務清潔'`
 *   （housekeeping/stats-tab-1.tsx）。
 */
export const ONEOFF_FEE_SOURCES = ['房務清潔', '人事費'] as const;

/** 科目 → 下拉的值。 */
export const feeSourceValue = (feeType: string): string => SRC_FEE_PREFIX + feeType;

/** 下拉的值 → 科目。不是科目型的回 null。 */
export function feeSourceOf(v: string | null | undefined): string | null {
  const s = String(v ?? '');
  return s.startsWith(SRC_FEE_PREFIX) ? s.slice(SRC_FEE_PREFIX.length) : null;
}

/** 一列要不要留下來。空的篩選條件＝全部都留。 */
export function sourceMatches(
  filter: string | null | undefined,
  r: { source?: string | null; fee_type?: string | null },
): boolean {
  const f = String(filter ?? '');
  if (!f) return true;

  const fee = feeSourceOf(f);
  if (fee !== null) {
    /*
     * ★★ 兩個條件都要:科目對、而且來源是其他收入。
     *   只比科目的話，將來別的來源也用了同一個科目就會混進來 ——
     *   而這一項在畫面上掛在「其他收入」底下，混進來的那幾筆
     *   使用者找不到理由。
     */
    return r.source === ONEOFF_SOURCE && (r.fee_type ?? '') === fee;
  }
  return (r.source ?? '') === f;
}

/** 篩選中的說明文字（空字串＝沒篩，畫面上不顯示）。 */
export function sourceFilterLabel(
  filter: string | null | undefined,
  label: (source: string) => string,
): string {
  const f = String(filter ?? '');
  if (!f) return '';
  const fee = feeSourceOf(f);
  return fee !== null ? fee : (label(f) || f);
}

/* ══════════════════════════════════════════════════════════
 * 營收表只算安幸（2026-09-18 使用者:「不要有其他」「營收表只算安幸 營收」）
 * ══════════════════════════════════════════════════════════
 *
 * 【★★★ 為什麼要有這一支】
 *
 * 愛皮（旅行社）與洪鯊（投資公司）的收入原本也在營收表裡，
 * 來源那一欄叫「其他」。但那張表是**包租代管的營收** ——
 * 把旅行社的團費加進去，當期營收總額就不是這門生意的數字。
 *
 * ★ 那兩家的帳在**其他收支帳**（`/otherbooks`）那一頁，
 *   不是拿掉不看，是各自看各自的。
 *
 * 【★★ 為什麼兩個值都擋】
 *
 * 程式碼裡有兩個同名的常數，值不一樣:
 *
 *     lib/revenue-report.ts   OTHER_BIZ_SOURCE = 'other'
 *     lib/book.ts             OTHER_BIZ_SOURCE = 'other_biz'   ← 寫入那一側
 *
 * 哪一個是實際存進 `orders.source` 的,我沒有去查就寫了會是猜
 * （CLAUDE.md:對不上的不猜）。**兩個都擋**是唯一不會漏的做法 ——
 * 漏掉的那一種會讓幾筆非安幸的錢留在總額裡，
 * 而畫面上只是「總額比預期多一點」，沒有任何地方會叫。
 *
 * 【★ 帳本欄位是第二道，不是第一道】
 *
 * 營收的列是從認列的 view 出來的，**不一定帶 `book`**。
 * 所以主判斷走 `source`;`book` 有值而且不是安幸時再擋一次。
 * `toBook()` 把不認得的值（含 null）一律當安幸 ——
 * 「不要讓一筆錢因為值怪掉就從所有報表上消失」（book.ts）。
 */

/** 不是安幸的那幾種來源。★ 兩個都要 —— 見上面的說明。 */
export const NON_ANXING_SOURCES = ['other', 'other_biz'] as const;

/** 這一列算不算安幸的營收。 */
export function isAnxingRevenue(
  r: { source?: string | null; book?: string | null },
): boolean {
  const src = String(r.source ?? '');
  if ((NON_ANXING_SOURCES as readonly string[]).includes(src)) return false;
  /*
   * ★ 第二道。`OTHER_BOOKS` 是 ['aipi','hongsha']（lib/book.ts，全站唯一一份）——
   *   在這裡寫死兩個字串的話，哪天多一家就會漏掉這一頁。
   * ★★ 沒有 `book` 這一欄、或值不認得，一律留著。少算一筆
   *   沒有人會發現（book.ts:不要讓一筆錢因為值怪掉就從所有報表上消失）。
   */
  if ((OTHER_BOOKS as readonly string[]).includes(String(r.book ?? ''))) return false;
  return true;
}
