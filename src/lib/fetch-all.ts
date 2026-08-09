/**
 * 分頁把整份查詢結果撈完。
 *
 * ============================================================
 * 【為什麼一定要有這支】
 *
 * **Supabase 預設一次最多回傳 1000 列，超過的部分直接不給，而且不報錯。**
 *
 * 沒有錯誤、沒有警告、`error` 是 null —— 只是資料少了一截。
 * 症狀是「數字看起來怪怪的但說不上來哪裡怪」，而且**範圍越大錯越多**：
 * 撈一個月正確、撈一整年就少一截，兩個畫面互相矛盾。
 *
 * 2026-08 財務儀表板就是這樣：年模式看 8 月營收 378 萬、月模式看同一個月
 * 898 萬。因為年模式要撈 12 個月的營收認列，早就破了 1000 列，
 * 後面幾個月被截掉。當時「訂單數」本期與上一期都剛好顯示 1,000 筆 ——
 * 那個整數就是唯一露出來的線索。
 *
 *
 * ============================================================
 * 【為什麼不是把 limit 調大就好】
 *
 * 調大只是把懸崖往後推。資料每天在長，某一天又會踩到，
 * 而那一天沒有人會聯想到是 limit —— 因為上一次踩到是兩年前的事。
 *
 * 分頁撈完才是「不管多少列都對」。多一次來回的成本遠低於一個
 * 沒有人看得出來的錯誤數字。
 */

const PAGE = 1000;

/**
 * @param page 給定 [from, to] 回傳一個查詢。**每次呼叫都要建一個新的**
 *             —— Supabase 的 query builder 被 await 過就不能重用。
 *
 * 用法：
 *   const rows = await fetchAll<Rev>((f, t) =>
 *     supabase.from('revenue_recognitions').select('...').gte('ym', a).lte('ym', b).range(f, t));
 */
export async function fetchAll<T>(
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<{ rows: T[]; error: string | null }> {
  const rows: T[] = [];
  let from = 0;
  // 上限保護：真的有幾十萬列時不要無限撈下去把瀏覽器記憶體吃光。
  // 100 頁 = 10 萬列,遠超過這個系統任何一個區間的合理量 ——
  // 真的撞到這裡代表查詢條件寫錯了,不是資料太多。
  for (let guard = 0; guard < 100; guard++) {
    const { data, error } = await page(from, from + PAGE - 1);
    if (error) return { rows, error: error.message };
    const chunk = data ?? [];
    rows.push(...chunk);
    // 拿到的比一頁少 → 已經是最後一頁
    if (chunk.length < PAGE) return { rows, error: null };
    from += PAGE;
  }
  return { rows, error: '資料超過 10 萬列,查詢條件可能有誤' };
}

/**
 * `.in('col', [很多值])` 的安全版本。
 *
 * 【兩個獨立的坑，要一起處理】
 *
 * 1. **回傳列數的 1000 上限**（同上）。
 * 2. **`.in()` 的參數本身太長**：值一多，PostgREST 會把它塞進 URL 的查詢字串，
 *    幾千個 id 就會超過伺服器的 URL 長度上限，整個請求失敗（或被截斷）。
 *
 * 所以輸入要切塊，**而且每一塊還要分頁** —— 因為比對的欄位不一定是唯一的。
 * 比對 `reviews.airbnb_review_id`（唯一）時一塊最多回一塊的量；
 * 但比對 `orders.checkout`（一天可能有幾十筆）時，200 個日期可能回好幾千列。
 *
 * 【為什麼這個坑特別惡劣】
 * 這種查詢通常是拿來問「哪些已經存在了」。被截斷的話，
 * 已存在的資料會被當成新的 —— 輕則統計數字錯，重則覆蓋掉既有內容。
 * `/api/import/reviews` 就是後者：它靠這個查詢保住已經翻譯成中文的評論，
 * 撈不全就會被英文原文蓋回去，而翻譯是花錢叫 API 翻的。
 */
export async function fetchIn<T>(
  values: string[],
  page: (chunk: string[], from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  chunkSize = 300,
): Promise<{ rows: T[]; error: string | null }> {
  const rows: T[] = [];
  const uniq = Array.from(new Set(values.filter(Boolean)));
  for (let i = 0; i < uniq.length; i += chunkSize) {
    const slice = uniq.slice(i, i + chunkSize);
    const r = await fetchAll<T>((f, t) => page(slice, f, t));
    rows.push(...r.rows);
    if (r.error) return { rows, error: r.error };
  }
  return { rows, error: null };
}
