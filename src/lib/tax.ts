/**
 * 營業稅（純函式）。
 *
 * ============================================================
 * 【這是什麼】（2026-09-04 使用者:「多一個稅務管理」）
 *
 * 每兩個月申報一次營業稅。這一支管四件事:
 *
 *   1. 期別      雙月，起月一定是奇數（1-2、3-4、5-6、7-8、9-10、11-12）
 *   2. 作廢      作廢的發票不算進申報數，但**列要留著**
 *   3. 結算      照 401 申報書的順序算「應繳」或「累積留抵」
 *   4. 留抵結轉  這一期的留抵 = 下一期的「上期留抵」
 *
 * ★ 只做安幸（統編 83684417）。愛皮那家先不做，但欄位留著。
 */

/* ============================================================
 * 期別
 * ============================================================ */

/**
 * 期別的儲存格式:**該期第一個月**的 `YYYYMM`。
 *
 * ★ 跟 `src/lib/period.ts` 的 `Ym` 同一種六碼格式（無連字號）——
 *   全站已經有一個 'YYYYMM' 的約定，稅務不要另外發明一種
 *   （2026-08-05 那次 '202608' vs '2026-08' 的營收顯示 0 就是這樣來的）。
 *
 * ★★ 用**起月**不是「第幾期」。第幾期要配年份才有意義，
 *   而起月自己就帶著年份，排序也天然正確。
 */
export type TaxPeriod = string;

/** 一期含幾個月。營業稅一律雙月。 */
export const PERIOD_MONTHS = 2;

/**
 * 這個日期落在哪一期。
 *
 * ★★★ 起月一定是奇數 —— 8 月屬於「7-8 月期」，起月是 7。
 *   直接用 `date.slice(0,7)` 的話 8 月會變成「8-9 月期」，那個期別不存在。
 */
export function taxPeriodOf(dateStr: string): TaxPeriod {
  if (!/^\d{4}-\d{2}/.test(dateStr ?? '')) return '';
  const y = dateStr.slice(0, 4);
  const m = Number(dateStr.slice(5, 7));
  if (m < 1 || m > 12) return '';
  // 1,2→1  3,4→3  5,6→5 ⋯ 偶數月往前退一個月
  const start = m % 2 === 1 ? m : m - 1;
  return y + String(start).padStart(2, '0');
}

/** 期別 → 起訖日 `['2026-07-01', '2026-08-31']`。 */
export function periodRange(p: TaxPeriod): [string, string] {
  if (!/^\d{6}$/.test(p ?? '')) return ['', ''];
  const y = Number(p.slice(0, 4));
  const m = Number(p.slice(4, 6));
  if (m < 1 || m > 12) return ['', ''];
  const from = `${y}-${String(m).padStart(2, '0')}-01`;
  // ★ `new Date(y, m+1, 0)` 的第三個參數給 0 = 上個月最後一天，
  //   所以月份給「該期最後一個月的下一個月」就拿到期末。大小月與閏年都不用自己判斷
  const end = new Date(Date.UTC(y, m + 1, 0));
  return [from, end.toISOString().slice(0, 10)];
}

/**
 * 期別 → 畫面上的字。`'202607'` → `'115年7-8月期'`。
 *
 * ★ 民國年 = 西元 − 1911。報稅的東西一律用民國 —— 財政部的檔案、
 *   會計師的表都是民國，畫面上寫西元會對不起來。
 */
export function periodLabel(p: TaxPeriod): string {
  if (!/^\d{6}$/.test(p ?? '')) return '';
  const y = Number(p.slice(0, 4)) - 1911;
  const m = Number(p.slice(4, 6));
  if (m < 1 || m > 12) return '';
  return `${y}年${m}-${m + 1}月期`;
}

/** 上一期。`'202601'` → `'202511'`（跨年）。 */
export function prevPeriod(p: TaxPeriod): TaxPeriod {
  if (!/^\d{6}$/.test(p ?? '')) return '';
  const y = Number(p.slice(0, 4));
  const m = Number(p.slice(4, 6));
  return m <= 1 ? `${y - 1}11` : y + String(m - 2).padStart(2, '0');
}

/** 下一期。`'202611'` → `'202701'`（跨年）。 */
export function nextPeriod(p: TaxPeriod): TaxPeriod {
  if (!/^\d{6}$/.test(p ?? '')) return '';
  const y = Number(p.slice(0, 4));
  const m = Number(p.slice(4, 6));
  return m >= 11 ? `${y + 1}01` : y + String(m + 2).padStart(2, '0');
}

/** 最近 n 期（由新到舊），含 `from` 那一期。 */
export function recentPeriods(from: TaxPeriod, n: number): TaxPeriod[] {
  const out: TaxPeriod[] = [];
  let cur = from;
  for (let i = 0; i < n && cur; i++) { out.push(cur); cur = prevPeriod(cur); }
  return out;
}

/**
 * 期別下拉的選項:**未來幾期 ＋ 這一期 ＋ 過去幾期**，由新到舊。
 *
 * ============================================================
 * 【★★★ 為什麼要有未來的期別】（2026-09-05 使用者:「下下一期 11月甚麼時候出現」）
 *
 * 原本只列 `recentPeriods()` —— 那是**只往回數**的，
 * 所以今天（9-10 月期）在的話，11-12 月期根本不在下拉裡。
 *
 * 而發票是**隨時開的**:9 月就可能開出 11 月才要申報的發票，
 * 那時候使用者選不到那一期，只能先擺著或選錯期。
 *
 * ★ 未來只放兩期。放太多的話下拉最上面全是空的期別，
 *   而人是從上往下讀的 —— 第一眼看到的應該是「現在這一期」。
 *
 * ★★ 已經在資料庫裡的期別由呼叫端另外併進來
 *   （結算過的舊期可能比 `back` 還早）。
 */
export function periodOptions(
  now: TaxPeriod, back = 12, forward = 2,
): TaxPeriod[] {
  const out: TaxPeriod[] = [];
  let f = now;
  for (let i = 0; i < forward && f; i++) { f = nextPeriod(f); if (f) out.push(f); }
  out.reverse();                              // 未來的也要由新到舊
  return [...out, ...recentPeriods(now, back)];
}


/* ============================================================
 * 下拉選項（照舊 Excel 的「清單」分頁）
 * ============================================================ */

/** 類型。`-*` 與 `-X` 是會計師那邊的記號，原樣保留。 */
export const TAX_CATEGORIES = [
  '收入', '成本', '成本-*', '費用', '費用-*', '費用-X', '費用-X*',
] as const;

/**
 * 稅碼。`'X'` 是不可扣抵。
 *
 * ★ 存成 text 不是 int —— 因為有一個 `'X'`。
 *   存 int 再拿 -1 代表 X 的話，那個 -1 遲早會被當成金額或筆數
 */
export const TAX_CODES = ['21', '22', '23', '24', '25', '28', 'X'] as const;

/** 稅碼的說明。畫面上下拉旁邊顯示，不然沒有人記得 21 跟 25 差在哪。 */
export const TAX_CODE_HINT: Record<string, string> = {
  '21': '三聯式／電子計算機統一發票',
  '22': '二聯式收銀機統一發票、載有稅額之其他憑證',
  '23': '稅碼 21／25 的折讓單',
  '24': '稅碼 22 的折讓單',
  '25': '三聯式收銀機統一發票、一般稅額計算之電子發票',
  '28': '海關代徵進口營業稅繳納證',
  'X': '不可扣抵',
};

/** 品名。照舊 Excel 的清單，去掉重複的「捐贈」。 */
export const TAX_ITEM_NAMES = [
  '租金', '停車費', '油資', '印刷品', '投放廣告', '扣繳繳款書', 'eTag儲值',
  '雜項', '匯費', '健保費', '電話器材', '文具用品', '運費', '押金利息',
  '計程車車資', '修繕費', '車位租金', '移機服務費', '雲主機', '增設平板燈',
  '短影片製作', '維修服務費', '電腦週邊', '刊物廣告收入', '人資廣告-一模組(31天)',
  'Google Ads', '影片剪輯後製服務', 'LINE Ads Platform', '網路廣告費',
  'TG影印收入', '餐費', '郵資', '拜拜用品', '管理費', '檢驗費', '稅捐',
  '使用牌照稅', '罰單', '捐贈', '電極片', '家具出售',
] as const;


/* ============================================================
 * 發票
 * ============================================================ */

/** 進項或銷項。★ 進項銷項同一張表、同一組欄位（使用者:「請統一規格」）。 */
export type TaxKind = 'in' | 'out';

export type TaxInvoice = {
  id?: string;
  period: TaxPeriod;
  kind: TaxKind;
  category?: string | null;
  tax_code?: string | null;
  invoice_date: string;
  invoice_no: string;
  /** 銷項是買方、進項是廠商。同一欄 —— 兩邊都是「對方是誰」 */
  counterparty?: string | null;
  counterparty_tax_id?: string | null;
  summary?: string | null;
  item_name?: string | null;
  estate_id?: string | null;
  property_id?: string | null;
  net_amount: number;
  tax_amount: number;
  total_amount: number;
  voucher_ref?: string | null;
  note?: string | null;
  /**
   * ★★★ 作廢。作廢的**不算進申報數，但列要留著** ——
   *   刪掉就對不回財政部的檔，而發票號碼是連號的，中間少一號會被問。
   */
  voided?: boolean;
  /** 'upload' = 從發票 excel 匯入、'manual' = 手 key */
  source?: 'upload' | 'manual';
};

/**
 * 算得數的那些（濾掉作廢）。
 *
 * ★★★ 每一個加總都要先過這一支。少過一次，那一次的合計就會多算作廢的金額 ——
 *   而畫面上只是一個「比較大」的數字，沒有任何地方會叫。
 *   （2026-09-04 這份檔案 46 張裡有 3 張作廢，稅額差 21,429）
 */
export const activeInvoices = <T extends { voided?: boolean }>(rows: T[]): T[] =>
  (rows ?? []).filter((r) => !r.voided);

/** 稅額合計。★ 一律先濾作廢。 */
export const sumTax = (rows: TaxInvoice[]): number =>
  activeInvoices(rows).reduce((a, r) => a + (Number(r.tax_amount) || 0), 0);

/** 銷售額合計。★ 一律先濾作廢。 */
export const sumNet = (rows: TaxInvoice[]): number =>
  activeInvoices(rows).reduce((a, r) => a + (Number(r.net_amount) || 0), 0);

/** 總金額合計。★ 一律先濾作廢。 */
export const sumTotal = (rows: TaxInvoice[]): number =>
  activeInvoices(rows).reduce((a, r) => a + (Number(r.total_amount) || 0), 0);

/** 全部 / 有效 / 作廢 三個數字。畫面上那三顆標籤。 */
export function invoiceCounts(rows: TaxInvoice[]) {
  const all = (rows ?? []).length;
  const voided = (rows ?? []).filter((r) => r.voided).length;
  return { all, active: all - voided, voided };
}


/* ============================================================
 * 結算
 * ============================================================ */

export type Settlement = {
  outTax: number;
  inTax: number;
  carryIn: number;
  /** 本期應繳。★ 沒有要繳時是 **0**，畫面上顯示「—」 */
  payable: number;
  /** 本期累積留抵，結轉下一期 */
  carryOut: number;
};

/**
 * 照 401 申報書的順序結算。
 *
 * ============================================================
 * 【公式】
 *
 *     銷項稅額 − 進項稅額 − 上期累積留抵
 *       > 0  →  本期應繳稅額，累積留抵歸 0
 *       ≤ 0  →  本期累積留抵 = 那個數的絕對值，應繳 0
 *
 * ★★★ 兩個結果**只會有一個有值**。同時印兩個數字會讓人以為
 *   既要繳錢又有留抵 —— 而那兩件事互斥。畫面上另一個顯示「—」。
 *
 * ★★ 四捨五入到元。營業稅申報只到元，留小數會在跨期結轉時越滾越歪。
 */
export function settle(
  outTax: number, inTax: number, carryIn: number,
): Settlement {
  const o = Math.round(Number(outTax) || 0);
  const i = Math.round(Number(inTax) || 0);
  const c = Math.round(Number(carryIn) || 0);
  const net = o - i - c;
  return {
    outTax: o, inTax: i, carryIn: c,
    payable: net > 0 ? net : 0,
    /*
     * ★ 寫 `net < 0 ? -net : 0` 不是 `net > 0 ? 0 : -net`。
     *   後者在 net 剛好是 0 時得到 **-0** —— `Object.is(-0, 0)` 是 false，
     *   而 `(-0).toLocaleString()` 在部分環境印成「-0」。
     *   剛好打平的那一期畫面上會出現一個負零（2026-09-04 測試抓到）。
     */
    carryOut: net < 0 ? -net : 0,
  };
}

export type PeriodRow = {
  period: TaxPeriod;
  status: 'open' | 'closed';
  carry_in: number;
  /** 結算時凍結的。未結算時是 null —— 那時候要即時算 */
  out_tax?: number | null;
  in_tax?: number | null;
  payable?: number | null;
  carry_out?: number | null;
  closed_at?: string | null;
};

/**
 * 這一期該顯示什麼數字。
 *
 * ============================================================
 * 【★★★ 已結算的讀凍結值，未結算的即時算】
 *
 * 結算＝把當初申報的數字凍起來。之後有人補一筆七月的發票，
 * **已申報的數字不能跟著變** —— 申報書已經送出去了。
 *
 * 不凍結的話，三個月後回頭看那一期，數字跟當初申報的不一樣，
 * 而你分不出是「有人補登」還是「當初就算錯」。
 *
 * ★ 這是刻意讓推導值變成欄位（CLAUDE.md 那條在警告的形狀）——
 *   差別是它存的不是「現在算出來的數」，是「當初申報的數」。
 *   那兩個本來就是不同的東西。
 */
export function periodFigures(
  row: PeriodRow, liveOutTax: number, liveInTax: number,
): Settlement & { frozen: boolean } {
  if (row.status === 'closed' && row.out_tax != null) {
    return {
      outTax: Number(row.out_tax) || 0,
      inTax: Number(row.in_tax) || 0,
      carryIn: Number(row.carry_in) || 0,
      payable: Number(row.payable) || 0,
      carryOut: Number(row.carry_out) || 0,
      frozen: true,
    };
  }
  return { ...settle(liveOutTax, liveInTax, row.carry_in), frozen: false };
}

/**
 * 留抵鏈有沒有斷 —— 每一期的「上期留抵」要等於上一期的「累積留抵」。
 *
 * ★★ 回傳斷掉的那幾期。對不上就是資料壞了，而**畫面上只是一個
 *   看起來很正常的數字** —— 這一支是唯一會叫的地方。
 *
 * @param rows 依期別由舊到新
 */
export function carryChainBreaks(rows: PeriodRow[]): {
  period: TaxPeriod; expected: number; actual: number;
}[] {
  const out: { period: TaxPeriod; expected: number; actual: number }[] = [];
  const sorted = [...(rows ?? [])].sort((a, b) => a.period.localeCompare(b.period));
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    // ★ 只檢查「緊接著的兩期」。中間跳過一期時上一期的留抵接不到這一期，
    //   那不是斷鏈是缺資料 —— 兩件事，訊息不一樣
    if (prevPeriod(cur.period) !== prev.period) continue;
    const expected = Math.round(Number(prev.carry_out ?? 0));
    const actual = Math.round(Number(cur.carry_in) || 0);
    if (expected !== actual) out.push({ period: cur.period, expected, actual });
  }
  return out;
}


/* ============================================================
 * 上傳:財政部電子發票平台的銷項檔
 * ============================================================ */

/**
 * 財政部匯出檔的欄位名。
 *
 * ★ 檔名長 `{統編}_OUT_{時間戳}.xlsx`，`Invoice` 分頁是主表、
 *   `Invoice_details` 是品名明細（用發票號碼接）。
 *
 * ★★ 欄位名寫成常數而不是 inline 字串 —— 平台改欄位名時
 *   要改的只有這一處，而且改了測試會叫。
 */
export const OUT_SHEET = 'Invoice';
export const OUT_DETAIL_SHEET = 'Invoice_details';

export const OUT_COL = {
  invoiceNo: '發票號碼',
  status: '發票狀態',
  date: '發票日期',
  buyerTaxId: '買方統一編號',
  buyerName: '買方名稱',
  sellerTaxId: '賣方統一編號',
  net: '銷售額合計',
  tax: '營業稅',
  total: '總計',
  note: '總備註',
} as const;

/** 作廢的發票狀態。★ 平台的字是「作廢已確認」，不是「作廢」。 */
export const OUT_VOID_STATUS = '作廢已確認';

export type RawOutRow = Record<string, unknown>;

export type ParsedUpload = {
  rows: TaxInvoice[];
  /** 這個檔是哪一家的（賣方統編）—— 拿去跟畫面上選的公司比對 */
  sellerTaxId: string;
  /** 檔裡跨了哪幾期。★ 超過一期要擋，見 `uploadError` */
  periods: TaxPeriod[];
  activeCount: number;
  voidedCount: number;
  activeTax: number;
  voidedTax: number;
};

const num = (v: unknown): number => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const n = Number(String(v ?? '').replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : 0;
};
const str = (v: unknown): string => (v == null ? '' : String(v).trim());

/** `'2026-07-02 13:34:41'` 或 Date → `'2026-07-02'`。 */
export function toDateOnly(v: unknown): string {
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    // ★ 用本地時間欄位組，不要 toISOString() —— 那會轉成 UTC，
    //   台灣時間早上 8 點前的發票會被推到前一天
    const p = (n: number) => String(n).padStart(2, '0');
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
  }
  const s = str(v);
  const m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (!m) return '';
  return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
}

/**
 * 財政部的 `Invoice` 分頁 → 我們的發票列。
 *
 * @param rows      `Invoice` 分頁（第一列當表頭讀進來的物件陣列）
 * @param itemOf    發票號碼 → 品名（從 `Invoice_details` 建的對照）
 *
 * ★★★ 作廢的**照樣收進來**，標 `voided = true`。
 *   在這裡濾掉的話，畫面上就看不到那三張了 —— 而使用者要看得到，
 *   才知道系統跟財政部的檔對得起來（發票號碼連號）。
 *   濾是在加總的時候濾（`activeInvoices`）。
 */
export function parseOutUpload(
  rows: RawOutRow[],
  itemOf: (invoiceNo: string) => string = () => '',
): ParsedUpload {
  const out: TaxInvoice[] = [];
  const periods = new Set<TaxPeriod>();
  let sellerTaxId = '';
  for (const r of rows ?? []) {
    const no = str(r[OUT_COL.invoiceNo]);
    if (!no) continue;                       // 尾端的空列
    const date = toDateOnly(r[OUT_COL.date]);
    const period = taxPeriodOf(date);
    if (period) periods.add(period);
    if (!sellerTaxId) sellerTaxId = str(r[OUT_COL.sellerTaxId]);
    out.push({
      period,
      kind: 'out',
      // ★ 銷項一律是「收入」＋ 稅碼 21。平台的檔沒有這兩欄，
      //   而它們是申報必填 —— 給預設值讓人在畫面上改，不要留空
      category: '收入',
      tax_code: '21',
      invoice_date: date,
      invoice_no: no,
      counterparty: str(r[OUT_COL.buyerName]) || null,
      counterparty_tax_id: str(r[OUT_COL.buyerTaxId]) || null,
      item_name: itemOf(no) || null,
      summary: null,
      net_amount: num(r[OUT_COL.net]),
      tax_amount: num(r[OUT_COL.tax]),
      total_amount: num(r[OUT_COL.total]),
      note: str(r[OUT_COL.note]) || null,
      voided: str(r[OUT_COL.status]) === OUT_VOID_STATUS,
      source: 'upload',
    });
  }
  const act = out.filter((r) => !r.voided);
  const voi = out.filter((r) => r.voided);
  return {
    rows: out,
    sellerTaxId,
    periods: [...periods].sort(),
    activeCount: act.length,
    voidedCount: voi.length,
    activeTax: act.reduce((a, r) => a + r.tax_amount, 0),
    voidedTax: voi.reduce((a, r) => a + r.tax_amount, 0),
  };
}

/** `Invoice_details` → 發票號碼 → 品名。一張發票多列時取第一列。 */
export function buildItemMap(details: RawOutRow[]): Record<string, string> {
  const m: Record<string, string> = {};
  for (const d of details ?? []) {
    const no = str(d['發票號碼']);
    const name = str(d['品名']);
    if (no && name && !m[no]) m[no] = name;
  }
  return m;
}

/**
 * 這個檔能不能匯進這一期、這一家。回錯誤字串，`null` = 可以。
 *
 * ★★★ 三種都要擋，而且訊息要講得出**哪裡不對**:
 *   1. 檔是別家公司的 → 匯進來會把兩家的稅混在一起
 *   2. 檔跨了不只一期 → 分不出哪幾張算這一期
 *   3. 檔的期別跟畫面上選的不同 → 使用者選錯期就按上傳
 */
export function uploadError(
  parsed: ParsedUpload, period: TaxPeriod, companyTaxId: string,
): string | null {
  if (!parsed.rows.length) return '這個檔裡沒有發票 —— 確認一下是不是「Invoice」那個分頁';
  if (companyTaxId && parsed.sellerTaxId && parsed.sellerTaxId !== companyTaxId) {
    return `這個檔的賣方是 ${parsed.sellerTaxId}，不是 ${companyTaxId} —— 匯進來兩家的稅會混在一起`;
  }
  if (parsed.periods.length > 1) {
    return `這個檔跨了 ${parsed.periods.map(periodLabel).join('、')} —— 一次只能匯一期`;
  }
  if (parsed.periods.length === 1 && parsed.periods[0] !== period) {
    return `這個檔是 ${periodLabel(parsed.periods[0])} 的，而現在選的是 ${periodLabel(period)}`;
  }
  return null;
}

/**
 * 手 key 一筆的必填檢查。回錯誤字串，`null` = 可以存。
 *
 * ★ 金額三個欄位的關係**不強制**（`銷售額 + 稅額 = 總金額`）——
 *   折讓單、零稅率、免稅那幾種本來就不成立。
 *   對不上時提醒（`amountMismatch`），不擋。
 */
export function invoiceError(v: Partial<TaxInvoice>): string | null {
  if (!v.invoice_date) return '要填日期';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v.invoice_date)) return '日期格式不對（日期框收到不存在的日期會自動清空，例如 4/31）';
  if (!str(v.invoice_no)) return '要填發票號碼';
  if (!v.tax_code) return '要選稅碼';
  if (v.net_amount == null || !Number.isFinite(Number(v.net_amount))) return '要填銷售額';
  if (v.tax_amount == null || !Number.isFinite(Number(v.tax_amount))) return '要填稅額';
  if (Number(v.net_amount) < 0 || Number(v.tax_amount) < 0) return '金額不能是負數（折讓請用稅碼 23／24）';
  return null;
}

/** 銷售額 ＋ 稅額 ≠ 總金額 時提醒。★ 提醒不是擋。 */
export function amountMismatch(v: Partial<TaxInvoice>): string | null {
  const n = Number(v.net_amount) || 0;
  const t = Number(v.tax_amount) || 0;
  const g = Number(v.total_amount) || 0;
  if (!g) return null;
  return Math.round(n + t) === Math.round(g)
    ? null
    : `銷售額 ${n.toLocaleString()} ＋ 稅額 ${t.toLocaleString()} ＝ ${(n + t).toLocaleString()}，跟總金額 ${g.toLocaleString()} 對不起來`;
}
