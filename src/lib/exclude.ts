/**
 * 「排除」型的篩選。
 *
 * ══════════════════════════════════════════════════════════
 * ★★★ 跟「選一個看」是相反的預設（2026-09-21 使用者指定）
 *
 * 「選物業」是**預設什麼都沒選**，要看哪一棟就挑哪一棟。
 * 「排除物業」是**預設全部都在**，把不想看的踢出去 ——
 * 七棟裡面不想看一棟，前者要勾六次，後者只要勾一次。
 *
 * ★★ 所以空陣列的意思在兩邊是**相反的**：
 *     選：空 ＝ 全部都在（沒篩）
 *     排除：空 ＝ 全部都在（沒排除）
 *   剛好都是「全部都在」，但「全部都被勾起來」在前者是沒篩、
 *   在後者是**一筆都不剩**。這支不讓那件事發生（見 `toggleExcl`）。
 * ══════════════════════════════════════════════════════════
 *
 * ★ 寫在 `.ts` 不是 `.tsx` —— 測試環境不處理 JSX。
 */

/** 這個 key 被排除了嗎 */
export function isExcluded(excl: readonly string[], key: string): boolean {
  return (excl ?? []).includes(key);
}

/**
 * 點一下排除、再點一下放回來。
 *
 * ★★★ **不准把全部都排除掉**。全排掉的話整頁變成 0 —— 營收 0、
 *   支出 0、成長率 0%，而那看起來像「系統壞了」或「這期沒生意」，
 *   不像「是我自己把東西全部關掉了」。最後一個留著，並且回 `null`
 *   讓畫面可以講出為什麼按不動（anxing-ui 二-6:灰掉的按鈕要說得出原因）。
 */
export function toggleExcl(
  excl: readonly string[], key: string, allKeys: readonly string[],
): string[] | null {
  const set = new Set(excl ?? []);
  if (set.has(key)) {
    set.delete(key);
  } else {
    if (set.size + 1 >= (allKeys ?? []).length) return null;   // 會全排掉 → 擋住
    set.add(key);
  }
  /* ★ 順序照 allKeys，不是照點擊順序 —— 不然每次顯示的字串會跳 */
  return (allKeys ?? []).filter((k) => set.has(k));
}

/**
 * 排除狀態寫成一行字。
 *
 * ★★ 封頂:排除三個以上就寫數量。名字一長會把旁邊的東西推歪
 *   （跟來源膠囊那邊同一條規矩）。
 */
export function exclLabel(names: readonly string[], max = 2): string {
  const ns = (names ?? []).filter((n) => String(n ?? '').trim() !== '');
  if (!ns.length) return '全部物業';
  if (ns.length <= max) return `排除 ${ns.join('、')}`;
  return `排除 ${ns.length} 個物業`;
}

/**
 * 「新增項目」＝ 上一期是 0、這一期有數字的那些。
 *
 * ★★★ 它們是讓環比失真的主要原因:分母 0 的成長率沒有意義，
 *   而畫面上會印成一個很大的百分比或「新增」。
 *
 * ★★ 這支**還沒接上畫面**（使用者 2026-09-21 沒有明確要）——
 *   要接一顆「排除新增項目」的時候直接拿它的結果丟進 `excl` 就好。
 *   先寫成獨立函式是因為判斷式一旦寫在 `.tsx` 裡就測不到。
 */
export function newKeys(
  cur: Readonly<Record<string, number>>,
  prev: Readonly<Record<string, number>>,
): string[] {
  return Object.keys(cur ?? {})
    .filter((k) => (Number(cur[k]) || 0) !== 0 && (Number(prev?.[k]) || 0) === 0)
    .sort();
}
