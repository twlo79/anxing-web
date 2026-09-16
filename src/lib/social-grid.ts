/**
 * IG 版面模擬的排版算式（2026-09-16 使用者指定）。
 *
 * ============================================================
 * 【★★★ 三套編號，不准混在一起】
 *
 *   序號  發佈順序。#1 最早貼，數字越大越新。**跟釘選無關**。
 *   格位  版面上第幾格，左上角是 0。**釘選會改變它**。
 *   切片  一張切圖的第幾張（左→右、上→下），從 0 開始。
 *
 * 畫面上圓圈裡的數字一律是**序號**。切圖的發佈順序也用序號講 ——
 * 不另外發明一套區域編號，否則人得先分辨自己在看哪一套。
 *
 * ★★ 序號用**陣列順序**算，格位用**版面順序**算。兩件事分開：
 *   釘選把一格拉到最上面，但它還是一則舊貼文。
 *   讓序號跟著版面跑的話，那個數字就不再是發佈順序而是位置，
 *   而「先貼哪一張」正是切圖唯一需要答案的問題。
 *
 * ============================================================
 * 【為什麼在 lib 不在 page】
 *
 * 測試環境不處理 JSX（anxing-ui 第一節）。而這一頁真正會錯的東西
 * 全部是算出來的:哪一格在哪、誰先貼、切圖有沒有歪、釘選還剩幾格。
 * 寫在 `.tsx` 裡就一條都測不到。
 */

/** IG 上限：最多釘 3 則到個人檔案最上方 */
export const PIN_MAX = 3;

/** 九宮格一排三格 */
export const COLS = 3;

/**
 * 一格的像素。
 *
 * ★★★ **4:5，不是正方形**。Instagram 2025 年初把個人檔案的九宮格
 *   從 1:1 改成 4:5（1080×1350）。照正方形切的話，切出來的圖
 *   貼上去會被再裁一次 —— 而接縫就對不上了。
 */
export const CELL_W = 1080;
export const CELL_H = 1350;

/**
 * 文案在第幾個字之後收成「⋯更多」。
 *
 * ★ 這是 IG 的行為而且會變。只寫在這裡一個地方 ——
 *   畫面上那行提示也讀這個常數，改一次就兩邊一起改。
 */
export const CAPTION_CUT = 125;

/** 切圖可以跨幾格。1 就是普通貼文 */
export const SPANS = [3, 6, 9] as const;

export type Status = 'draft' | 'scheduled' | 'published';

/**
 * 版面上的一筆。貼文是 `span = 1`，切圖是 3／6／9。
 *
 * ★ 只放**排版需要的欄位**。照片、文案、日期不在這裡 ——
 *   那些東西不影響任何一格落在哪，混進來只會讓測試要準備一堆假資料。
 */
export type Item = {
  id: string;
  /** 佔幾格。貼文 1，切圖 3／6／9 */
  span: number;
  /** 0 ＝ 沒釘。1 起算 ＝ 第幾個釘選 */
  pin: number;
  status: Status;
};

/** 版面上的一格 */
export type GridCell<T extends Item = Item> = {
  item: T;
  /** 這一格是這筆的第幾張切片。貼文永遠 0 */
  slice: number;
  /** 版面位置，左上角是 0 */
  at: number;
  /** 發佈序號，1 最舊 */
  seq: number;
};

/* ────────────────────────────────────────────────────────── */

const spanOf = (it: Item) => (it.span > 0 ? it.span : 1);

/** 全部佔幾格 */
export function totalCells(items: readonly Item[]): number {
  return items.reduce((n, it) => n + spanOf(it), 0);
}

/**
 * 排出整面牆。
 *
 * ★★ 順序是「釘選的（照 pin 由小到大）→ 其餘（照陣列順序）」。
 *   陣列本身是**新→舊**，所以不釘任何東西時，左上角就是最新的那一則。
 *
 * ★★★ `seq` 走的是**陣列順序**，不是版面順序 —— 見檔頭。
 */
export function layout<T extends Item>(items: readonly T[]): GridCell<T>[] {
  const total = totalCells(items);

  // ① 序號：陣列順序（新→舊）。釘選不影響
  const seq0 = new Map<string, number>();
  let k = 0;
  for (const it of items) { seq0.set(it.id, total - k); k += spanOf(it); }

  // ② 版面順序：釘選的排前面
  const pins = items.filter((x) => x.pin > 0).slice()
    .sort((a, b) => a.pin - b.pin);
  const rest = items.filter((x) => !(x.pin > 0));

  const cells: GridCell<T>[] = [];
  let at = 0;
  for (const it of [...pins, ...rest]) {
    const base = seq0.get(it.id) ?? 0;
    for (let s = 0; s < spanOf(it); s++) {
      cells.push({ item: it, slice: s, at: at + s, seq: base - s });
    }
    at += spanOf(it);
  }
  return cells;
}

/* ── 釘選 ───────────────────────────────────────────────── */

/** 釘選用掉幾格。★ 算的是**格數**不是筆數 —— 一張跨 3 格的切圖吃掉 3 格額度 */
export function pinnedCells(items: readonly Item[]): number {
  return items.filter((x) => x.pin > 0).reduce((n, it) => n + spanOf(it), 0);
}

/**
 * 這一筆釘得上去嗎。
 *
 * ★ 回傳**理由**不是只回 false —— 一顆灰掉而不解釋的勾選框，
 *   使用者會以為是壞掉（anxing-ui 二-6）。
 */
export function canPin(items: readonly Item[], it: Item): { ok: boolean; why: string } {
  if (it.pin > 0) return { ok: true, why: '' };
  const sp = spanOf(it);
  if (sp > PIN_MAX) {
    return { ok: false, why: `這張要 ${sp} 格，IG 最多只能釘 ${PIN_MAX} 格。` };
  }
  const used = pinnedCells(items);
  if (used + sp > PIN_MAX) {
    return { ok: false, why: `已經釘了 ${used} 格，再加 ${sp} 格會超過上限 ${PIN_MAX} 格。` };
  }
  return { ok: true, why: '' };
}

/**
 * 釘選編號重排。取消其中一個之後不要留下 1、3 這種洞。
 *
 * ★★★ 編的是**格的位置**，不是第幾筆。
 *   一張跨 3 格的切圖釘在最前面時，它的三格分別是 1、2、3 ——
 *   下一筆就沒有位子了。照「第幾筆」編的話，
 *   切圖是 1 而下一筆也會拿到 2，兩邊的格位就撞在一起。
 */
export function renumberPins<T extends Item>(items: readonly T[]): T[] {
  const order = items.filter((x) => x.pin > 0).slice().sort((a, b) => a.pin - b.pin);
  const start = new Map<string, number>();
  let n = 1;
  for (const x of order) { start.set(x.id, n); n += spanOf(x); }
  return items.map((x) => (x.pin > 0 ? { ...x, pin: start.get(x.id) ?? 0 } : x));
}

/* ── 切圖對齊 ───────────────────────────────────────────── */

/**
 * 這一筆錯開幾格。0 ＝ 對齊。
 *
 * ★★★ 切圖必須從**每一排的第一格**開始，否則整張圖是斜的。
 *   而它前面有幾格，取決於釘選了幾格 ＋ 前面有幾則貼文 ——
 *   兩個來源都會動，所以這件事一定要算，不能靠人數。
 */
export const skewAt = (at: number) => at % COLS;

export type Misaligned<T extends Item = Item> = {
  item: T;
  /** 版面位置（0 起算） */
  at: number;
  /** 錯開幾格（1 或 2） */
  skew: number;
  /** 往下推幾格就對齊了 */
  push: number;
};

/** 哪幾張切圖歪了。貼文不算 —— 一格的東西放哪裡都不會歪 */
export function misaligned<T extends Item>(cells: readonly GridCell<T>[]): Misaligned<T>[] {
  const out: Misaligned<T>[] = [];
  for (const c of cells) {
    if (c.slice !== 0 || spanOf(c.item) === 1) continue;
    const skew = skewAt(c.at);
    if (skew) out.push({ item: c.item, at: c.at, skew, push: COLS - skew });
  }
  return out;
}

/**
 * 釘選有沒有把整面牆推歪。
 *
 * ★★ 釘 3 格剛好一整排，底下不動；釘 1 格或 2 格，**底下每一格都往後挪**，
 *   於是原本對齊的切圖全部歪掉。這是最容易讓人以為「切圖功能壞了」的來源 ——
 *   而真正動到的是上面那顆 📌。
 */
export function pinShift(items: readonly Item[]): number {
  return pinnedCells(items) % COLS;
}

/* ── 切片 ───────────────────────────────────────────────── */

/** 跨 N 格的原圖要多大 */
export function sourceSize(span: number): { w: number; h: number } {
  const cols = span === 1 ? 1 : COLS;
  const rows = span === 1 ? 1 : span / COLS;
  return { w: cols * CELL_W, h: rows * CELL_H };
}

/** 第 `slice` 張在原圖上的哪一塊（給 canvas 用） */
export function sliceCrop(span: number, slice: number): {
  cols: number; rows: number; cx: number; cy: number;
  sx: number; sy: number; sw: number; sh: number;
} {
  const cols = span === 1 ? 1 : COLS;
  const rows = span === 1 ? 1 : span / COLS;
  const cx = slice % cols;
  const cy = Math.floor(slice / cols);
  return {
    cols, rows, cx, cy,
    sx: cx * CELL_W, sy: cy * CELL_H, sw: CELL_W, sh: CELL_H,
  };
}

/**
 * 第 `slice` 張在畫面上的 `background-size` / `background-position`。
 *
 * ★ 跟 `sliceCrop()` 是**同一份座標**的兩種寫法（一個給瀏覽器排版、
 *   一個給 canvas 切檔）。各算一次的話，預覽跟切出來的圖會差一點點，
 *   而那一點點正好就在接縫上。
 */
export function sliceBg(span: number, slice: number): {
  size: string; position: string;
} {
  const { cols, rows, cx, cy } = sliceCrop(span, slice);
  const px = cols > 1 ? (cx / (cols - 1)) * 100 : 0;
  const py = rows > 1 ? (cy / (rows - 1)) * 100 : 0;
  return { size: `${cols * 100}% ${rows * 100}%`, position: `${px}% ${py}%` };
}

/**
 * 發佈順序：序號由小到大。
 *
 * ★★★ **是反的**。IG 最新的貼在左上角，所以要拼出一張完整的圖，
 *   得從**最右下那一張**開始貼，最後才貼最左上那一張。
 *   貼反的話圖會左右顛倒，而已經貼出去的刪掉重貼會掉讚數。
 *
 * 回傳 `{ slice, seq }`，照**該貼的順序**排好。
 */
export function publishOrder(span: number, seqOfFirstSlice: number)
: { slice: number; seq: number }[] {
  const out: { slice: number; seq: number }[] = [];
  for (let s = span - 1; s >= 0; s--) out.push({ slice: s, seq: seqOfFirstSlice - s });
  return out;
}

/**
 * 切片的檔名。**一定要帶順序**。
 *
 * ★ 不帶的話，人到了手機上還是會貼反 —— 而那正是這整支要防的事。
 *   `estia_01_先貼.png`、`estia_02.png`、`estia_03_最後.png`
 */
export function sliceFileName(prefix: string, nth: number, total: number): string {
  /*
   * ★★ 用**黑名單**擋掉檔案系統不收的字元，不要用 `[^\w]` 白名單 ——
   *   JS 的 `\w` 不含中文，白名單會把「安幸上工」整個吃掉，
   *   切出來的三個檔案變成 `_01`、`_02`、`_03`，看不出是哪個帳號的。
   */
  const p = (prefix || 'ig')
    .replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_')
    .replace(/\s+/g, '_')
    .replace(/^[._]+|[._]+$/g, '') || 'ig';
  const n = String(nth).padStart(2, '0');
  const tail = total > 1 && nth === 1 ? '_先貼'
    : total > 1 && nth === total ? '_最後' : '';
  return `${p}_${n}${tail}.png`;
}

/* ── 文案 ───────────────────────────────────────────────── */

/**
 * 文案在哪裡被收起來。
 *
 * ★★ IG 大約 125 個字後收成「⋯更多」。**前兩行決定會不會被點開**，
 *   而那是文案唯一要通過的測驗。所以回傳的是「看得到的那一段」
 *   與「被藏起來的那一段」，不是一個字數 —— 只給字數的話，
 *   人要自己去換算哪裡斷掉。
 */
export function captionCut(cap: string): {
  visible: string; hidden: string; len: number; over: number;
} {
  const c = cap ?? '';
  return {
    visible: c.slice(0, CAPTION_CUT),
    hidden: c.slice(CAPTION_CUT),
    len: c.length,
    over: Math.max(0, c.length - CAPTION_CUT),
  };
}
