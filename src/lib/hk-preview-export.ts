import type { PairResult } from './hk-pair-check.ts';

/**
 * 把「產生預覽」整批導成一段純文字 —— 貼給人看、或貼進對話裡請人檢查。
 *
 * ============================================================
 * 【★★★ 為什麼需要這支】（2026-09-09 使用者:「把預覽導給你檢查」）
 *
 * 預覽是**還沒寫進資料庫**的東西，所以任何 SQL 都查不到它。
 * 要讓別人（或事後的自己）看這一批到底長什麼樣，只有從畫面上導出來一條路。
 *
 * ★ 截圖不行:七十幾列會被切成五、六張圖，而且數字沒辦法加總比對。
 *
 * ============================================================
 * 【格式為什麼是 TSV 不是 JSON】
 *
 * 這段文字的讀者是**人**（或人貼給模型看），不是程式。
 *
 *   TSV   一列一筆、欄位對齊，貼進 Excel 也能直接分欄
 *   JSON  同樣的資料多三倍長度，而且要人自己在腦裡把括號配對起來
 *
 * ★★ 每一段前面都有一行小計。**只有明細沒有小計的話，
 *   看的人要自己加七十個數字才知道有沒有漏** —— 而那正是要檢查的事。
 *
 * ============================================================
 * 【★★ 模擬檢查的結果放在最前面】
 *
 * 貼給人看的時候，第一眼要看到的是「這批有沒有問題」，
 * 不是第一列清潔費是哪一間。細節放後面，結論放前面。
 */

/** 一列導出資料。欄位已經是**顯示用的字**，不是 id。 */
export type ExportLine = {
  date: string;
  /** 物業名稱。導出來是給人看的，id 沒有意義 */
  estate: string;
  room: string;
  item: string;
  /** 間數 × 單價。人工指定金額或不適用時給 null —— 不要印 0 */
  units?: number | null;
  price?: number | null;
  amount: number;
  /** 附註（付款方式、向誰收、拆帳來源…）。沒有就空字串 */
  extra?: string;
};

export type ExportInput = {
  /** `2026-08` */
  period: string;
  /** 導出當下的日期。**要有** —— 一週後看到這段文字要知道它多舊 */
  now: string;
  check: PairResult;
  clean: ExportLine[];
  labor: ExportLine[];
  hour: ExportLine[];
  income: ExportLine[];
  /** 算不出金額、不會產生的那幾份工。**一定要導出來** */
  unpriced: { date: string; label: string; units: number; reason: string }[];
};

const money = (n: number) => Math.round(Number(n) || 0).toLocaleString('en-US');
const total = (rows: ExportLine[]) =>
  (rows ?? []).reduce((a, r) => a + (Number(r.amount) || 0), 0);

/**
 * 一段。空的段落**整段不印** —— 一個「（沒有）」的標題只是雜訊，
 * 而七段裡有三段空的時候，真正有東西的那幾段會被推到看不見。
 */
function block(title: string, rows: ExportLine[]): string[] {
  if (!rows?.length) return [];
  const out = [
    '',
    `## ${title}　${rows.length} 筆　$${money(total(rows))}`,
    ['日期', '物業', '房源', '項目', '間數', '單價', '金額', '附註'].join('\t'),
  ];
  for (const r of rows) {
    out.push([
      r.date,
      r.estate || '',
      r.room || '',
      r.item || '',
      // ★ 「1 × $730」印得出來，人工指定金額的印空白 ——
      //   「0 × $0」是一個算不出答案的算式，看的人會以為系統壞了
      r.units == null ? '' : String(Number(r.units)),
      r.price == null ? '' : String(Math.round(Number(r.price))),
      String(Math.round(Number(r.amount) || 0)),
      r.extra || '',
    ].join('\t'));
  }
  return out;
}

export function previewExportText(o: ExportInput): string {
  const c = o.check;
  const lines: string[] = [];

  lines.push(`房務產生預覽　${o.period}　（導出於 ${o.now}）`);
  lines.push('');

  // ── 結論放最前面 ────────────────────────────────
  lines.push(c.ok ? '模擬檢查：✅ 通過' : '模擬檢查：❌ 沒過');
  lines.push(
    `　收入 ${c.actualCount} 筆 / 應該 ${c.expectCount} 筆`
    + `（清潔費 ${c.cleanExpect} ＋ 成對人事費 ${c.laborExpect}）`);
  lines.push(
    `　收入 $${money(c.actualAmount)} / 應該 $${money(c.expectAmount)}`);
  for (const i of c.issues) {
    lines.push(`　${i.level === 'error' ? '‣' : '・'} ${i.text}`);
  }

  // ── 三批支出、一批收入 ──────────────────────────
  lines.push('');
  lines.push(
    `支出合計 $${money(total(o.clean) + total(o.labor) + total(o.hour))}`
    + `（清潔費 $${money(total(o.clean))}`
    + `＋人事費 $${money(total(o.labor))}`
    + `＋時薪工資 $${money(total(o.hour))}）`);
  lines.push(`安幸收入 $${money(total(o.income))}`);

  lines.push(...block('清潔費支出（記在物業）', o.clean));
  lines.push(...block('人事費支出（記在物業）', o.labor));
  lines.push(...block('時薪工資支出（記在安幸辦公室）', o.hour));
  lines.push(...block('安幸收入（記在安幸辦公室）', o.income));

  /*
   * ★★★ 算不出金額的那幾份工**一定要導出來**。
   *   它們不會產生任何東西 —— 而「不會產生」正是最需要有人看一眼的事:
   *   少一筆收入沒有人會發現，因為總額只是「比較小」。
   */
  if (o.unpriced?.length) {
    lines.push('');
    lines.push(`## ⚠ 算不出金額、不會產生的　${o.unpriced.length} 筆`);
    lines.push(['日期', '房源', '間數', '原因'].join('\t'));
    for (const u of o.unpriced) {
      lines.push([u.date, u.label || '（沒填）', String(u.units), u.reason].join('\t'));
    }
  }

  return lines.join('\n');
}
