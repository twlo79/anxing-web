/**
 * PDF → `Word[]`。**這是整個帳戶管理裡唯一碰 PDF 檔案的地方。**
 *
 * ============================================================
 * 【為什麼是瀏覽器不是伺服器】（2026-08-18 使用者選定）
 *
 * pdfjs 本來就是瀏覽器函式庫,在它的原生環境跑最不會出意外。
 * 而且會計拖檔進來就能當場看到預覽 —— 檔案根本不用上傳一趟。
 *
 * 代價:解析是前端算的,後端收到的是一包 JSON。
 * **所以後端一定要用同一份 `bank-statement.ts` 重驗一次**,
 * 不能因為「前端已經驗過」就直接寫入。
 *
 *
 * ============================================================
 * 【為什麼從 CDN 載,不放進 package.json】
 *
 * pdfjs 打包進 bundle 會讓每一頁都變重(它有兩三 MB),
 * 而全站只有這一頁用得到。動態載入只有進到上傳流程才會下載。
 *
 * 換成自架的話**只要改 `PDFJS_URL` 這一個常數** ——
 * 把 pdf.min.mjs 與 pdf.worker.min.mjs 放進 `public/vendor/`,
 * 網址改成 `/vendor/pdf.min.mjs`。
 *
 * 代價講在前面:CDN 連不上的時候整個上傳功能不能用。
 * 那個失敗是**大聲的**(畫面會說「載入 PDF 解析元件失敗」),
 * 不是安靜的 —— 這一頁最怕的是安靜的錯,不是明顯的錯。
 */

import type { Word } from './bank-statement.ts';

const PDFJS_VER = '4.2.67';
const PDFJS_URL = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VER}/pdf.min.mjs`;
const WORKER_URL = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VER}/pdf.worker.min.mjs`;

/** pdfjs 我們用到的那一小塊。整份型別不抄過來 —— 抄了會跟著它改版壞掉。 */
type TextItem = {
  str: string;
  width: number;
  /** [a, b, c, d, e, f] —— e 是 x，f 是 y（由下往上）。 */
  transform: number[];
};
type PdfPage = {
  getViewport(o: { scale: number }): { width: number; height: number };
  getTextContent(o?: { disableCombineTextItems?: boolean }): Promise<{ items: TextItem[] }>;
};
type PdfDoc = { numPages: number; getPage(n: number): Promise<PdfPage> };
type Pdfjs = {
  GlobalWorkerOptions: { workerSrc: string };
  getDocument(o: { data: Uint8Array }): { promise: Promise<PdfDoc> };
};

let cached: Promise<Pdfjs> | null = null;

async function loadPdfjs(): Promise<Pdfjs> {
  if (cached) return cached;
  cached = (async () => {
    // webpackIgnore：這是執行期才抓的外部網址，不要進 bundle
    const m = (await import(/* webpackIgnore: true */ PDFJS_URL)) as unknown as Pdfjs;
    m.GlobalWorkerOptions.workerSrc = WORKER_URL;
    return m;
  })().catch((e) => {
    cached = null; // 失敗不要記住，下次重試
    throw new Error(`載入 PDF 解析元件失敗（${PDFJS_URL}）：${(e as Error).message}`);
  });
  return cached;
}

/**
 * 把一份 PDF 拆成一個一個「詞」，帶座標。
 *
 * 座標系跟 pdfplumber 對齊：`top` 是「距離頁面上緣」，越往下越大。
 * pdfjs 的 y 是由下往上算的，所以要用 `頁高 − y` 換過來 ——
 * **不換的話整份是上下顛倒的**，而分行邏輯照樣跑得完，
 * 只是每一筆的「上一行」變成「下一行」，交易日與摘要對調。
 */
export async function pdfToWords(file: ArrayBuffer): Promise<Word[]> {
  const pdfjs = await loadPdfjs();
  const doc = await pdfjs.getDocument({ data: new Uint8Array(file) }).promise;
  const out: Word[] = [];

  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const h = page.getViewport({ scale: 1 }).height;
    /*
     * disableCombineTextItems：不要把相鄰的文字塊合併。
     *
     * 合併之後「ＡＴＭ轉 台北富邦 17,836 45,943」會變成一個 item，
     * 而那個 item 只有一個 x —— **支出還是存入就分不出來了**。
     *
     * 註：pdfjs v3 起已經不再預設合併，這個選項是舊版的開關，
     * 在 v4 傳進去是沒有作用的（也不會報錯）。留著是為了兩件事 ——
     * 萬一 CDN 上的版本被降回舊版，以及讓讀到這裡的人知道
     * 「不要合併」是這段程式碼的前提，不是碰巧成立的事。
     */
    const tc = await page.getTextContent({ disableCombineTextItems: true });

    for (const it of tc.items) {
      const text = it.str.trim();
      if (!text) continue;
      const x0 = it.transform[4];
      out.push({ page: p, x0, x1: x0 + it.width, top: h - it.transform[5], text });
    }
  }
  return out;
}

/**
 * pdfjs 有沒有把整列黏成一塊?
 *
 * ============================================================
 * 【這個檢查是「解釋」，不是「關卡」】（2026-08-18 修正）
 *
 * pdfjs 回傳的是「文字塊」不是「詞」，切在哪裡由 PDF 內部的繪製指令決定。
 * 如果它把 `1 2025/01/02 ＡＴＭ轉 台北富邦 17,836 45,943` 當成一塊，
 * 那一塊只有一個 x 座標 —— **支出與存入就分不出來**。
 *
 * 第一版把這個檢查放在解析**之前**當關卡，而且規則是
 * 「有沒有任何一塊裡裝了兩個數字」。那一版擋掉了一份好好的 PDF ——
 * 因為抬頭有這一行：
 *
 *     列印日期時間：2026/08/07 11:53:01
 *                        ↑ 07 空白 11，撞上規則
 *
 * 那一行本來就該是一塊，跟表格一點關係也沒有。
 *
 * 教訓有兩層:
 *
 *   1. **規則要精確** —— 只看「兩個金額」，日期與時間先剔掉
 *   2. **順序要對** —— 先解析，解析成功就不必問這個問題。
 *      能不能解析出正確的數字，答案在 `validate()` 而不是在文字長相上。
 *
 * 所以現在它只在解析失敗時被叫到，用途是把「為什麼失敗」講清楚。
 */
export function looksCombined(words: Word[]): boolean {
  return words.some((w) => {
    // 日期、時間、票據號碼那種帶分隔號的長串,先拿掉 ——
    // 它們本來就會跟旁邊的東西同屬一塊,不代表表格被黏住
    const rest = w.text
      .replace(/\d{4}\/\d{2}\/\d{2}/g, ' ')
      .replace(/\d{2}:\d{2}:\d{2}/g, ' ')
      .replace(/\d{3}-\d{6,}/g, ' ');
    // 剩下還有兩個「金額樣子」的數字(帶千分位,或三位數以上)
    const amounts = rest.match(/\d{1,3}(?:,\d{3})+|\d{3,}/g);
    return (amounts?.length ?? 0) >= 2;
  });
}

export const PDF_COMBINED_MESSAGE =
  'PDF 的文字被黏成整列，分不出支出與存入。' +
  '這通常代表銀行換了產生對帳單的方式 —— 請把檔案給工程師看一下，先不要匯入。';

/**
 * 解析失敗時，把 pdfjs 到底吐了什麼印出來。
 *
 * ============================================================
 * 【為什麼要有這個】
 *
 * 「解析不出來」這五個字對查問題完全沒有幫助 ——
 * 是抽不到文字、還是欄位換位置、還是整列黏成一塊?
 *
 * 三種的處理方式完全不同，而**分辨它們只需要看幾行原始輸出**。
 * 沒有這段的話，每次都要把 PDF 寄給工程師、工程師再裝一次環境重跑。
 */
export function describeWords(words: Word[], limit = 12): string {
  if (words.length === 0) return '（一個字都沒抽到）';
  const pages = new Set(words.map((w) => w.page)).size;
  const head = words
    .slice(0, limit)
    .map((w) => `p${w.page} x${w.x0.toFixed(0)}–${w.x1.toFixed(0)} y${w.top.toFixed(0)}　${w.text}`)
    .join('\n');
  return `共 ${words.length} 塊、${pages} 頁。前 ${Math.min(limit, words.length)} 塊：\n${head}`;
}
