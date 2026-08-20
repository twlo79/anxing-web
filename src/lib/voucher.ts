/**
 * 憑證號碼的顯示。**只截斷，不改資料。**
 *
 * ============================================================
 * 【為什麼會有一長串】（2026-08-19）
 *
 * 憑證號碼是**請款單層級**的一個欄位，而一張請款單可以有十幾個項目。
 * 十七張不同的收據沒有地方各自放，填單的人就把號碼用頓號串成一串
 * 塞進那一格 —— 而 `gen_expenses_from_pr` 會把整串原封不動複製給
 * **每一筆**產生出來的支出（那支觸發器裡還寫著「同一張發票本來就
 * 對應多個項目」，那個假設在多張發票時就不成立了）。
 *
 * 結果是計程車車資那筆的憑證號碼裡，混著差旅住宿的發票號。
 *
 * ★ 這支**只修顯示**（2026-08-19 使用者選 B）。**資料還是錯的** ——
 *   真正的修法是把憑證號碼下放到 `purchase_request_items`，
 *   那要動 migration、觸發器與填單介面，排到之後做。
 *
 *   所以截斷之後一定要留「＋N 個」的提示 ——
 *   直接切掉的話，看的人會以為那筆真的只有一個號碼，
 *   而那比現在這串亂碼更容易讓人做出錯的判斷。
 *
 * ============================================================
 * 【為什麼寫在 .ts 不是 .tsx】
 * 測試環境不處理 JSX。而且 Next.js 的頁面檔不能 export 任意東西 ——
 * 放在頁面裡連 build 都過不了。
 */

export type VoucherBrief = {
  /** 前幾個號碼，用頓號串起來。 */
  text: string;
  /** 還有幾個沒顯示。0 表示全部都在 text 裡。 */
  more: number;
  /** 完整字串，給 title 與抽屜用。 */
  full: string;
};

/**
 * 拆解並截斷。回 null 表示這一格沒有號碼
 * （呼叫端自己決定要顯示「無憑證」還是「未填」——那是兩件事）。
 *
 * 分隔號認三種:頓號、半形逗號、全形逗號。
 * 填單的人三種都打過，只認一種的話會把整串當成一個號碼。
 */
export function voucherBrief(no: string | null | undefined, keep = 2): VoucherBrief | null {
  const parts = (no ?? '')
    .split(/[、,，]/)
    .map((x) => x.trim())
    .filter(Boolean);
  if (parts.length === 0) return null;
  const full = parts.join('、');
  if (parts.length <= keep) return { text: full, more: 0, full };
  return { text: parts.slice(0, keep).join('、'), more: parts.length - keep, full };
}

/** 這串號碼是不是多筆混在一起 —— 抽屜要不要加那句來源說明看它。 */
export const isMultiVoucher = (no: string | null | undefined) =>
  (voucherBrief(no)?.more ?? 0) > 0;
