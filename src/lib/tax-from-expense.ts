/**
 * 支出 → 進項發票（純函式）。
 *
 * ============================================================
 * 【這一支在做什麼】（2026-09-05 使用者要求）
 *
 * 稅務管理的進項本來只能手 key。而那些發票的資料**支出頁上早就有了**
 * —— 日期、憑證號碼、品名、金額、物業。重打一次是白工，
 * 而且兩邊會不一致（打錯的那一邊沒有人會發現）。
 *
 * ============================================================
 * 【★★★ 這是預填，不是答案】
 *
 * `expenses` 沒有稅額欄、沒有未稅欄、也沒有賣方統編欄
 * （2026-09-05 查證，`information_schema` 三十個欄位裡一個都沒有）。
 * 所以稅額只能從含稅金額反推，而反推對**免稅**是錯的 ——
 * 房租、保險、薪資、國外服務沒有 5% 進項稅，反推照樣給它一個。
 *
 * 三層緩衝:
 *   ① 憑證號碼不合統一發票格式的 → 稅碼 `X`、稅額 0、**不預設勾**
 *   ② 帶入前每一列的稅額都可以改
 *   ③ `source` 存成 `'expense'`（migration_220）——
 *      之後查「這個數字哪來的」看得出是反推的
 *
 * ============================================================
 * 【★★ 只帶同一期的】（使用者指定：「支出轉入要在同月」）
 *
 * 期別是用 `spent_on` 算的，跟畫面上選的那一期不同就不列出來。
 *
 * 不擋的話會發生:9-10 月期的畫面上出現 7 月的支出，帶進來之後
 * 那筆進項掛在 9-10 月期 —— 而它應該在 7-8 月期申報。
 * 兩期的數字同時錯，而畫面上兩邊看起來都很正常。
 *
 * ============================================================
 * 【資料從哪來（mapping）】
 *
 *   發票日期  ← spent_on
 *   發票號碼  ← voucher_no      ★ 沒填的整筆不出現
 *   廠商      ← purchase_requests.payee_company（經 expenses.request_id）
 *   統編      ← purchase_requests.payee_tax_id  同上
 *   品名      ← item_name
 *   摘要      ← note
 *   物業/房源 ← estate_id / property_id
 *   總金額    ← amount（含稅）
 *   銷售額    ← round(amount ÷ 1.05)
 *   稅額      ← amount − 銷售額
 *   收支帳    ← 支出的 id
 */

// ★ 副檔名要寫出來 —— `node --experimental-strip-types` 不做副檔名解析
//   （`audit-orders.ts` 本來就這樣寫，照抄）
import { invoiceDateRange, type TaxPeriod } from './tax.ts';

/** 一筆支出（只取帶得過去的欄位）。 */
export type ExpenseSrc = {
  id: string;
  spent_on: string;
  item_name: string;
  /** ★ 含稅的實付金額（2026-09-05 使用者確認） */
  amount: number;
  voucher_no?: string | null;
  note?: string | null;
  estate_id?: string | null;
  property_id?: string | null;
  /** 從 `purchase_requests` 帶過來的廠商名（經 `request_id`）。沒接到就是 null */
  payee_company?: string | null;
  payee_tax_id?: string | null;
};

/** 要建出來的那一列進項發票。 */
export type InvoiceDraft = {
  kind: 'in';
  period: TaxPeriod;
  company_tax_id: string;
  category: string;
  tax_code: string;
  invoice_date: string;
  invoice_no: string;
  counterparty: string | null;
  counterparty_tax_id: string | null;
  item_name: string;
  summary: string | null;
  estate_id: string | null;
  property_id: string | null;
  net_amount: number;
  tax_amount: number;
  total_amount: number;
  voucher_ref: string | null;
  source: 'expense';
  expense_id: string;
  /** 畫面用:預設要不要勾起來。不寫進資料庫 */
  picked: boolean;
};

/**
 * 統一發票號碼的格式:**兩個英文字母 ＋ 八個數字**。
 *
 * ★ 不合格式的多半是收據、繳款單、廠商自己的單號
 *   （實際看到的:`免用統一收據`、`0346`、`S80516012`、`BB0G597056`）。
 *   那些不可扣抵 —— 但**不是全部**，所以列出來讓人自己判斷，
 *   只是不預設勾（2026-09-05 使用者選）。
 */
export const INVOICE_NO_RE = /^[A-Za-z]{2}[0-9]{8}$/;

export function looksLikeInvoice(no: string | null | undefined): boolean {
  return INVOICE_NO_RE.test((no ?? '').trim());
}

/**
 * 含稅金額拆成銷售額與稅額。
 *
 * ★★★ 稅額用**相減**算，不是 `round(net × 0.05)`。
 *   兩個各自四捨五入的話 net + tax 可能不等於 total，
 *   而資料庫的 `tax_invoice_amount_chk` 會擋下來 ——
 *   錯誤訊息是一句 SQL 例外，填表的人看不懂。
 *
 * 例:2100 → 2000 + 100；300 → 286 + 14；10500 → 10000 + 500。
 */
export function splitTax(gross: number): { net: number; tax: number; total: number } {
  const total = Math.round(Number(gross) || 0);
  if (total <= 0) return { net: total, tax: 0, total };
  const net = Math.round(total / 1.05);
  return { net, tax: total - net, total };
}

/**
 * 一筆支出 → 一列進項發票草稿。
 *
 * ★★ 不像統一發票的給稅碼 `X`（不可扣抵）、稅額 **0**、銷售額 = 總額。
 *   給它一個反推的稅額才危險 —— 那個數字看起來很正常，
 *   而它會進到 401 的進項稅額裡。
 *
 * ★ `tax_code` 是必填（`tax.ts` 的 `validate` 會擋「要選稅碼」），
 *   所以一定要給值，不能留空。
 */
export function toInvoiceDraft(
  e: ExpenseSrc, period: TaxPeriod, companyTaxId: string,
): InvoiceDraft {
  const ok = looksLikeInvoice(e.voucher_no);
  const { net, tax, total } = splitTax(e.amount);
  return {
    kind: 'in',
    period,
    company_tax_id: companyTaxId,
    // ★ 進項預設「費用」。成本要人自己改 —— 猜錯的話 401 的分類會錯
    category: '費用',
    tax_code: ok ? '25' : 'X',
    invoice_date: e.spent_on,
    invoice_no: (e.voucher_no ?? '').trim(),
    counterparty: (e.payee_company ?? '').trim() || null,
    counterparty_tax_id: (e.payee_tax_id ?? '').trim() || null,
    item_name: (e.item_name ?? '').trim(),
    summary: (e.note ?? '').trim() || null,
    estate_id: e.estate_id || null,
    property_id: e.property_id || null,
    net_amount: ok ? net : total,
    tax_amount: ok ? tax : 0,
    total_amount: total,
    voucher_ref: e.id,
    source: 'expense',
    expense_id: e.id,
    picked: ok,
  };
}

/**
 * 這一期可以帶入的支出 → 草稿清單。
 *
 * ★★ 三道過濾:
 *   ① 沒有憑證號碼的不出現 —— 沒有發票號碼就不是發票
 *   ② `spent_on` 不在**可補登的區間**內的不出現（見下）
 *   ③ 已經帶過的不出現（`takenIds`）——
 *      帶兩次的話進項稅額憑空多一份，而 401 上只顯示成「應繳比較少」。
 *      資料庫的 `tax_invoice_expense_uniq` 也擋，但那時已經按下去了。
 *
 * ============================================================
 * 【★★ 區間放寬到同年度】（2026-09-05 使用者改的）
 *
 * 原本是 `taxPeriodOf(spent_on) === period` —— **只有同一期**。
 * 現在跟手 key 那一側同一條規則:`invoiceDateRange(period, 'in')`，
 * 也就是**該年度 1/1 ～ 該期最後一天**。
 *
 * ★ 兩側用同一支函式算，不要各寫一次。
 *   不然會出現「手 key 填得進去、帶入卻看不到那一筆」——
 *   而使用者只會覺得系統漏了資料
 *   （CLAUDE.md:同一條規則在三個地方各寫一次）。
 *
 * ★★★ 帶進來的 `period` 是**畫面選的那一期**，不是從 `spent_on` 推的。
 *   補登就是這個意思:3 月的發票、申報在 11-12 月期。
 *   `toInvoiceDraft()` 收的就是傳進來的 period，不用另外處理。
 *
 * ★ 合格式的排前面 —— 那些是預設勾起來的，讓人一眼看完再往下捲。
 */
export function importable(
  rows: ExpenseSrc[], period: TaxPeriod, companyTaxId: string,
  takenIds: Iterable<string> = [],
): InvoiceDraft[] {
  const taken = new Set(takenIds);
  const [lo, hi] = invoiceDateRange(period, 'in');
  if (!lo || !hi) return [];
  return (rows ?? [])
    .filter((e) => (e.voucher_no ?? '').trim())
    .filter((e) => !taken.has(e.id))
    .filter((e) => e.spent_on >= lo && e.spent_on <= hi)
    .map((e) => toInvoiceDraft(e, period, companyTaxId))
    .sort((a, b) => Number(b.picked) - Number(a.picked)
      || a.invoice_date.localeCompare(b.invoice_date));
}

/** 勾起來的那幾筆。 */
export const pickedOf = (ds: InvoiceDraft[]) => (ds ?? []).filter((d) => d.picked);

/**
 * 按下「帶入」之前的檢查。`null` = 可以帶。
 *
 * ★★ 稅額大於總額、或是負的,資料庫的 `tax_invoice_amount_chk` 會擋 ——
 *   但它回的是一句 SQL 例外。這裡先擋是為了講出**是哪一筆**。
 */
export function importError(ds: InvoiceDraft[]): string | null {
  const picked = pickedOf(ds);
  if (!picked.length) return '先勾要帶入的項目';

  const bad = picked.filter((d) => d.tax_amount < 0 || d.tax_amount > d.total_amount);
  if (bad.length) {
    return `這 ${bad.length} 筆的稅額不合理（要在 0 與總金額之間）：`
      + bad.slice(0, 5).map((d) => d.item_name || '（沒填品名）').join('、');
  }
  const noNo = picked.filter((d) => !d.invoice_no);
  if (noNo.length) return `這 ${noNo.length} 筆沒有發票號碼，不能當進項發票`;
  return null;
}

/**
 * 帶入前的一行摘要。
 *
 * ★ 要講**稅額合計** —— 那是這個動作對 401 的實際影響，
 *   「帶入 12 筆」看不出來會讓應繳稅額少多少。
 */
export function importSummary(ds: InvoiceDraft[]): string {
  const picked = pickedOf(ds);
  const tax = picked.reduce((a, d) => a + (Number(d.tax_amount) || 0), 0);
  const total = picked.reduce((a, d) => a + (Number(d.total_amount) || 0), 0);
  return `已勾 ${picked.length} 筆・總金額 $${total.toLocaleString('en-US')}`
    + `・稅額合計 $${tax.toLocaleString('en-US')}`;
}

/** 寫進資料庫的那一份（拿掉畫面用的 `picked`）。 */
export function toRows(ds: InvoiceDraft[]): Omit<InvoiceDraft, 'picked'>[] {
  return pickedOf(ds).map(({ picked, ...rest }) => rest);
}
