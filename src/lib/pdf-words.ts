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
 * 【這個檢查存在的理由】
 *
 * pdfjs 回傳的是「文字塊」不是「詞」，切在哪裡由 PDF 內部的
 * 繪製指令決定 —— 換一家銀行、甚至同一家改版，切法都可能不同。
 *
 * 如果它把 `1 2025/01/02 ＡＴＭ轉 台北富邦 17,836 45,943` 當成一塊，
 * 那一塊只有一個 x 座標，**支出與存入就分不出來**。
 *
 * 而那不會報錯 —— 解析器會找不到金額、回傳 0 筆，
 * 或更糟:抓到其中一個數字然後餘額全歪。
 *
 * 所以在解析之前先問一句:有沒有任何一塊裡面裝了兩個以上的數字?
 * 有的話就停下來,說清楚是這個原因,**不要硬解析**。
 *
 * 這不是效能檢查也不是潔癖 —— 這是「對不上的不猜」。
 */
export function looksCombined(words: Word[]): boolean {
  const twoNumbers = /\d[\d,]*\s+\d[\d,]*/;
  return words.some((w) => twoNumbers.test(w.text));
}

export const PDF_COMBINED_MESSAGE =
  'PDF 的文字被黏成整列，分不出支出與存入。' +
  '這通常代表銀行換了產生對帳單的方式 —— 請把檔案給工程師看一下，先不要匯入。';
