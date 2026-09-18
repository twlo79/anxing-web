/**
 * IG 一則放多張圖（輪播）。
 *
 * ══════════════════════════════════════════════════════════
 * 【使用者 2026-09-18】
 *   「可以放多張圖片 像 IG 一則貼文可以放多張滑過去」
 *   「甲 左右改成換照片」
 *   「換一則 要跳出來 —— 跳到九宮格，之後再點下一則」
 *
 * ══════════════════════════════════════════════════════════
 * 【★★★ 照片存在哪：只有 `images` 一個地方】
 *
 * `social_posts.images text[]` 本來是 FB 拼貼在用的（migration_261），
 * IG 走 `image_path`。現在 IG 也要多張 —— **共用同一欄**，
 * 不另外開一張表也不再多一欄。
 *
 * ★ 讀的入口只有 `photosOf()`（fb-wall.tsx，全站唯一一份）:
 *   `images` 有東西就用它，空的才退回 `image_path`。
 *   所以舊的那幾則不用改也看得到。
 * ★★ 寫的入口只有 `images`。migration_283 把舊的 `image_path`
 *   搬進去了，之後那一欄只是保險絲，不再是真實來源 ——
 *   **一份資料存在兩個地方**是 migration_195 那條坑（deposits.amount
 *   與 lines 各存一次，改了一邊另一邊留在原地，不報錯、總額正常、
 *   只有畫面上的數字是舊的）。
 *
 * ══════════════════════════════════════════════════════════
 * 【★★ 為什麼上限只擋 IG】
 *
 * 10 張是 **IG 自己的限制**。FB 用同一欄但沒有這個上限
 * （拼貼只露前 5 張，其餘照樣存著）。
 * 所以上限擋在**這一支**（IG 的畫面才呼叫），不是擋在資料庫 ——
 * 加在欄位上的話 FB 那邊會莫名其妙存不進第 11 張。
 *
 * ══════════════════════════════════════════════════════════
 * 【為什麼寫在 .ts 不是 .tsx】
 * 測試環境不處理 JSX。加幾張、換順序、拿掉哪一張、超過上限怎麼辦 ——
 * 這些寫在 `.tsx` 裡的話測不到（CLAUDE.md）。
 * ══════════════════════════════════════════════════════════
 */

/** IG 一則最多幾張。★ 這是 IG 的限制，不是我們訂的。 */
export const MAX_IG_PHOTOS = 10;

/** 加照片的結果。`dropped` 是因為超過上限而沒收下的張數。 */
export type AddResult = { next: string[]; dropped: number };

/**
 * 加幾張進去。
 *
 * ★★★ 超過上限時**收下前面能收的、告訴人丟了幾張**，
 *   不是整批拒絕也不是安靜吃掉。
 *   整批拒絕 → 選了 12 張結果一張都沒進去;
 *   安靜吃掉 → 他以為 12 張都在，發佈時才發現少了兩張。
 */
export function addPhotos(cur: readonly string[], add: readonly string[]): AddResult {
  const base = (cur ?? []).filter(Boolean);
  const room = Math.max(0, MAX_IG_PHOTOS - base.length);
  const take = (add ?? []).filter(Boolean);
  return { next: [...base, ...take.slice(0, room)], dropped: Math.max(0, take.length - room) };
}

/**
 * 把第 `i` 張往前（-1）或往後（+1）。
 *
 * ★ 動不了就**原樣回傳同一個陣列** —— 畫面那邊可以直接比對是不是同一個，
 *   不會多存一次檔（存檔會跳「✓ 已存」，什麼都沒改卻跳一下很怪）。
 */
export function movePhoto(cur: readonly string[], i: number, d: -1 | 1): string[] {
  const a = [...(cur ?? [])];
  const j = i + d;
  if (i < 0 || i >= a.length || j < 0 || j >= a.length) return a;
  [a[i], a[j]] = [a[j], a[i]];
  return a;
}

/** 拿掉第 `i` 張。 */
export function removePhoto(cur: readonly string[], i: number): string[] {
  const a = [...(cur ?? [])];
  if (i < 0 || i >= a.length) return a;
  a.splice(i, 1);
  return a;
}

/**
 * 「加照片」這顆按不下去的理由。`null` ＝ 按得下去。
 *
 * ★ 灰掉的按鈕要說得出為什麼（anxing-ui 二-6）——
 *   一顆灰掉而不解釋的鈕，使用者會以為是系統壞了而一直點。
 */
export function whyCannotAdd(cur: readonly string[]): string | null {
  const n = (cur ?? []).filter(Boolean).length;
  return n >= MAX_IG_PHOTOS ? `已經 ${MAX_IG_PHOTOS} 張了 —— IG 一則最多放 ${MAX_IG_PHOTOS} 張` : null;
}

/** 收下之後要跟人講的那句話。`null` ＝ 沒事，不用講。 */
export function addMessage(r: AddResult): string | null {
  if (r.dropped <= 0) return null;
  return `只加了前面幾張 —— IG 一則最多 ${MAX_IG_PHOTOS} 張，有 ${r.dropped} 張沒收下。`;
}

/* ══════════════════════════════════════════════════════════
 * 輪播的位置
 * ══════════════════════════════════════════════════════════ */

/**
 * 換照片。**到頭就停，不繞回去。**
 *
 * ★★★ 這一點跟「換一則」相反（那個是循環的）。理由:
 *   輪播到最後一張再按一下就跳回第一張的話，看的人以為自己按到別的東西了 ——
 *   IG 本身也是到頭就停。
 * ★ 停住的那一顆**整顆不出現**，不是灰掉（anxing-ui 二-6 / 三）。
 */
export function stepPhoto(i: number, d: -1 | 1, total: number): number {
  const n = i + d;
  if (n < 0 || n >= total) return i;
  return n;
}

/**
 * 換了一則之後，輪播要停在第幾張。
 *
 * ★★ 一律回到第 **0** 張。留在上一則的第 3 張的話，
 *   下一則只有 1 張時畫面會是空的 —— 而那看起來像「照片不見了」。
 */
export const RESET_INDEX = 0;

/** 夾在範圍內。`total` 是 0 時回 0。 */
export function clampIndex(i: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(Math.max(0, i), total - 1);
}
