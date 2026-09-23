/**
 * 金額／數字的千分位格式 —— **全站唯一一份**（2026-09-23）。
 *
 * ============================================================
 * 【為什麼】
 *
 * 之前 `fmt`／`money` 在 30 個檔各寫一份，看起來一樣，其實有**四種行為**：
 *   · 空值印 `0`　　　　　（17 份）
 *   · 空值留白 `''`　　　（4 份，表格空格用）
 *   · 不四捨五入、留小數（2 份：稅務、暫付明細）
 *   · 前面帶 `$`／`NT$`／`—`（5 份，各頁自己的顯示習慣）
 *
 * 前兩種收進這裡。後兩種**刻意不收** —— 換掉的話畫面上的數字會變，
 * 而「統一」不值得拿顯示結果去換。
 *
 * ★ 一律 `'en-US'`：對整數來說跟不帶參數的 `toLocaleString()` 印出來一樣（1,234），
 *   但明寫比較不會有人以為它跟瀏覽器語系有關。
 *
 * ★ 呼叫端用 `import { fmtInt as fmt }` 綁回原本的名字 —— 呼叫點一行都不用改。
 */

/** 四捨五入到整數＋千分位。null／undefined／NaN → `'0'` */
export function fmtInt(n: number | string | null | undefined): string {
  return Math.round(Number(n) || 0).toLocaleString('en-US');
}

/**
 * 同上，但 null／undefined → `''`（空格）。
 * 表格裡「沒有這個數字」跟「這個數字是 0」要分得開，才用這支。
 */
export function fmtIntOrBlank(n: number | string | null | undefined): string {
  if (n == null || n === '') return '';
  return fmtInt(n);
}
