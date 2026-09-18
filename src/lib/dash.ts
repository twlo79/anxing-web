/**
 * 財務儀表板：分頁 ＋ 營收來源膠囊。
 *
 * ══════════════════════════════════════════════════════════
 * 【使用者 2026-09-18】
 *   「財務儀錶板 裡面分一下 各種 tab」
 *   「統一 上面有期間 filter 物業 filter」
 *   「營收來源 膠囊 可以點 計算所有營收，做得像互動式的」
 *
 * ══════════════════════════════════════════════════════════
 * 【為什麼寫在 .ts】
 * 「哪一頁放哪幾塊」「膠囊在這一頁能不能用」「點了之後算出什麼」——
 * 全是判斷式。測試環境不處理 JSX，寫在 `.tsx` 裡測不到（CLAUDE.md）。
 * ══════════════════════════════════════════════════════════
 */

/* ══════════════════════════════════════════════════════════
 * 分頁
 * ══════════════════════════════════════════════════════════ */

export const DASH_TABS = [
  { key: 'revenue', label: '營收分析' },
  { key: 'compare', label: '財報比較' },
  { key: 'expense', label: '支出分析' },
  { key: 'other',   label: '其他' },
] as const;

export type DashTab = (typeof DASH_TABS)[number]['key'];

/** 預設停在哪一頁。★ 九成的時候要看的是營收。 */
export const DEFAULT_TAB: DashTab = 'revenue';

/**
 * 網址上的 `?tab=` → 分頁。
 *
 * ★★★ **不認得的值一律回預設**，不要讓畫面空著 ——
 *   舊的書籤、打錯的網址、之後改掉的代號都會走到這裡，
 *   而一個什麼都不顯示的儀表板看起來像壞掉。
 */
export function parseTab(v: string | null | undefined): DashTab {
  const s = String(v ?? '');
  return (DASH_TABS as readonly { key: string }[]).some((t) => t.key === s)
    ? (s as DashTab) : DEFAULT_TAB;
}

/** 分頁的中文名。找不到就回空字串（畫面那邊自己決定要不要印）。 */
export function tabLabel(t: string | null | undefined): string {
  return DASH_TABS.find((x) => x.key === t)?.label ?? '';
}

/* ══════════════════════════════════════════════════════════
 * 營收來源膠囊
 * ══════════════════════════════════════════════════════════ */

/**
 * 膠囊在這一頁能不能用。
 *
 * ══════════════════════════════════════════════════════════
 * 【★★★ 為什麼只有「營收分析」能用】
 *
 * 膠囊篩的是**營收**。但除了營收分析之外，那幾頁上都有**支出**：
 *
 *   財報比較　營收／支出／**淨額**
 *   支出分析　各物業支出、會計科目、關注支出
 *
 * 支出**沒有「來源」這個欄位** —— 篩不動。
 * 於是「淨額 ＝ 營收 − 支出」會變成「長租的營收 − 全部的支出」，
 * 算出一個**看起來很正常但完全沒有意義的負數**，
 * 而畫面上沒有任何地方會說它是錯的。
 *
 * ★ 所以那幾頁膠囊**整排停用並且寫出原因**，不是默默沒反應 ——
 *   一個點了沒動靜的東西，使用者的結論是系統壞了（anxing-ui 二-6）。
 */
export function pillsApply(tab: string | null | undefined): boolean {
  return parseTab(tab) === 'revenue';
}

/** 膠囊停用的理由。`null` ＝ 可以用。 */
export function whyPillsOff(tab: string | null | undefined): string | null {
  if (pillsApply(tab)) return null;
  const t = parseTab(tab);
  if (t === 'compare') {
    return '這一頁有支出與淨額 —— 支出沒有「來源」，只篩營收的話淨額會算錯';
  }
  if (t === 'expense') return '支出沒有「來源」，這一頁用不到';
  return '這一頁不是看營收的';
}

/** 一列營收（只取這一支用得到的欄位）。 */
export type RevLike = { source?: string | null; month_amount?: number | string | null };

/** 一顆膠囊。 */
export type Pill = { key: string; amount: number; count: number };

/**
 * 每一種來源的金額與筆數，金額大到小。
 *
 * ★★ 空的來源當成 `'other'` —— 丟掉的話膠囊的合計會跟總額對不上，
 *   而**對不上的總額是最難查的一種**（沒有人會想到是某一列的欄位空的）。
 */
export function sourcePills(revs: readonly RevLike[]): Pill[] {
  const m = new Map<string, Pill>();
  for (const r of revs ?? []) {
    const k = String(r.source ?? '').trim() || 'other';
    const cur = m.get(k) ?? { key: k, amount: 0, count: 0 };
    cur.amount += Number(r.month_amount || 0);
    cur.count += 1;
    m.set(k, cur);
  }
  return [...m.values()]
    .map((p) => ({ ...p, amount: Math.round(p.amount) }))
    .sort((a, b) => b.amount - a.amount || a.key.localeCompare(b.key));
}

/**
 * 套上膠囊之後剩下哪幾列。
 *
 * ★ 沒選（`null` / 空字串）＝全部都留。
 * ★★ 選了一個不存在的來源會得到空陣列 —— 那是對的，
 *   畫面那邊要寫「這個來源在這段期間沒有營收」，不是顯示 0 就算了。
 */
export function applyPill<T extends RevLike>(
  revs: readonly T[], sel: string | null | undefined,
): T[] {
  const s = String(sel ?? '').trim();
  if (!s) return [...(revs ?? [])];
  return (revs ?? []).filter((r) => (String(r.source ?? '').trim() || 'other') === s);
}

/**
 * 點膠囊之後的新選擇。
 *
 * ★★★ **再點一下＝清除**（anxing-ui 四-1）——
 *   一顆都沒亮就是沒有篩選，不用另外做一顆「全部」。
 */
export function togglePill(cur: string | null, clicked: string): string | null {
  return cur === clicked ? null : clicked;
}

/* ══════════════════════════════════════════════════════════
 * 營收表現（那一排大數字）
 * ══════════════════════════════════════════════════════════ */

export type Perf = {
  /** 這一批的營收合計 */
  revenue: number;
  /** 筆數 */
  count: number;
  /** 平均單價。★ 筆數是 0 時回 0，不是 NaN */
  avg: number;
  /** 選了膠囊時:佔全部的幾成。沒選就是 null */
  shareRev: number | null;
  shareCnt: number | null;
};

/**
 * 那一排大數字。
 *
 * ★★★ 筆數 0 的時候平均單價回 **0 不是 NaN**。
 *   `NaN` 在畫面上會印成「NT$NaN」——
 *   使用者看到的是壞掉，而不是「這段期間沒有東西」。
 */
export function perf(
  shown: readonly RevLike[], all: readonly RevLike[], filtered: boolean,
): Perf {
  const sum = (xs: readonly RevLike[]) =>
    Math.round(xs.reduce((s, r) => s + Number(r.month_amount || 0), 0));
  const rev = sum(shown), cnt = (shown ?? []).length;
  const allRev = sum(all), allCnt = (all ?? []).length;
  return {
    revenue: rev,
    count: cnt,
    avg: cnt > 0 ? Math.round(rev / cnt) : 0,
    shareRev: filtered && allRev > 0 ? rev / allRev : null,
    shareCnt: filtered && allCnt > 0 ? cnt / allCnt : null,
  };
}

/* ══════════════════════════════════════════════════════════
 * 營收與住房率　合成一張圖
 *
 * 【使用者 2026-09-18】
 *   「可以看各物業 營收趨勢 然後 住房率 畫一起
 *     營收畫長條圖 住房率畫折線圖　可以合在一起」
 *   「沒有營收與住房率呀　然後這不是 MECE 可以合併的」
 *
 * ★★★ 為什麼要合：原本「營收表現」「住房率」「各物業營收」三塊，
 *   同一個住房率印在兩個地方、同一組物業營收畫兩次。
 *   合成一張之後，營收分析那一頁是：
 *   營收表現 → **營收與住房率** → 營收來源 → 訂單分布。
 * ══════════════════════════════════════════════════════════ */

/** 圖的兩種模式。 */
export const COMBO_MODES = [
  { key: 'time',   label: '按月看趨勢' },
  { key: 'estate', label: '各物業比較' },
] as const;
export type ComboMode = (typeof COMBO_MODES)[number]['key'];
export function parseComboMode(v: string | null | undefined): ComboMode {
  return v === 'estate' ? 'estate' : 'time';
}

/**
 * 實際要畫哪一種。`picked` 是使用者按過的那一顆（沒按過是 `null`）。
 *
 * ★★★ 沒按過而且**區間只有一個月**時自己切到「各物業比較」——
 *   一根長條的趨勢圖回答不了任何問題（而預設區間就是本月）。
 *   使用者一按過就以他按的為準，不再自作聰明:
 *   看著看著圖自己跳掉，比一開始就是錯的還糟。
 */
export function effectiveComboMode(
  picked: ComboMode | null | undefined, monthCount: number,
): ComboMode {
  if (picked) return picked;
  return (monthCount || 0) >= 2 ? 'time' : 'estate';
}

/**
 * `2026-07-15` ~ `2026-09-18` → `['2026-07','2026-08','2026-09']`。
 *
 * ★★★ x 軸的月份**從區間長出來，不是從資料長出來**。
 *   照資料長的話，「整個月都沒有營收」的月份會從軸上消失 ——
 *   而那個月的住房率可能是 80%（長租客沒有當月認列），
 *   於是折線會把兩個不相鄰的月份接起來，看起來一路平穩。
 *
 * ★ 起迄顛倒或空的回空陣列，不要回一個無限長的清單。
 */
export function monthsBetween(from: string, to: string): string[] {
  const a = String(from ?? '').slice(0, 7), b = String(to ?? '').slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(a) || !/^\d{4}-\d{2}$/.test(b) || a > b) return [];
  const out: string[] = [];
  let y = Number(a.slice(0, 4)), m = Number(a.slice(5, 7));
  for (let i = 0; i < 600; i++) {                     // 上限 50 年 —— 不寫的話一個壞日期會轉到當掉
    const cur = `${y}-${String(m).padStart(2, '0')}`;
    out.push(cur);
    if (cur >= b) break;
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}

/**
 * 圖上的一格：長條（營收）＋ 折線（住房率）。
 *
 * ★★★ `occ` 是 `null` 代表**這一格沒有住房率**，折線要**斷開**。
 *   用 0 代替的話，畫出來是一條掉到底的線 ——
 *   而「沒有資料」跟「一天都沒住」在經營上是完全相反的兩件事
 *   （後者要立刻處理，前者只是那一格不在範圍裡）。
 */
export type ComboOcc = { rate: number; days: number; used: number; rooms: number };
export type ComboRow = {
  key: string; label: string; rev: number; occ: ComboOcc | null;
  /** 這一格的長條**不是完整的一個月**（區間切在月中）。只有按月模式會是 true */
  partial?: boolean;
};

/**
 * 組一格。
 *
 * ★★ `days <= 0` 一律當成沒有住房率 —— 分母是 0 的時候
 *   `rate` 會是 0（`occupancyOf` 刻意不回 NaN），
 *   那個 0 到了這裡就分不出是「沒房間」還是「全空」。**在這裡分掉。**
 */
export function comboRow(
  key: string, label: string, rev: number, occ: ComboOcc | null | undefined,
  partial = false,
): ComboRow {
  return {
    key, label,
    rev: Math.round(Number(rev) || 0),
    occ: occ && occ.days > 0 ? occ : null,
    partial: !!partial,
  };
}

/**
 * 折線要畫成幾段 —— 中間有 `null` 就斷開，回的是每一段的 index。
 *
 * ★★★ 這支存在的唯一理由：**一條穿過空格的線是在說謊**。
 *   `polyline` 把有值的點直接連起來的話，中間那幾個月會被
 *   讀成「平滑地從 60% 降到 55%」，而那幾個月根本沒有資料。
 *
 * ★ 只有一個點的段也回（畫面那邊畫成一個點，不要整段丟掉）——
 *   丟掉的話，區間只涵蓋一個月時折線整條消失。
 */
export function occSegments(rows: readonly ComboRow[]): number[][] {
  const out: number[][] = [];
  let cur: number[] = [];
  (rows ?? []).forEach((r, i) => {
    if (r.occ) { cur.push(i); return; }
    if (cur.length) { out.push(cur); cur = []; }
  });
  if (cur.length) out.push(cur);
  return out;
}

/**
 * 錢那一軸的頂端 —— 取到**四等分之後每一格都好讀**的刻度。
 *
 * ★★ 為什麼要管四等分：軸上畫四條格線，頂端隨便取整的話
 *   中間會出現「213 萬」「425 萬」這種刻度 ——
 *   看的人得先算一下才知道長條到哪裡，等於那四條線白畫了。
 *   所以是先決定**一格多少**（1／2／2.5／5 開頭），再乘回去。
 *
 * ★ 0 或負的回 1：拿 0 當分母會得到 `Infinity`，
 *   而畫面上的症狀是整張圖不見了，不是一條 0 的線。
 */
export const MONEY_TICKS = 4;
export function moneyTop(max: number): number {
  const m = Number(max);
  if (!Number.isFinite(m) || m <= 0) return 1;
  const raw = m / MONEY_TICKS;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const nice = [1, 2, 2.5, 5, 10].find((k) => k * mag >= raw) ?? 10;
  return nice * mag * MONEY_TICKS;
}


/* ══════════════════════════════════════════════════════════
 * x 軸的文字放不放得下
 *
 * ★★★ 這一段是 2026-09-18 在無頭瀏覽器裡**看到壞掉才寫的**:
 *   手機上物業模式的「台視 未指定物業 復興」三個標籤疊在一起，
 *   而 tsc 與測試都不會有任何反應 —— 版面的事只有畫出來才看得到。
 * ══════════════════════════════════════════════════════════ */

/**
 * 一串字大概幾 px 寬（`font-size: 11`）。
 *
 * ★ 中文一個字約 11px、數字與英文約 6.2px —— 這兩個數字是在
 *   無頭 Chromium 裡用 `getBBox()` 量出來的，不是猜的：
 *   「未指定物業」55px（5 字）、「10月」25px（2 數字 ＋ 1 中文）。
 * ★ 估算就好。差幾 px 的代價是標籤稍微鬆或稍微緊，
 *   而真正要擋的是「差一倍」那種疊在一起的狀況。
 */
export function textWidth(s: string, font = 11): number {
  let w = 0;
  for (const ch of String(s ?? '')) {
    /* ★ 省略號「…」的碼位（U+2026）在 0x2E80 以下，但它畫出來是**全形**寬。
       漏掉這一條的話，截短之後算出來比實際窄 5px，於是還是會擠在一起。 */
    const wide = ch === '…' || ch.codePointAt(0)! > 0x2e80;
    w += (wide ? 1 : 0.564) * font;
  }
  return w;
}

/**
 * 把標籤截到放得下。放不下（連兩個字都塞不進去）回**空字串**。
 *
 * ★★ 回空字串而不是硬塞一個字 —— 「未」跟「復」分不出是哪一棟，
 *   那比不印還糟（看的人會以為自己看懂了）。
 *   呼叫端收到空字串就改走「隔幾個印一個」。
 */
export function fitLabel(s: string, px: number): string {
  const full = String(s ?? '');
  if (!full) return '';
  if (textWidth(full) <= px) return full;
  for (let n = full.length - 1; n >= 2; n--) {
    const cut = `${full.slice(0, n)}…`;
    if (textWidth(cut) <= px) return cut;
  }
  return '';
}

/**
 * x 軸怎麼印：每一格都印（可能截短），或隔幾格印一個完整的。
 *
 * ★★★ 兩種都要有:
 *   物業模式截短還認得出來（「未指定…」），跳過就不知道是哪一棟；
 *   月份模式截短完全認不出（「1…」），跳過反而剛好（趨勢看得出來）。
 */
export function axisLabels(
  rows: readonly { label: string }[], step: number,
): { labels: string[]; stride: number } {
  const avail = step - 6;                      // 左右各留 3px，不然兩格的字會貼在一起
  const fitted = rows.map((r) => fitLabel(r.label, avail));
  if (fitted.every((f) => f !== '')) return { labels: fitted, stride: 1 };
  const widest = Math.max(...rows.map((r) => textWidth(r.label)), 1);
  return {
    labels: rows.map((r) => r.label),
    stride: Math.max(1, Math.ceil((widest + 8) / Math.max(step, 1))),
  };
}
