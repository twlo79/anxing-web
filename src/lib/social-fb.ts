/**
 * 社群模擬 —— Facebook 那一半的算式（2026-09-17 使用者指定「分成 IG 跟 FB」）。
 *
 * ============================================================
 * 【★★★ FB 跟 IG 差在哪 —— 不是換個外框而已】
 *
 *   IG　　一則貼文 ＝ 一格。會錯的是**格子歪不歪**（切圖跨排）。
 *   FB　　一則貼文 ＝ 一張拼貼。會錯的是**哪幾張圖被蓋掉**。
 *
 * 使用者 2026-09-17 給的截圖：一則 11 張圖的貼文，FB 只讓 5 張露臉 ——
 * 上面 2 張大的、下面 3 張小的，最後一格蓋著「+6」。
 * **第 6 張以後沒有任何人看得到。**
 *
 * ★★ 這跟 IG 的「切圖歪了」是同一種病:發出去才發現，而發出去就改不了了。
 *   這一頁存在的理由就是先看到 —— 所以拼貼一定要**照 FB 的規則畫**，
 *   不能拿九宮格湊。
 *
 * ============================================================
 * 【為什麼在 lib 不在 page】
 *
 * 測試環境不處理 JSX。而這一頁真正會錯的東西全部是算出來的：
 * 幾張圖排成什麼形狀、第幾張開始被蓋掉、文案在哪裡被收起來、
 * 置頂能不能再加一則。寫在 `.tsx` 裡就一條都測不到。
 */

/* ── 平台 ─────────────────────────────────────────────────── */

export const PLATFORMS = ['ig', 'fb'] as const;
export type Platform = (typeof PLATFORMS)[number];

export const PLATFORM_LABEL: Record<Platform, string> = {
  ig: 'Instagram',
  fb: 'Facebook',
};

/** 側欄與標題上的短名 */
export const PLATFORM_SHORT: Record<Platform, string> = { ig: 'IG', fb: 'FB' };

export function isPlatform(x: unknown): x is Platform {
  return x === 'ig' || x === 'fb';
}

/**
 * 把資料庫／網址讀回來的值變成平台。
 *
 * ★★★ 認不得的一律當 **'ig'**，不是丟掉也不是回 null。
 *   理由:現有的 2 個帳號本來就是 IG。回 null 的話它們在兩個平台底下
 *   **都不會出現** —— 畫面上是一個很正常的「還沒有帳號」，
 *   沒有任何錯誤訊息，而使用者看到的是「帳號不見了」。
 */
export function parsePlatform(raw: unknown): Platform {
  return isPlatform(raw) ? raw : 'ig';
}

export function platformLabel(raw: unknown): string {
  return PLATFORM_LABEL[parsePlatform(raw)];
}

/* ── 拼貼 ─────────────────────────────────────────────────── */

/**
 * 拼貼用 6 欄的格子描述。
 *
 * ★ 用 6 不用 2 或 3，是因為「5 張以上」的下排是**三等分**、
 *   上排是**二等分** —— 6 是唯一同時整除的欄數。
 *   這個數字只給 CSS grid 用，跟 FB 無關。
 */
export const FB_COLS = 6;

/**
 * 最多幾張看得到。第 6 張以後蓋在「+N」底下。
 *
 * ★★ 這是 FB 行動版的行為（使用者 2026-09-17 的截圖：11 張 → 5 張 ＋ +6）。
 */
export const FB_VISIBLE_MAX = 5;

/*
 * ★★★ 這裡**沒有**「FB 一則最多幾張」的常數，是故意的。
 *
 *   我本來寫了 `FB_PHOTO_MAX = 10`，憑印象。而使用者 2026-09-17 的截圖
 *   就是**一則 11 張** —— 那個上限根本不存在，是我編的。
 *   測試當場抓到（11 張撞上假上限，回了「最多 10 張」而不是「+6」）。
 *
 * ★ 唯一有證據的限制是「只有 5 張看得到」，而那也是唯一要緊的一條。
 *   不知道的數字就不要寫進常數 —— 寫了它會被當成規格。
 */

/**
 * 粉專最多置頂幾則。
 *
 * ★★★ **是 1，不是 3**。IG 可以釘 3 則，FB 粉專只能置頂一則 ——
 *   多設的那幾則在 FB 上是**無效的**，而畫面上看不出來。
 */
export const FB_PIN_MAX = 1;

export type FbTile = {
  /** 原圖的第幾張，0 起算 */
  i: number;
  /** grid 欄起點（0 ～ FB_COLS-1）與跨幾欄 */
  c: number;
  cw: number;
  /** grid 列起點與跨幾列 */
  r: number;
  rh: number;
  /** 蓋在這一格上的「+N」。0 ＝ 沒有蓋 */
  more: number;
};

export type FbCollage = {
  tiles: FbTile[];
  /** 排不進去、沒有人看得到的張數 */
  hidden: number;
  /** grid-template-rows 的比例。長度 ＝ 有幾列 */
  rows: number[];
};

const T = (i: number, c: number, cw: number, r: number, rh: number, more = 0): FbTile =>
  ({ i, c, cw, r, rh, more });

/**
 * 幾張圖排成什麼樣。
 *
 * ```
 *  1 張   整張
 *  2 張   左右各半
 *  3 張   左邊一大、右邊兩小
 *  4 張   2×2
 *  5 張+  上排 2 大、下排 3 小，最後一格蓋「+N」
 * ```
 *
 * ★★ 負數與小數都收成 0 —— 這支的輸入來自「使用者傳了幾張圖」，
 *   而那個數字經過 `length`、`Number()`、資料庫來回好幾手。
 */
export function fbCollage(count: number): FbCollage {
  const n = Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0;

  if (n === 0) return { tiles: [], hidden: 0, rows: [] };
  if (n === 1) return { tiles: [T(0, 0, 6, 0, 1)], hidden: 0, rows: [1] };
  if (n === 2) {
    return { tiles: [T(0, 0, 3, 0, 1), T(1, 3, 3, 0, 1)], hidden: 0, rows: [1] };
  }
  if (n === 3) {
    /* 左邊那張跨兩列 —— 所以它是「一大」，右邊兩張各佔一列 */
    return {
      tiles: [T(0, 0, 3, 0, 2), T(1, 3, 3, 0, 1), T(2, 3, 3, 1, 1)],
      hidden: 0,
      rows: [1, 1],
    };
  }
  if (n === 4) {
    return {
      tiles: [T(0, 0, 3, 0, 1), T(1, 3, 3, 0, 1), T(2, 0, 3, 1, 1), T(3, 3, 3, 1, 1)],
      hidden: 0,
      rows: [1, 1],
    };
  }

  /*
   * 5 張以上。
   * ★★★ 只有前 5 張進得來 —— 第 6 張以後**沒有人看得到**，
   *   所以 `hidden` 一定要回出去，畫面才叫得出來。
   */
  const hidden = n - FB_VISIBLE_MAX;
  return {
    tiles: [
      T(0, 0, 3, 0, 1), T(1, 3, 3, 0, 1),
      T(2, 0, 2, 1, 1), T(3, 2, 2, 1, 1), T(4, 4, 2, 1, 1, hidden),
    ],
    hidden,
    /* 上排比下排高 —— FB 就是這個比例 */
    rows: [1.5, 1],
  };
}

/** 這則貼文有幾張看得到。★ 給畫面上那句「11 張裡看得到 5 張」用 */
export function fbVisibleCount(count: number): number {
  const n = Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0;
  return Math.min(n, FB_VISIBLE_MAX);
}

/**
 * 圖太多的警告。
 *
 * ★ 回**理由**不是只回一個布林 —— 畫面上要寫得出「多的那 6 張沒有人看得到」，
 *   而那句話要講出是哪幾張、為什麼。
 */
export function fbPhotoWarn(count: number): { over: number; why: string } {
  const n = Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0;
  if (n > FB_VISIBLE_MAX) {
    return {
      over: n - FB_VISIBLE_MAX,
      why: `${n} 張裡只有前 ${FB_VISIBLE_MAX} 張看得到，`
        + `第 ${FB_VISIBLE_MAX + 1} 張以後蓋在「+${n - FB_VISIBLE_MAX}」底下。`
        + `要每一張都被看到的話，拆成兩則。`,
    };
  }
  return { over: 0, why: '' };
}

/* ── 置頂 ─────────────────────────────────────────────────── */

export type FbPinItem = { id: string; pin: number };

/** 目前置頂了幾則 */
export function fbPinnedCount(items: readonly FbPinItem[]): number {
  return items.filter((x) => x.pin > 0).length;
}

/**
 * 這一則置頂得上去嗎。
 *
 * ★ 跟 IG 的 `canPin()` 不同:IG 算的是**格數**（切圖吃掉 3 格），
 *   FB 算的是**則數**，而上限是 1。
 */
export function fbCanPin(items: readonly FbPinItem[], it: FbPinItem): { ok: boolean; why: string } {
  if (it.pin > 0) return { ok: true, why: '' };
  const used = fbPinnedCount(items.filter((x) => x.id !== it.id));
  if (used >= FB_PIN_MAX) {
    return {
      ok: false,
      why: `FB 粉專只能置頂 ${FB_PIN_MAX} 則。要換這一則的話，先把原本那則取消置頂。`,
    };
  }
  return { ok: true, why: '' };
}

/**
 * 置頂設超過一則了 —— 這在 FB 上是**無效的**，而畫面上看不出來。
 *
 * ★★ 這支存在是因為資料可能從別的地方變壞（兩個人同時改、
 *   或帳號從 IG 改成 FB 把 3 則釘選帶過來）。
 *   `fbCanPin()` 擋的是「再加一則」，這支問的是「現在對不對」。
 */
export function fbPinProblem(items: readonly FbPinItem[]): { bad: boolean; n: number; why: string } {
  const n = fbPinnedCount(items);
  if (n <= FB_PIN_MAX) return { bad: false, n, why: '' };
  return {
    bad: true,
    n,
    why: `置頂了 ${n} 則，但 FB 粉專只吃 ${FB_PIN_MAX} 則 —— `
      + `多出來的 ${n - FB_PIN_MAX} 則貼到 FB 上不會置頂。`,
  };
}

/* ── 排序 ─────────────────────────────────────────────────── */

export type FbOrderItem = { id: string; pin: number };

/**
 * 牆上的順序：置頂的在最上面，其餘照陣列順序（新→舊）。
 *
 * ★ 跟 IG 的 `layout()` 同一個規則，但**不切格子** ——
 *   FB 是一則一則往下，沒有「跨排」這回事。
 */
export function fbOrder<T extends FbOrderItem>(items: readonly T[]): T[] {
  const pins = items.filter((x) => x.pin > 0).slice().sort((a, b) => a.pin - b.pin);
  const rest = items.filter((x) => !(x.pin > 0));
  return [...pins, ...rest];
}

/* ── 文案 ─────────────────────────────────────────────────── */

/**
 * FB 收成「See more」之前看得到幾行。
 *
 * ★★★ FB 是**照行數**收的，不是照字數 —— 跟 IG 不一樣。
 *   所以按到 Enter 換行也算一行，三行就滿了。
 *   ★ 這個數字是照使用者 2026-09-17 的截圖量的（3 行後接 more），
 *     會隨 FB 改版與裝置寬度變動。只寫在這裡一個地方。
 */
export const FB_CAPTION_LINES = 3;

/**
 * 一行大概放幾個全形字。
 *
 * ★★ 是**估計值**，不是 FB 的規格 —— 實際看裝置寬度與字級。
 *   所以畫面上的提示要寫「大約」，不要寫死「第 66 個字」。
 */
export const FB_LINE_CHARS = 22;

/** 半形當半個字寬 —— 不這樣算的話，一整行英文會被算成兩行 */
const widthOf = (s: string): number => {
  let w = 0;
  for (const ch of s) w += /[\x00-\x7f]/.test(ch) ? 0.5 : 1;
  return w;
};

/**
 * 把文案折成 FB 看到的行。硬換行（`\n`）各自算一行。
 *
 * ★ 空字串回 `[]` 不是 `['']` —— 「沒有文案」跟「有一行空的」
 *   在畫面上要長得不一樣（前者不佔位，後者佔一行）。
 */
export function fbWrap(cap: string, perLine: number = FB_LINE_CHARS): string[] {
  const src = cap ?? '';
  if (!src) return [];
  const out: string[] = [];
  for (const para of src.split('\n')) {
    if (para === '') { out.push(''); continue; }
    let line = '';
    for (const ch of para) {
      if (widthOf(line + ch) > perLine && line !== '') { out.push(line); line = ch; }
      else line += ch;
    }
    out.push(line);
  }
  return out;
}

/**
 * 文案在哪裡被收起來。
 *
 * 回「看得到的那幾行」與「被藏起來的那一段」，不是一個數字 ——
 * 只給數字的話，人要自己去換算哪裡斷掉（跟 IG 的 `captionCut()` 同一個理由）。
 */
export function fbCaptionCut(cap: string, perLine: number = FB_LINE_CHARS): {
  lines: string[];
  visible: string;
  hidden: string;
  total: number;
  over: number;
} {
  const all = fbWrap(cap ?? '', perLine);
  const lines = all.slice(0, FB_CAPTION_LINES);
  const rest = all.slice(FB_CAPTION_LINES);
  return {
    lines,
    visible: lines.join('\n'),
    hidden: rest.join('\n'),
    total: all.length,
    over: rest.length,
  };
}

/* ── 檔案頭 ───────────────────────────────────────────────── */

/**
 * 檔案頭那一行數字。
 *
 * ★ FB 的順序是 followers → following → posts，
 *   而 IG 是 posts → followers → following。**兩邊不一樣**，
 *   所以這一行不共用 —— 共用的話會有一邊是錯的順序而沒有人發現。
 *
 * ★★ 空的欄位畫成「—」不是 0 —— 這一頁沒有連 FB，
 *   那些數字是裝飾。寫 0 會被當成「真的是 0 個追蹤者」。
 */
export function fbProfileStat(
  followers: string | null | undefined,
  following: string | null | undefined,
  posts: number,
): string {
  const v = (s: string | null | undefined) => {
    const t = (s ?? '').trim();
    return t === '' ? '—' : t;
  };
  return `${v(followers)} followers · ${v(following)} following · ${posts} posts`;
}
