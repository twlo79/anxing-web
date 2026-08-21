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


/* ══════════════════════════════════════════════════════════
 * 以下是**真正的修法**（migration_155，2026-08-21 使用者拍板）
 *
 * 憑證號碼下放到每個請款項目。整張單只有一張發票時，
 * 勾「共同憑證」改用單張層級的那一個。
 *
 * 上面那兩支（voucherBrief / isMultiVoucher）是 8/19 的止血，
 * 純顯示用。舊單全部是共同憑證，那串頓號串起來的號碼還在，
 * 所以截斷邏輯**不能拿掉**。
 * ══════════════════════════════════════════════════════════ */

/** 一個項目的憑證欄位。 */
export type ItemVoucher = {
  voucher_no?: string | null;
  no_voucher?: boolean | null;
};

/** 請款單層級的憑證欄位。 */
export type ReqVoucher = ItemVoucher & {
  /** true = 整張單共用 voucher_no。既有的 59 張全部是 true。 */
  shared_voucher?: boolean | null;
};

/** 一個項目最後算是什麼狀態。 */
export type VoucherState =
  | { kind: 'shared'; no: string }      // 共同憑證，有號碼
  | { kind: 'shared-none' }             // 共同憑證，整張單註記無憑證
  | { kind: 'item'; no: string }        // 這項自己的號碼
  | { kind: 'item-none' }               // 這項確定沒有單據
  | { kind: 'blank' };                  // 還沒填

const clean = (s: string | null | undefined) => (s ?? '').trim();

/**
 * 這個項目實際套用哪個憑證。
 *
 * ★ 判斷順序是**先看共同憑證的開關**，不是先看誰有填。
 *
 *   反過來寫（誰有填就用誰）會出現這種事:勾了共同憑證，
 *   但某一項底下還留著上次填的舊號碼 —— 於是那一項用舊號碼、
 *   其他項用共同號碼。**畫面上完全看不出來**，因為兩邊都顯示得出東西。
 *
 *   使用者指定的是「留著但不使用（灰掉）」—— 不使用就是不使用，
 *   不管它有沒有值。
 */
export function resolveVoucher(req: ReqVoucher, item: ItemVoucher): VoucherState {
  if (req.shared_voucher) {
    const no = clean(req.voucher_no);
    if (no) return { kind: 'shared', no };
    if (req.no_voucher) return { kind: 'shared-none' };
    return { kind: 'blank' };
  }
  const no = clean(item.voucher_no);
  if (no) return { kind: 'item', no };
  if (item.no_voucher) return { kind: 'item-none' };
  return { kind: 'blank' };
}

/**
 * 顯示用的一句話。
 *
 * ★「無憑證」與「—」必須長得不一樣。
 *   前者是有人查過、確定沒有單據;後者是沒有人碰過。
 *   兩個都印成空白的話，對帳的人不知道該不該去追
 *   （2026-08-19 使用者問過「有兩種顯示，要怎麼整合」——
 *    答案是**不整合**，那本來就是兩件事）。
 */
export function voucherText(st: VoucherState): string {
  switch (st.kind) {
    case 'shared':      return st.no;
    case 'item':        return st.no;
    case 'shared-none':
    case 'item-none':   return '無憑證';
    case 'blank':       return '—';
  }
}

/** 共同憑證勾起來時，項目的憑證欄要灰掉（內容留著，只是不能改也不算數）。 */
export const itemVoucherDisabled = (req: ReqVoucher) => !!req.shared_voucher;

/**
 * 送審前檢查:有沒有項目的憑證是空的。
 *
 * ★ 回傳的是**還沒填的項目名稱**，不是一句「有項目沒填」。
 *   十七個項目的單子上，「有項目沒填」這句話等於沒說 ——
 *   使用者得自己一個一個找，而找的過程中很容易就放棄了。
 *
 * ★ 這支**不擋送審**（憑證選填，使用者 8/19 指定）。
 *   它只負責讓人看見。系統負責看見，人負責決定。
 */
export function missingVouchers(
  req: ReqVoucher,
  items: (ItemVoucher & { item_name?: string | null })[],
): string[] {
  if (req.shared_voucher) {
    const has = !!clean(req.voucher_no) || !!req.no_voucher;
    return has ? [] : ['整張單的共同憑證'];
  }
  return items
    .filter((i) => resolveVoucher(req, i).kind === 'blank')
    .map((i, n) => clean(i.item_name) || `第 ${n + 1} 項`);
}

/**
 * 摘要:這張單的憑證填得怎麼樣。給列表的那一格用。
 *
 * 共同憑證沿用舊的截斷邏輯（舊單的號碼還是一長串）;
 * 逐項則報「幾項有、共幾項」—— 列表上塞不下十七個號碼，
 * 而「3 / 17」一眼就看得出還缺很多。
 */
export function voucherSummary(
  req: ReqVoucher,
  items: ItemVoucher[],
): { text: string; full: string; warn: boolean } {
  if (req.shared_voucher) {
    const b = voucherBrief(req.voucher_no);
    if (b) return { text: b.more ? `${b.text} +${b.more}` : b.text, full: b.full, warn: false };
    if (req.no_voucher) return { text: '無憑證', full: '無憑證', warn: false };
    return { text: '—', full: '', warn: true };
  }
  const total = items.length;
  const done = items.filter((i) => resolveVoucher(req, i).kind !== 'blank').length;
  if (total === 0) return { text: '—', full: '', warn: true };
  if (done === total) return { text: `逐項 ${total}`, full: `每項都填了（共 ${total} 項）`, warn: false };
  return { text: `${done} / ${total}`, full: `${total} 項裡有 ${total - done} 項還沒填`, warn: true };
}
