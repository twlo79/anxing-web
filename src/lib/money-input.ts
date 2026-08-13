/**
 * 金額輸入框的千分位（純函式）。
 *
 * ============================================================
 * 【為什麼不能用 <input type="number">】
 *
 * 那個型別不接受逗號 —— 打進去會被瀏覽器判定為無效，整格變空的。
 * 所以要顯示千分位就只能改成 type="text"，自己處理格式與解析。
 *
 *
 * ============================================================
 * 【為什麼千分位值得做】
 *
 * 訂單金額動輒六七位數。196000 跟 19600 差一個零，
 * 而在沒有分隔的一串數字裡，那個差別要一位一位數才看得出來。
 *
 * 這正是這個專案發生過的錯：低於均價五成的提醒之所以存在，
 * 就是為了攔「少打一個 0」。與其事後提醒，不如讓它當場看得出來。
 *
 *
 * ============================================================
 * 【游標為什麼要自己算】
 *
 * 邊打邊加逗號的話，字串會在游標前面憑空多出字元 ——
 * 不處理的話游標會被瀏覽器丟到最後面。使用者想改中間那一位數，
 * 結果每打一個字游標就跳到尾巴。
 *
 * 解法是不用字元位置，改用「游標前面有幾個數字」當定位點 ——
 * 逗號怎麼加都不影響數字的個數。
 */

/** 只留數字與一個小數點。`-` 不留 —— 金額欄位不該能打負數。 */
export function digitsOnly(s: string): string {
  const cleaned = String(s ?? '').replace(/[^\d.]/g, '');
  const i = cleaned.indexOf('.');
  if (i < 0) return cleaned;
  // 第二個以後的小數點丟掉。「1.2.3」是打錯了，不是新的數字系統
  return cleaned.slice(0, i + 1) + cleaned.slice(i + 1).replace(/\./g, '');
}

/**
 * 加千分位。小數部分不動 —— 那裡加逗號沒有意義。
 *
 * 保留使用者正在打的中間狀態：「1234.」不會被吃掉那個點，
 * 否則他永遠打不出小數。
 */
export function formatAmount(s: string): string {
  const raw = digitsOnly(s);
  if (!raw) return '';
  const [int, dec] = raw.split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return dec === undefined ? grouped : `${grouped}.${dec}`;
}

/** 字串轉數字。空字串與純小數點都回 0。 */
export function parseAmount(s: string): number {
  const n = parseFloat(digitsOnly(s));
  return isFinite(n) ? n : 0;
}

/** 數字轉顯示字串。0 顯示空白 —— 讓 placeholder 出得來。 */
export function toInput(n: number | null | undefined): string {
  if (!n) return '';
  return formatAmount(String(n));
}

/**
 * 重新格式化之後，游標該落在哪裡。
 *
 * 用「游標前面有幾個數字」定位，不是字元位置 ——
 * 逗號的增減完全不影響數字的個數。
 *
 * @param before   使用者剛打完、還沒格式化的字串
 * @param caret    那個字串裡的游標位置
 * @param after    格式化之後的字串
 */
export function caretAfterFormat(before: string, caret: number, after: string): number {
  const isNum = (c: string) => c >= '0' && c <= '9';
  let want = 0;
  for (let i = 0; i < caret && i < before.length; i++) if (isNum(before[i])) want++;

  let seen = 0;
  for (let i = 0; i < after.length; i++) {
    if (isNum(after[i])) {
      seen++;
      if (seen === want) return i + 1;
    }
  }
  // 前面一個數字都沒有（游標在開頭，或整串是空的）
  return want === 0 ? 0 : after.length;
}
