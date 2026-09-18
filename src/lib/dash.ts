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
