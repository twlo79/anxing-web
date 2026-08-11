/**
 * 管家評價 Excel（多分頁）。
 *
 * ============================================================
 * 【為什麼從 CSV 改成 Excel】
 *
 * CSV 只有一張表。要「總表 ＋ 每位管家的明細」就只能下載五個檔案，
 * 或者把所有人的評價混在一張表裡再自己篩 —— 兩個都不是人會做的事。
 *
 * Excel 一個檔案裝得下：第一頁總表，之後一位管家一頁。
 *
 * ============================================================
 * 【這個檔案只算資料，不碰 xlsx 套件】
 *
 * 產生 workbook 的程式碼沒辦法在 node --test 裡跑（要瀏覽器的 Blob），
 * 但「哪一列放什麼」正是會出錯的地方。所以資料留在這裡、寫檔留在頁面。
 */

export type MgrRow = {
  manager: string;
  avg_rating: number | string;
  s5: number | string; s4: number | string; s3: number | string;
  s2: number | string; s1: number | string;
  total: number | string;
};

/**
 * 明細的一列。
 *
 * guest 是**房客**的姓名（reviews.guest_name），不是管家 ——
 * 管家是分頁名，同一個分頁裡每一列的管家都一樣，再開一欄只是重複。
 *
 * 星等用數字：存成 '★★★★★' 就排不了序也算不了平均。
 */
export type DetailRow = {
  manager: string;
  /** 房客姓名 */
  guest: string;
  /** 物業（正隆、開封…） */
  estate: string;
  /** 房源（3A5、1F-1…） */
  property: string;
  rating: number;
  comment: string;
  /** 排序用，不進表 */
  checkout: string | null;
};

const n = (v: number | string | null | undefined) => Number(v) || 0;

/** 0.904 → '90.4%'。分母 0 時回 '0%'，不要回 NaN%。 */
export function pct(part: number, total: number): string {
  if (!total) return '0%';
  return `${(Math.round((part / total) * 1000) / 10).toFixed(1)}%`;
}

/** 期間標題。兩邊都空 = 全部期間（而不是留白讓人猜）。 */
export function periodTitle(from: string, to: string): string {
  if (!from && !to) return '全部期間';
  if (from && !to) return `${from} 起`;
  if (!from && to) return `迄 ${to}`;
  return `${from} ~ ${to}`;
}

export const SUMMARY_HEADER = [
  '名稱', '平均評價',
  '5星', '5星占比', '4星', '4星占比', '3星', '3星占比',
  '2星', '2星占比', '1星', '1星占比',
  '總評價數',
];

/** 使用者指定的明細欄位 */
export const DETAIL_HEADER = ['姓名', '物業', '房源', '星等', '留言'];

/**
 * 總表。
 *
 * 最後一列是合計 —— 沒有的話「這段期間總共幾則評價」要自己按計算機，
 * 而那正是拿到這份表第一個會問的問題。
 */
export function summarySheet(
  rows: MgrRow[], from: string, to: string,
): (string | number)[][] {
  const out: (string | number)[][] = [
    [`管家評價　${periodTitle(from, to)}`],
    [],
    SUMMARY_HEADER,
  ];
  const sum = { s5: 0, s4: 0, s3: 0, s2: 0, s1: 0, total: 0, weighted: 0 };

  for (const m of rows) {
    const t = n(m.total);
    sum.s5 += n(m.s5); sum.s4 += n(m.s4); sum.s3 += n(m.s3);
    sum.s2 += n(m.s2); sum.s1 += n(m.s1); sum.total += t;
    // 全體平均要「加權」—— 直接把每個人的平均再平均的話，
    // 只有 5 則評價的人跟有 575 則的人一樣重，那個數字沒有意義。
    sum.weighted += n(m.avg_rating) * t;

    out.push([
      m.manager, Number(n(m.avg_rating).toFixed(2)),
      n(m.s5), pct(n(m.s5), t), n(m.s4), pct(n(m.s4), t), n(m.s3), pct(n(m.s3), t),
      n(m.s2), pct(n(m.s2), t), n(m.s1), pct(n(m.s1), t),
      t,
    ]);
  }

  if (rows.length > 1) {
    const t = sum.total;
    out.push([
      '合計', t ? Number((sum.weighted / t).toFixed(2)) : 0,
      sum.s5, pct(sum.s5, t), sum.s4, pct(sum.s4, t), sum.s3, pct(sum.s3, t),
      sum.s2, pct(sum.s2, t), sum.s1, pct(sum.s1, t),
      t,
    ]);
  }
  return out;
}

/**
 * 單一管家的明細。
 *
 * 【排序：星等低的在上面】
 * 這份表是拿來看問題的。照時間排的話，一個 575 則的人要往下捲到
 * 第四百列才看得到那則兩星 —— 而那則就是打開這個檔案的原因。
 * 同星等內再照退房日新到舊。
 */
export function detailSheet(
  manager: string, rows: DetailRow[], from: string, to: string,
): (string | number)[][] {
  const sorted = [...rows].sort((a, b) =>
    a.rating - b.rating || (b.checkout ?? '').localeCompare(a.checkout ?? ''));
  const out: (string | number)[][] = [
    [`${manager}　評價明細　${periodTitle(from, to)}　共 ${rows.length} 則`],
    [],
    DETAIL_HEADER,
  ];
  for (const r of sorted) {
    // 留言可能是 null（只給星等沒寫字）。寫成空字串,不要讓 'null' 出現在表裡。
    out.push([r.guest || '', r.estate || '', r.property || '', r.rating, r.comment || '']);
  }
  if (!rows.length) out.push(['（這段期間沒有評價）', '', '', '', '']);
  return out;
}

/**
 * Excel 的分頁名限制：最多 31 字、不能有 : \ / ? * [ ]、不能重複。
 * 違反的話 SheetJS 會直接丟例外，而使用者只會看到「匯出失敗」。
 */
export function safeSheetName(name: string, used: Set<string>): string {
  const base = (name || '未命名').replace(/[:\\/?*[\]]/g, '').slice(0, 31) || '未命名';
  let s = base;
  // 從 base 重新接尾碼，不要拿上一輪的結果再接 ——
  // 那樣第三次會變成「唐_2_3」，而重點是要短又看得懂
  for (let i = 2; used.has(s); i++) s = `${base.slice(0, 28)}_${i}`;
  used.add(s);
  return s;
}

/** 檔名帶資料期間，不是匯出日 —— 存下來之後才分得出哪一份是哪一段 */
export function xlsxFilename(from: string, to: string): string {
  const p = !from && !to
    ? '全部'
    : `${(from || '起始').replace(/-/g, '')}-${(to || '今日').replace(/-/g, '')}`;
  return `管家評價_${p}.xlsx`;
}

/* ============================================================
 * 樣式
 *
 * 【為什麼樣式的計算也放在這裡】
 * xlsx-js-style 的樣式是掛在每一個儲存格物件的 `s` 上，而 worksheet
 * 本身只是一個普通的 JS 物件（key 是 'A1'、'B3' 這種位址）。
 * 也就是說「哪一格套哪個樣式」是純邏輯，測得到 —— 而那正是會出錯的地方：
 * 少算一列、表頭套到資料列、合計列漏掉框線。
 *
 * 【自己算 A1 位址，不用 XLSX.utils.encode_cell】
 * 只是為了讓這個檔案不相依 xlsx 套件（node --test 載不動它）。
 * 演算法很短，而且有測試釘住 A / Z / AA 的邊界。
 * ============================================================ */

/** 0 → 'A'、25 → 'Z'、26 → 'AA' */
export function colName(i: number): string {
  let s = '';
  for (let n = i; n >= 0; n = Math.floor(n / 26) - 1) {
    s = String.fromCharCode(65 + (n % 26)) + s;
  }
  return s;
}

/** (0,0) → 'A1' */
export const cellRef = (r: number, c: number) => `${colName(c)}${r + 1}`;

const LINE = 'D5DBE3';
const border = {
  top: { style: 'thin', color: { rgb: LINE } },
  bottom: { style: 'thin', color: { rgb: LINE } },
  left: { style: 'thin', color: { rgb: LINE } },
  right: { style: 'thin', color: { rgb: LINE } },
};

export const STYLE = {
  /** 第一列的標題：大、粗、不要框線（它是抬頭不是表格的一部分） */
  title: {
    font: { bold: true, sz: 13, color: { rgb: '2E3840' } },
    alignment: { vertical: 'center' },
  },
  /** 表頭：粗體 ＋ 淡藍底 ＋ 框線。底色是主色的很淡版本，列印出來也還看得見。 */
  header: {
    font: { bold: true, sz: 11, color: { rgb: '2E3840' } },
    fill: { patternType: 'solid', fgColor: { rgb: 'DCE5F0' } },
    border,
    alignment: { vertical: 'center', horizontal: 'center', wrapText: true },
  },
  cell: { border, alignment: { vertical: 'center' } },
  /** 合計列：粗體 ＋ 更淡的底，跟資料列分得開 */
  total: {
    font: { bold: true },
    fill: { patternType: 'solid', fgColor: { rgb: 'F0F3F7' } },
    border,
  },
} as const;

/**
 * 把樣式套到 worksheet 上。
 *
 * @param ws        aoa_to_sheet 產生的物件
 * @param headerRow 表頭在第幾列（0 起算）
 * @param lastRow   最後一列（含）
 * @param cols      共幾欄
 * @param totalRow  合計列的列號；沒有就給 -1
 *
 * 【為什麼要對「空格」也建立儲存格】
 * aoa_to_sheet 不會替空字串以外的空格建物件，而沒有物件就套不上框線 ——
 * 表格右邊會缺一角，看起來像沒畫完。所以缺的補一個空字串格。
 */
export function styleSheet(
  ws: Record<string, unknown>,
  { headerRow, lastRow, cols, totalRow = -1 }: {
    headerRow: number; lastRow: number; cols: number; totalRow?: number;
  },
): void {
  const t = ws[cellRef(0, 0)] as { s?: unknown } | undefined;
  if (t) t.s = STYLE.title;

  for (let r = headerRow; r <= lastRow; r++) {
    for (let c = 0; c < cols; c++) {
      const ref = cellRef(r, c);
      let cell = ws[ref] as { t?: string; v?: unknown; s?: unknown } | undefined;
      if (!cell) { cell = { t: 's', v: '' }; ws[ref] = cell; }
      cell.s = r === headerRow ? STYLE.header : r === totalRow ? STYLE.total : STYLE.cell;
    }
  }
}
