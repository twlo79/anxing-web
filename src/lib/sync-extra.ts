/**
 * 同步差異的「爬蟲爬到什麼」明細。
 *
 * ============================================================
 * 【為什麼】（2026-08-24 使用者指定）
 *
 * 「對不到房源」那一列現在只顯示:
 *
 *     （無房源）listing 39687807 ── 1 筆訂單沒有進來
 *
 * 使用者:「爬進來要給更多細節，而非只是一筆訂單」
 *         「沒 match 說爬到什麼 —— 名稱、listing id、日期起訖」
 *
 * 他要判斷「這是哪一間房」，而畫面給的只有一個八位數字。
 * 要拿那個數字回 Airbnb 後台查，才知道該把它掛到哪一間房上。
 *
 *
 * ============================================================
 * 【為什麼是「有什麼顯示什麼」，不是寫死欄位】
 *
 * 那筆訂單**根本沒進資料庫**（那正是這個差異在講的事），
 * 所以細節只可能在 `sync_issues.extra` 這個 jsonb 裡 ——
 * 而那是爬蟲寫的，爬蟲不在這個 repo。
 *
 * 寫死 `extra['listing名稱']`、`extra['入住日']` 這種鍵名的話:
 *
 *   · 猜對了 → 好
 *   · 猜錯了 → **畫面一片空白，而且沒有任何線索說明為什麼**
 *
 * 第二種正是這個專案最常見的壞法。所以改成把 extra 裡的
 * 每一個鍵值對都列出來 —— 爬蟲塞什麼就看到什麼，
 * 補了新欄位也不用再改前端。
 *
 * 【為什麼寫在 .ts 不是 .tsx】
 * 測試環境不處理 JSX，寫在元件裡的判斷式測不到。
 */

/**
 * 已經在畫面上**單獨顯示過**的鍵，不要重複列一次。
 *
 * ★ 這份清單要跟 admin/page.tsx 的渲染同步維護。
 *   漏掉的症狀是同一個值出現兩次 —— 不嚴重，但會讓人以為是兩件事。
 */
const ALREADY_SHOWN = new Set(['停用對照']);

export type ExtraDetail = { label: string; value: string };

/** jsonb 的值攤成一行字。物件與陣列也要看得到 —— 看不到就等於沒存。 */
function toText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? '是' : '否';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return v.trim();
  if (Array.isArray(v)) return v.map(toText).filter(Boolean).join('、');
  /*
   * ★ 巢狀物件用 JSON 印出來，不要顯示 [object Object]。
   *   醜，但**看得到內容**。而 [object Object] 是純粹的雜訊 ——
   *   它同時告訴你「這裡有東西」跟「你不能知道是什麼」。
   */
  try { return JSON.stringify(v); } catch { return ''; }
}

/**
 * 把 extra 攤成可以直接印的清單。
 *
 * ★ 空值整個丟掉。印一個「入住日：—」出來的話，
 *   跟「爬蟲有抓到但抓到空的」長得一樣，
 *   而那兩件事要做的處理完全不同。
 */
export function extraDetails(extra: Record<string, unknown> | null | undefined): ExtraDetail[] {
  if (!extra || typeof extra !== 'object') return [];
  const out: ExtraDetail[] = [];
  for (const [k, v] of Object.entries(extra)) {
    if (ALREADY_SHOWN.has(k)) continue;
    const value = toText(v);
    if (!value) continue;
    out.push({ label: k, value });
  }
  return out;
}

/**
 * 這一列有沒有「爬到什麼」可以顯示。
 *
 * ★ 分成一支是為了讓畫面可以在**沒有細節時說一句話**，
 *   而不是留白:
 *
 *       「爬蟲沒有留下這筆的細節 —— 要補的話請改爬蟲那邊。」
 *
 *   留白的話，看的人會以為畫面壞了，或以為爬蟲根本沒抓到東西。
 *   「沒有資料」與「有資料但沒顯示」必須分得開。
 */
export function hasExtraDetails(extra: Record<string, unknown> | null | undefined): boolean {
  return extraDetails(extra).length > 0;
}

/**
 * 這一類差異需不需要「爬蟲爬到什麼」的細節。
 *
 * ============================================================
 * 【為什麼要一支函式，不直接在 JSX 裡比字串】（2026-08-24）
 *
 * 我第一版寫的是:
 *
 *     if (it.code === '對不到房源' || it.kind === '房源') { … }
 *
 * 而畫面上那個紅標籤是 **`it.field`**，不是 `code`。
 * 條件永遠不成立，所以那句提示一次都沒出現過 ——
 * 使用者連按三次重新整理，畫面一模一樣。
 *
 * 更糟的是我在這個檔案的檔頭寫著:
 *
 *     「猜錯了 → 畫面一片空白，而且沒有任何線索說明為什麼」
 *
 * 然後在隔壁的條件式裡犯了一模一樣的錯。
 *
 * 抽成函式的理由:**寫在 .tsx 裡的判斷式測不到**（測試環境不處理 JSX）。
 * 抽出來之後，「哪幾種 field 需要細節」這件事至少有測試守著，
 * 改錯了會紅，不會安靜地什麼都不顯示。
 *
 *
 * ============================================================
 * 【為什麼只有這幾種】
 *
 * 其他類別（金額、住宿起訖）在 `from_val` / `to_val` 就看得到
 * 「現在是什麼、爬蟲認為是什麼」—— 那已經夠判斷了。
 *
 * 只有房源對不到這一類，那筆訂單**根本沒進資料庫**，
 * 畫面上除了一個八位數字之外什麼都沒有。
 */
const NEEDS_DETAIL = new Set(['對不到房源', '房源', '房源名稱查不到']);

/**
 * @param field `sync_issues.field` —— **畫面上那個紅標籤就是這一欄**
 *              （admin/page.tsx 的 `ISSUE_ADVICE[field]` 也是用它）
 */
export function needsCrawlerDetail(field: string | null | undefined): boolean {
  return !!field && NEEDS_DETAIL.has(field);
}
