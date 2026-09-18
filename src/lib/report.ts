/**
 * 會計報表：月報、401、其他（migration_275）。
 *
 * ══════════════════════════════════════════════════════════
 * 【使用者 2026-09-18】
 *
 *   「多一個 叫 會計報表 / 會計可上傳 月報 401報表 /
 *     檔案形式 PDF excel word / 權限：會計 主管 總經理 可以來讀 /
 *     種類 月報 401 其他 / 日期 期別 種類 / 401 兩月一期」
 *   「401 可以選 之後月份嗎 可以 dropdown 自己選 不用再新增」
 *
 * ══════════════════════════════════════════════════════════
 * 【★★★ 期別只存一支欄位，中文是算出來的】
 *
 * 存的是**那一期的第一天**（`period_start = 2026-07-01`）＋ 種類。
 * 畫面上的「115年 7-8月」由 `periodText()` 算出來。
 *
 * 存中文的話「115年7-8月」「115 年 7~8 月」「115/7-8」會同時存在，
 * 而排序、篩選、找重複全部對不上 ——
 * README:「同一支欄位既拿來顯示又拿來當 key」。
 *
 * ══════════════════════════════════════════════════════════
 * 【為什麼寫在 `.ts` 而不是頁面裡】
 *
 * 測試環境不處理 JSX。而這裡每一條都是**錯了不會報錯**的:
 *
 *   · 期別算錯     → 一份 7-8 月的 401 標成 5-6 月，兩年後查不到
 *   · 下拉少一年   → 每年一月有一天報不了，而沒有人知道要去哪裡加
 *   · 預設選錯一期 → 每次上傳都要先往下撥一格（不會有人來報，只會覺得難用）
 */

/* 民國年。★ 全站顯示一律民國，資料庫一律西元 —— 換算只有這一個地方。 */
export const roc = (y: number): number => y - 1911;

/* ══════════════ 種類 ══════════════ */

/**
 * ★★ 跟資料庫的 `ar_kind_chk` 是同一份。加新的種類要兩邊一起改 ——
 *   只改一邊的話:只改這裡 → 存檔撞 check；只改那邊 → 下拉裡選不到。
 */
export const REPORT_KINDS = ['月報', '401', '其他'] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

/** 讀進來的值不在清單裡就當成「其他」—— 不要讓一列因為種類怪就整個不見。 */
export function parseKind(raw: string | null | undefined): ReportKind {
  return (REPORT_KINDS as readonly string[]).includes(raw as string)
    ? (raw as ReportKind) : '其他';
}

/** 一列報表。欄位名跟資料庫一致。 */
export type Report = {
  id?: string;
  kind: string | null;
  /** 那一期的第一天（`2026-07-01`）。「其他」可以是 null。 */
  period_start: string | null;
  /**
   * 標題（2026-09-18 使用者:「還是有標題 可以自己輸入」）。
   *
   * ★★★ 清單上的大字、**以及下載時的檔名**都是它
   *   （使用者:「下載檔案 和標題一樣」）。
   * ★ 選了種類與期別會**建議**一個（`suggestTitle`），但隨時改得動 ——
   *   建議，不自動（README 的判斷原則）。
   */
  title: string;
  /**
   * 上傳日（2026-09-18 使用者:「改成上傳日」）。選填。
   *
   * ★ 原本叫「申報日」。**跟期別沒有先後關係** ——
   *   明年那一期今天先建起來是合法的（migration_280 拿掉了那條守衛）。
   */
  uploaded_on?: string | null;
  note?: string | null;
  file_path?: string | null;
  file_name?: string | null;
  file_size?: number | null;
  updated_at?: string;
  updated_by?: string | null;
  created_by?: string | null;
};

/* ══════════════ 期別 ══════════════ */

/**
 * 401 的合法起月**只有單數月**（營業稅兩月一期）。
 * 有了這一份，下拉裡就選不到「6-7 月」這種不存在的期別。
 */
export const START_MONTHS_401 = [1, 3, 5, 7, 9, 11] as const;

/** 這一期橫跨幾個月：401 是 2，其餘是 1。 */
export const spanOf = (kind: string | null | undefined): number =>
  parseKind(kind) === '401' ? 2 : 1;

/**
 * 期別要印成什麼。沒有期別回空字串（**不是「—」**）——
 * 「—」是畫面決定要怎麼表示「沒有」，那一層的事留在那一層。
 */
export function periodText(kind: string | null | undefined, start: string | null | undefined): string {
  if (!start) return '';
  const [y, m] = String(start).split('-').map(Number);
  if (!y || !m) return '';
  return spanOf(kind) === 2 ? `${roc(y)}年 ${m}-${m + 1}月` : `${roc(y)}年 ${m}月`;
}

/** `YYYY-MM`（月份選擇器給的值）→ `YYYY-MM-01`。空的回 null。 */
export function monthToStart(ym: string | null | undefined): string | null {
  const s = String(ym ?? '').trim();
  return /^\d{4}-\d{2}$/.test(s) ? `${s}-01` : null;
}

/** 反過來：`YYYY-MM-01` → `YYYY-MM`，給月份選擇器當 value。 */
export function startToMonth(start: string | null | undefined): string {
  const s = String(start ?? '');
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s.slice(0, 7) : '';
}

/**
 * 401 期別的下拉選項。
 *
 * ★★★ 跨好幾年一次列完 —— **沒有「新增年度」這個動作**
 *   （2026-09-18 使用者:「可以 dropdown 自己選 不用再新增」）。
 *   要人先去某個地方把 116 年加進去的話，每年一月就會有一天報不了，
 *   而那天沒有人知道要去哪裡加。
 *
 * ★ 新的排前面 —— 最常選的是「剛結束的那一期」。
 */
export const YEARS_BACK = 2;
export const YEARS_FWD = 1;

export function options401(today: Date = new Date()): { start: string; label: string }[] {
  const y0 = today.getFullYear();
  const out: { start: string; label: string }[] = [];
  for (let y = y0 + YEARS_FWD; y >= y0 - YEARS_BACK; y--) {
    for (let i = START_MONTHS_401.length - 1; i >= 0; i--) {
      const m = START_MONTHS_401[i];
      const start = `${y}-${String(m).padStart(2, '0')}-01`;
      out.push({ start, label: periodText('401', start) });
    }
  }
  return out;
}

/**
 * 預設選哪一期 ＝ **剛結束的那一期**，不是現在這一期。
 *
 * 台灣 401 是單數月申報前兩個月:9 月在報 7-8 月。
 * 預設成 9-10 月的話，每一次上傳都要先把下拉往下撥一格。
 *
 * ★★ 跨年要退到前一年的 11-12 月，不是月份變成 −1。
 */
export function default401(today: Date = new Date()): string {
  let y = today.getFullYear();
  const m = today.getMonth() + 1;
  let s = m - ((m - 1) % 2) - 2;      // 現在這一期的起月，再退一期
  if (s < 1) { s += 12; y -= 1; }
  return `${y}-${String(s).padStart(2, '0')}-01`;
}

/** 月報的預設 ＝ **上一個月**（同樣的理由:當月還沒結算完）。 */
export function defaultMonthly(today: Date = new Date()): string {
  let y = today.getFullYear();
  let m = today.getMonth();           // getMonth() 已經是「上個月」的 1-based 值
  if (m < 1) { m = 12; y -= 1; }
  return `${y}-${String(m).padStart(2, '0')}-01`;
}

/** 種類換掉時，期別該跳到哪一個預設值。 */
export function defaultStartFor(kind: string | null | undefined, today: Date = new Date()): string | null {
  const k = parseKind(kind);
  if (k === '401') return default401(today);
  if (k === '月報') return defaultMonthly(today);
  return null;                        // 其他:沒有期別，留空
}

/* ══════════════ 檢查 ══════════════ */

/**
 * 存檔前的檢查。回**第一個**錯，沒問題回 null。
 *
 * ★★ 這幾條跟資料庫的 `ar_shape_chk` 是同一組規則（migration_275）。
 *   兩邊都寫是刻意的:資料庫那層擋住任何路徑（含手改資料），
 *   這一層負責講出**為什麼** —— 資料庫只會回
 *   `violates check constraint "ar_shape_chk"`，使用者看不懂要改哪一格。
 */
export function validateReport(r: Report): string | null {
  const k = parseKind(r.kind);
  if (!(REPORT_KINDS as readonly string[]).includes(String(r.kind))) return '要選種類';

  /*
   * ★★★ 標題必填，而且**每一種都要**。
   *   它是清單上的大字，也是下載下來的檔名 ——
   *   空的話那一份在資料夾裡叫「.pdf」，三個月後沒有人認得出來。
   */
  if (!r.title?.trim()) return '要填標題';

  if (k !== '其他' && !r.period_start) return '要選期別';

  if (r.period_start) {
    if (!/^\d{4}-\d{2}-01$/.test(r.period_start)) {
      return '期別要是那一期的第一天';
    }
    if (k === '401') {
      const m = Number(r.period_start.slice(5, 7));
      if (!(START_MONTHS_401 as readonly number[]).includes(m)) {
        return `401 是兩月一期，起月只能是 ${START_MONTHS_401.join('、')} 月`;
      }
    }
  }

  /*
   * ★★★ 「申報日不早於期別」那一條**拿掉了**（migration_280）。
   *   它對申報日是對的，對**上傳日**是錯的 ——
   *   401 的下拉列到明年，先把 116 年 11-12 月建起來的話，
   *   上傳日（今天）比期別早，會被擋掉。
   *   上傳日跟期別本來就沒有先後關係。
   */
  return null;
}

/* ══════════════ 清單 ══════════════ */

/**
 * 選了種類與期別之後，**建議**的標題。
 *
 * ★ 只給期別那幾個字（「115年 7-8月」），不重複寫種類 ——
 *   種類那顆籤就畫在標題前面，同一件事不寫兩次。
 * ★★ 「其他」沒有期別，建議不出來就回空字串，讓人自己打。
 */
export function suggestTitle(kind: string | null | undefined, start: string | null | undefined): string {
  return periodText(kind, start);
}

/** 這一列的大字。★ 就是標題 —— 不要在這裡編一個出來。 */
export function reportTitle(r: Report): string {
  return r.title?.trim() || '（沒有標題）';
}

/**
 * 排序：**期別新的在前**，沒有期別的（其他）照上傳日。
 *
 * ★ 用 `period_start` 排，不是那串中文 ——
 *   中文排序會讓「115年 9-10月」排在「115年 1-2月」後面（字典序）。
 */
export function sortReports(rows: Report[]): Report[] {
  return [...(rows ?? [])].sort((a, b) => {
    const ka = a.period_start || a.uploaded_on || '';
    const kb = b.period_start || b.uploaded_on || '';
    if (ka !== kb) return ka < kb ? 1 : -1;
    return reportTitle(a).localeCompare(reportTitle(b));
  });
}

/** 那一列屬於哪一年（篩選藥丸用）。沒有期別就看上傳日。 */
export const yearOf = (r: Report): string =>
  String(r.period_start || r.uploaded_on || '').slice(0, 4);

/**
 * 關鍵字比對。
 *
 * ★ 連**算出來的期別**一起比 —— 使用者打「7-8」要找得到那一份，
 *   而資料庫裡存的是 `2026-07-01`，只比欄位的話一筆都不會中。
 */
export function matchReport(r: Report, kw: string | null | undefined): boolean {
  const q = String(kw ?? '').trim().toLowerCase();
  if (!q) return true;
  const hay = [
    r.title ?? '', periodText(r.kind, r.period_start), parseKind(r.kind),
    r.note ?? '', r.uploaded_on ?? '', r.file_name ?? '',
    r.period_start ?? '',
  ].join(' ').toLowerCase();
  return hay.includes(q);
}

/*
 * ══════════════════════════════════════════════════════════
 * 【★★★ 沒有「已經有一份了」這個提醒了】（2026-09-18「開放多個」）
 *
 * 原本傳同一期時會跳一句「要換掉那一份嗎」。使用者:
 * 「401 可以重複上傳」「會有不同公司」「月報 401 不必一對一」「開放多個」。
 *
 * 同一期的 401，正隆一份、愛皮一份、洪鯊一份 —— **每一份都是對的**，
 * 每次都問一句只是擋路。要換掉舊的就在那一列按「編輯」。
 *
 * ★ 所以 `findSamePeriod` 整支拿掉了，不是留著不呼叫 ——
 *   留著的話下一個人會以為它還有用（README:留著一支沒人叫的函式
 *   比刪掉更容易被誤用）。
 * ══════════════════════════════════════════════════════════ */

/* ══════════════ 檔案 ══════════════ */

export const REPORT_ACCEPT = '.pdf,.xls,.xlsx,.doc,.docx';
export type ReportFileKind = 'pdf' | 'excel' | 'word' | 'other';

/** 副檔名（小寫，含點）。沒有就回空字串。 */
export function extOf(name: string | null | undefined): string {
  const m = String(name ?? '').match(/\.[A-Za-z0-9]{1,8}$/);
  return m ? m[0].toLowerCase() : '';
}

export function reportFileKind(name: string | null | undefined): ReportFileKind {
  switch (extOf(name)) {
    case '.pdf': return 'pdf';
    case '.xls': case '.xlsx': return 'excel';
    case '.doc': case '.docx': return 'word';
    default: return 'other';
  }
}

/** 圖示上那三個字母。 */
export const FILE_BADGE: Record<ReportFileKind, string> = {
  pdf: 'PDF', excel: 'XLS', word: 'DOC', other: '—',
};

/**
 * 下載時要叫什麼名字。
 *
 * ★★★ 不能把中文塞進 HTTP 的 `content-disposition` —— 那條路沒有正確編碼，
 *   使用者看到的是 `æ¯åºè­æå®.docx`（2026-09-18 表單下載那邊回報的）。
 *   這個字串是給瀏覽器 `<a download>` 用的，是純文字，中文不會壞。
 *
 * ★ Windows 不准的字元換成 `_`，不然存不進資料夾。
 */
const BAD_CHARS = /[\\/:*?"<>| -]/g;

export function reportFileName(r: Report): string {
  const ext = extOf(r.file_name);
  /* ★ 就是標題（使用者 2026-09-18:「下載檔案 和標題一樣」） */
  const safe = String(r.title ?? '').replace(BAD_CHARS, '_').replace(/\s+/g, ' ').trim();
  /* 標題空的（理論上擋得住，它必填）就退回原始檔名 —— 不要產生一個叫「.pdf」的檔 */
  if (!safe) return r.file_name || '報表';
  /* 標題自己已經帶了副檔名就不重複加 */
  return safe.toLowerCase().endsWith(ext) ? safe : safe + ext;
}

/**
 * 列上第三行：**誰傳的・檔名・大小・上傳日**（2026-09-18 使用者:「給檔案明細 大小 上傳日期」）。
 *
 * ══════════════════════════════════════════════════════════
 * 【★★ 空的那幾段要整段不見，不是印一個「—」】
 *
 * 使用者 2026-09-18 圈出第一格的空白問「第一個空白是甚麼？」——
 * 那是上傳者，而它一直是空的（`created_by` 從來沒被寫進去）。
 *
 * 一個孤零零的「—」講不出自己是什麼欄位 —— 看的人只會猜。
 * **沒有值就整段拿掉**，剩下的用「・」接起來。
 *
 * ★ 每一段自己帶著名字（「62 KB」「上傳 09/18」）才看得懂，
 *   所以順序換了也不會讀錯。
 * ══════════════════════════════════════════════════════════
 */
export function fileLine(p: {
  who?: string | null;
  fileName?: string | null;
  size?: string | null;
  uploadedOn?: string | null;
}): string {
  const parts = [
    (p.who ?? '').trim(),
    (p.fileName ?? '').trim(),
    (p.size ?? '').trim(),
    p.uploadedOn ? `上傳 ${String(p.uploadedOn).slice(5).replace('-', '/')}` : '',
  ].filter(Boolean);
  /* ★ 一段都沒有時回空字串 —— 畫面那邊整行不畫，不要留一條空的灰線 */
  return parts.join('　·　');
}
