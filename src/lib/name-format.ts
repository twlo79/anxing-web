/**
 * 人名與房源名稱的格式統一。
 *
 * ============================================================
 * 【為什麼】（2026-08-24 使用者指定）
 *
 * 搜尋「Lilian」找到四筆，四種寫法:
 *
 *     LILIAN        B8   時兆
 *     Lilian        B6   時兆
 *     Lilian Hong   B6   時兆
 *     LILIAN WA     南京5 南京
 *
 * 使用者:「幫我統一 輸入是首字大寫，Lilian or Wu」。
 *
 * 大小寫不統一的代價不只是難看:
 *
 *   · 客戶管理裡同一個人會出現好幾筆
 *   · 搜尋「Lilian」找得到，搜尋「lilian hong」不一定
 *   · 對帳時「這兩筆是不是同一個人」要靠人記
 *
 *
 * ============================================================
 * 【中文不動 —— 「鎖英文輸入」不能照字面做】
 *
 * 使用者說「鎖英文輸入讓格式統一」。但房客與廠商有大量中文名
 * （洪國竣、時兆物業…），真的鎖成只能打英文的話那些名字就存不進去。
 *
 * 所以做的是:**英文的詞轉成首字大寫，中文字原樣保留**。
 * 中文本來就沒有大小寫，這樣兩種都統一了。
 *
 *
 * ============================================================
 * 【不做的事】
 *
 * ★ 不動 `LLC`、`AB` 這種全大寫的縮寫 —— 分不出來。
 *   `LILIAN WA` 要變 `Lilian Wa`（使用者的例子），
 *   而 `ABC 公司` 也會變 `Abc 公司`。
 *   要保留縮寫就得維護一份白名單，而白名單漏一個的症狀是
 *   「某一家廠商的名字每次存檔都被改掉」。
 *   統一比正確更重要 —— 因為統一才搜尋得到。
 *
 * ★ 不自動合併相似的名字。系統負責看見，人負責決定
 *   （CLAUDE.md 的判斷原則）。相似的只在防呆裡提示。
 */

/** 這個字是不是 ASCII 英文字母 */
const isAsciiAlpha = (c: string) => /[A-Za-z]/.test(c);

/**
 * 首字大寫。英文詞轉成 `Lilian`，中文字原樣保留。
 *
 *     'LILIAN WA'   → 'Lilian Wa'
 *     'lilian hong' → 'Lilian Hong'
 *     '洪國竣'       → '洪國竣'
 *     'o'brien'     → "O'Brien"
 *     'anne-marie'  → 'Anne-Marie'
 *     '  王  大明 ' → '王 大明'      （前後與重複空白收掉）
 */
export function titleCaseName(raw: string | null | undefined): string {
  if (!raw) return '';
  // 全形空白也算空白 —— 中文輸入法常打出來，不收的話兩筆看起來一樣卻不相等
  const s = raw.replace(/[\s　]+/g, ' ').trim();
  if (!s) return '';

  let out = '';
  /*
   * ★ 「上一個字是不是分隔」決定要不要大寫。
   *   分隔包含空白與 `-` `'` `.` —— O'Brien、Anne-Marie、J.R. 都要對。
   *   只看空白的話會得到 `O'brien`。
   */
  let atWordStart = true;
  for (const c of s) {
    if (isAsciiAlpha(c)) {
      out += atWordStart ? c.toUpperCase() : c.toLowerCase();
      atWordStart = false;
    } else {
      out += c;
      // 中文字之後也算「詞的開頭」—— 「王Lilian」要得到大寫的 L
      atWordStart = c === ' ' || c === '-' || c === "'" || c === '.' || !isAsciiAlpha(c);
    }
  }
  return out;
}

/**
 * 比對用的 key。**不是拿來存的** —— 存的是 titleCaseName 的結果。
 *
 * 去掉空白、標點，轉小寫。用來判斷「這兩筆是不是同一個人」。
 *
 *     'LILIAN WA' → 'lilianwa'
 *     'Lilian Wa' → 'lilianwa'    ← 兩者相等
 */
export function nameKey(raw: string | null | undefined): string {
  return (raw ?? '').toLowerCase().replace(/[\s　'".\-_,]/g, '');
}

/**
 * 姓名的第一個詞（小寫）。用來抓「Lilian」與「Lilian Hong」這種**可能**同一人。
 *
 * ★ 回空字串表示判斷不了 —— 呼叫端要當作「不比對」，不是「都算同一組」。
 */
export function firstNameToken(raw: string | null | undefined): string {
  const s = (raw ?? '').replace(/[\s　]+/g, ' ').trim();
  if (!s) return '';
  return s.split(' ')[0].toLowerCase().replace(/[^a-z0-9一-鿿]/g, '');
}

/**
 * 這個字串需不需要正規化（存進去的跟正規化後的不一樣）。
 *
 * 用來決定「這一筆要不要回寫資料庫」—— 全部無條件回寫的話，
 * 四千多筆訂單的 updated_at 會全部變成今天，
 * 而那會讓「最近改過什麼」這個問題永遠答不出來。
 */
export function needsNormalize(raw: string | null | undefined): boolean {
  if (raw == null) return false;
  return raw !== titleCaseName(raw);
}

/**
 * 兩個房源名稱是不是「其實是同一間，只差空白或大小寫」。
 *
 * ============================================================
 * 【為什麼放在這支】（2026-08-24 使用者:「B8 這一筆是說資料缺失，但都有啊」）
 *
 * 防呆把那一筆標成「資料缺失」，而畫面上每個欄位都填了。
 * 真正觸發的是另一條:「房源不在現有房源清單裡」——
 * 訊息卻跟「沒填房客」共用同一個標籤，所以看起來像在說欄位是空的。
 *
 * 而房源對不到的原因，多半就是這支要抓的東西:
 * `'B8 '`（尾隨空白）對不到 `'B8'`，`'b8'` 對不到 `'B8'`。
 *
 * 回 null 表示真的是不同的房源。
 */
export function roomNameDiff(a: string, b: string): '空白' | '大小寫' | '空白與大小寫' | null {
  if (a === b) return null;

  const sa = a.replace(/[\s　]+/g, '');
  const sb = b.replace(/[\s　]+/g, '');
  // 去掉空白、忽略大小寫之後還是不同 —— 那是真的兩間房
  if (sa.toLowerCase() !== sb.toLowerCase()) return null;

  /*
   * 到這裡已知「只差空白或大小寫」。分別判斷是哪一種:
   *   caseDiff  去空白後仍不等 → 大小寫不同
   *   spaceDiff 忽略大小寫後仍不等 → 空白分布不同
   * 兩個各自判斷,不要串在一起 —— 串起來的話 trim 會把差異吃掉，
   * 而 'B8 ' 與 'B8' 會被回報成「沒有差異」。
   */
  const caseDiff = sa !== sb;
  const spaceDiff = a.toLowerCase() !== b.toLowerCase();

  if (caseDiff && spaceDiff) return '空白與大小寫';
  if (caseDiff) return '大小寫';
  if (spaceDiff) return '空白';
  return null;
}
