/**
 * 房務主檔 ↔ ERP 主檔的「對應提示」。
 *
 * ============================================================
 * 【提示，不是自動對應】
 *
 * migration_124 刻意不做名字比對：猜錯的話工作會被指派到別間房，
 * 排班表看起來滿滿的，而該清的那間沒人去 —— 沒有人會發現。
 *
 * 但「24 個代碼各自到 70 個房源的下拉選單裡找一遍」也是真的累，
 * 累就會亂點，亂點跟猜錯是同一個結果。
 *
 * 所以這裡只做一件事：**把最可能的那一個講出來，按下去的還是人。**
 * 跟同步建議的打勾／打叉同一個道理 —— 系統負責看見，人負責決定。
 *
 *
 * ============================================================
 * 【為什麼用「依序出現」而不是相似度】
 *
 *     開4    → 開封4F      開、4 依序出現 ✓
 *     JPR1   → JPR1F       JPR1 依序出現 ✓
 *     開2-1  → 開封2-1      開、2、-、1 依序出現 ✓
 *
 * 房務代碼是 ERP 名稱的**縮寫**，中間被砍掉幾個字，順序不變。
 * 這正好是「子序列」。編輯距離那類相似度反而會被長度差距干擾 ——
 * 「開4」跟「開封4F」的編輯距離是 3，跟「開封3F」也是 3。
 *
 *
 * ============================================================
 * 【只有唯一一個候選才提示】
 *
 * 兩個以上對得上的時候不給提示。那些正是人要親自看的 ——
 * 給一個「看起來很有把握」的錯誤提示，比什麼都不給更容易被按下去。
 */

/**
 * 比對前先拉平：去空白、全形轉半形、英文轉大寫、**數字去掉補零**。
 *
 * ============================================================
 * 【★★★ 為什麼要去補零】（2026-09-01 使用者：「A07 / B03」）
 *
 * 房務代碼寫的是 `A7`、`B3`（TimeTree 上人手打的），
 * ERP 房源叫 `A07`、`B03`（補零對齊過的）。
 *
 * 不去補零的話會發生兩件事:
 *
 *   `B3` → 子序列只命中 `B03` → 提示得出來 ✓
 *   `A7` → 子序列同時命中 `A07` **與 `A17`**（A、7 依序出現，A17 也符合）
 *          → 兩個候選 → 進「完全相等」那一關
 *          → `A7` ≠ `A07`（差一個零）→ **不給提示** ✗
 *
 * ★★ 於是那幾間永遠對不到 ERP 房源，`property_id` 是 null，
 *   打掃點數算不出來 —— 畫面上顯示成「⚠ N 筆未計」。
 *   而那看起來像「房源忘了設點數」，其實是**根本沒對到房源**。
 *   兩個原因長得一模一樣，所以沒有人找得到真正的問題。
 *
 * ★ 去掉補零之後 `A7` 與 `A07` **完全相等**，
 *   而 `A17` 仍然是 `A17`（不相等）—— 唯一候選出現，提示就給得出來。
 *
 * ============================================================
 * 【用 parseInt 而不是砍掉 `0`】
 *
 * 直覺會寫 `.replace(/0+(\d)/g, '$1')` —— 那是錯的:
 * `A100` 會變成 `A10`（中間那個 0 也被吃掉）。
 *
 * ★ 要**整組數字**一起換算:`A07`→`A7`、`A100`→`A100`、`2-1`→`2-1`。
 *
 * ★★ 這仍然只影響「提示」，不影響任何實際的對應 ——
 *   兩個都叫 `B3` 與 `B03` 的房源同時存在時，
 *   正規化後會有兩個完全相等的候選，`guessLink` 回 null（不給提示）。
 *   **模稜兩可時什麼都不說**，這條規則沒有變。
 */
export function normKey(s: string): string {
  return (s ?? '')
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/[Ａ-Ｚａ-ｚ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/[\s　]/g, '')
    .replace(/\d+/g, (d) => String(parseInt(d, 10)))
    .toUpperCase();
}

/** needle 的每個字都在 hay 裡依序出現？（不必連續） */
export function isSubseq(needle: string, hay: string): boolean {
  if (!needle) return false;
  let i = 0;
  for (const c of hay) {
    if (c === needle[i]) i++;
    if (i === needle.length) return true;
  }
  return false;
}

/**
 * 從候選名稱裡找出唯一對得上的那一個。
 *
 * @param code    房務代碼（例：開4）
 * @param aliases 別名（例：['開封4']）—— 別名本來就是為了比對而存在的，一起試
 * @param names   ERP 房源／員工名稱
 * @returns 唯一候選，或 null（找不到、或不只一個）
 */
export function guessLink(code: string, aliases: string[], names: string[]): string | null {
  const keys = [code, ...(aliases ?? [])].map(normKey).filter(Boolean);
  if (!keys.length) return null;

  const hit = new Set<string>();
  for (const n of names) {
    const h = normKey(n);
    if (keys.some((k) => isSubseq(k, h))) hit.add(n);
  }
  if (hit.size === 1) return [...hit][0];
  if (hit.size === 0) return null;

  /*
   * 不只一個的時候還有一次機會：完全相等的優先。
   *
   * 「開2」會同時對上「開封2-1」「開封2-2」「開封2F」—— 那要人選。
   * 但如果其中一個就叫「開2」，那沒什麼好選的。
   */
  const exact = [...hit].filter((n) => keys.includes(normKey(n)));
  return exact.length === 1 ? exact[0] : null;
}

/** 下拉選單的排序：對得上的排前面，其餘照原順序。 */
export function rankNames(code: string, aliases: string[], names: string[]): string[] {
  const keys = [code, ...(aliases ?? [])].map(normKey).filter(Boolean);
  const score = (n: string) => (keys.some((k) => isSubseq(k, normKey(n))) ? 0 : 1);
  return names
    .map((n, i) => ({ n, i, s: score(n) }))
    .sort((a, b) => a.s - b.s || a.i - b.i)
    .map((x) => x.n);
}
