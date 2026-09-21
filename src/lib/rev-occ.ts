/**
 * 營收與住房率那張圖要用的算式。
 *
 * ══════════════════════════════════════════════════════════
 * ★★★ 為什麼不再用雙軸（2026-09-21 使用者過審）
 *
 * 原本是「長條＝營收（左軸）＋ 折線＝住房率（右軸）」一張圖。兩個問題：
 *
 *   ① 兩條線量的不是同一群人 —— 長條跟著來源膠囊變、折線不跟。
 *      選了長租之後 Airbnb 的錢從長條上消失，但那些客人還在折線裡，
 *      於是「營收掉一半、住房率沒變」，而那不是真的。
 *   ② 右軸的範圍是**畫圖的人隨便訂的**。同一份資料，右軸 0~100% 看起來
 *      「沒什麼關係」，右軸 44~68% 看起來「幾乎完全同步」——
 *      能證明任何結論的圖等於什麼都沒證明。
 *
 * 改成**上下兩張、共用一條 x 軸與一條十字線**：各有各的軸，
 * 不會生出假的相關性，而同一個月的兩個數字還是看得到。
 * ══════════════════════════════════════════════════════════
 *
 * ★ 寫在 `.ts` 不是 `.tsx` —— 測試環境不處理 JSX。
 */

/** 一個月（或一個物業）在各來源上的錢 */
export type BySource = Readonly<Record<string, number>>;

/* ────────────────────────────────────────────────────────── */

/**
 * 元 → 萬（四捨五入的整數）。
 *
 * ★ 畫面上一律用萬。元的話十二個月十三欄排不下，而看的人要自己數零。
 */
export const toWan = (n: number): number => Math.round((Number(n) || 0) / 10000);

/**
 * 一組金額換算成萬，而且**加起來等於總額換算成萬**。
 *
 * ★★★ 各自四捨五入的話，六個分項加總會跟合計差 1~2 萬 ——
 *   而卡片上「分項」與「合計」對不起來，在使用者眼裡就是「這系統算錯了」。
 *   那種錯沒有任何地方會叫，只會讓人不再相信這張表。
 *
 * ★★ 差額補在**絕對值最大**的那一項上：相對誤差最小，而且
 *   補在小項上會出現「其他收入 4 萬 → 6 萬」這種一眼就看得出來的歪。
 *
 * ★ 負數（折讓）也要能跑 —— 用絕對值找最大項，不是用最大值。
 */
export function wanParts(values: readonly number[]): number[] {
  const vals = (values ?? []).map((v) => Number(v) || 0);
  if (!vals.length) return [];
  const parts = vals.map(toWan);
  const total = toWan(vals.reduce((a, b) => a + b, 0));
  const diff = total - parts.reduce((a, b) => a + b, 0);
  if (diff === 0) return parts;
  let bi = 0;
  for (let i = 1; i < vals.length; i++) if (Math.abs(vals[i]) > Math.abs(vals[bi])) bi = i;
  parts[bi] += diff;
  return parts;
}

/* ────────────────────────────────────────────────────────── */

/**
 * 選中的來源怎麼寫成一行字。
 *
 * ★★★ **全部選中 ＝ 沒有篩選**（跟一顆都沒亮是同一件事）。
 *   六個名字排出來只是把「沒有篩選」寫得很長，而且那一行會折成三行、
 *   把旁邊的東西推歪。
 *
 * ★★ 超過 `max` 個就封頂寫「前兩個 等 N 種」——
 *   圖例與卡片的寬度是固定的，不封頂的話版面會被一個字串撐開。
 *   有一整行可以寫的地方（表上方那一行）才傳大一點的 `max`。
 */
export function pickedLabel(
  names: readonly string[], allCount: number, max = 3,
): string {
  const ns = (names ?? []).filter((n) => String(n ?? '').trim() !== '');
  if (!ns.length || (allCount > 0 && ns.length >= allCount)) return '全部來源';
  if (ns.length <= max) return ns.join(' ＋ ');
  return `${ns.slice(0, 2).join(' ＋ ')} 等 ${ns.length} 種`;
}

/**
 * 這組選擇算不算「有在篩」。
 *
 * ★★ 一顆都沒亮、或全部都亮 —— 兩種都是**沒有篩選**。
 *   不把「全部都亮」也算進來的話，長條會畫成「深色 100% ＋ 淡色 0%」，
 *   多一段高度 0 的東西在那裡，而圖例還寫著「其餘來源」。
 */
export function noSrcFilter(
  picks: readonly string[], allKeys: readonly string[],
): boolean {
  const n = new Set((picks ?? []).filter(Boolean)).size;
  return n === 0 || n >= (allKeys ?? []).length;
}

/** 點一下加進去、再點一下拿掉。★ 順序照 `allKeys`，不是照點擊順序 */
export function toggleSrc(
  picks: readonly string[], key: string, allKeys: readonly string[],
): string[] {
  const set = new Set(picks ?? []);
  if (set.has(key)) set.delete(key); else set.add(key);
  return (allKeys ?? []).filter((k) => set.has(k));
}

/* ────────────────────────────────────────────────────────── */

/** 長條要畫的兩段：選中的（深色，貼基線）與其餘（淡色） */
export type Split = { sel: number; rest: number; total: number };

/**
 * 把一個月的錢拆成「選中的」與「其餘」。
 *
 * ★★★ **長條的總高度永遠是全部來源**，選中的那一段只是變深。
 *   舊做法是「沒選的整段消失」—— 那才是讓住房率看起來壞掉的原因
 *   （營收掉一半、住房率沒變）。總高度不變的話，
 *   「這個月一共收多少」跟「其中這幾個佔多少」同時看得到。
 *
 * ★★ `rest` 夾在 0 以上 —— 浮點誤差會讓它變成 -0.0000001，
 *   而那會畫出一段高度是負的長方形（SVG 直接不畫，看起來像少了一段）。
 */
export function splitBySrc(
  by: BySource, allKeys: readonly string[], picks: readonly string[],
): Split {
  const keys = allKeys ?? [];
  const total = keys.reduce((n, k) => n + (Number(by?.[k]) || 0), 0);
  if (noSrcFilter(picks, keys)) return { sel: total, rest: 0, total };
  const set = new Set(picks);
  const sel = keys.reduce((n, k) => n + (set.has(k) ? (Number(by?.[k]) || 0) : 0), 0);
  return { sel, rest: Math.max(total - sel, 0), total };
}

/** 卡片上的一列 */
export type CardRow = {
  key: string; label: string;
  /** 元 */ amount: number;
  /** 萬（整組加起來等於合計） */ wan: number;
  /** 佔合計幾成（0~1）。合計是 0 的時候回 0，不是 NaN */ share: number;
  /** 有沒有被選中 —— 畫面用它決定深色還是淡掉 */ on: boolean;
};

/**
 * 卡片要列的六列 ＋ 小計 ＋ 合計。
 *
 * ★★★ **沒選中的也要列出來**。使用者要看的是「組成」，
 *   那就得看得到沒選的那幾個佔多少 —— 只列選中的等於把問題砍掉一半。
 *
 * ★★ `wan` 走 `wanParts()`，所以六列加起來一定等於 `totalWan`。
 */
export function cardRows(
  by: BySource, allKeys: readonly string[], picks: readonly string[],
  label: (k: string) => string,
): { rows: CardRow[]; selWan: number; totalWan: number; selShare: number } {
  const keys = allKeys ?? [];
  const amts = keys.map((k) => Number(by?.[k]) || 0);
  const wans = wanParts(amts);
  const total = amts.reduce((a, b) => a + b, 0);
  const set = new Set(picks ?? []);
  const none = noSrcFilter(picks, keys);
  const rows: CardRow[] = keys.map((k, i) => ({
    key: k, label: label(k), amount: amts[i], wan: wans[i],
    share: total ? amts[i] / total : 0,
    on: none || set.has(k),
  }));
  /* ★ 小計用**同一組已經修正過的萬**加起來 —— 另外算一次的話
       它會跟六列的加總差一萬，而那正是使用者會發現的那一萬。 */
  const selWan = rows.reduce((n, r) => n + (none || set.has(r.key) ? r.wan : 0), 0);
  const totalWan = wans.reduce((a, b) => a + b, 0);
  const selAmt = keys.reduce((n, k) => n + (none || set.has(k) ? (Number(by?.[k]) || 0) : 0), 0);
  return { rows, selWan, totalWan, selShare: total ? selAmt / total : 0 };
}

/**
 * 照選中的來源篩認列列。
 *
 * ★★ 一顆都沒亮、或全部都亮 —— 兩種都**不篩**（見 `noSrcFilter`）。
 *   少了「全部都亮」那一半的話，使用者把六顆都點亮之後
 *   會看到跟「一顆都沒點」不一樣的東西，而那兩件事是同一件事。
 * ★ 沒有 source 的列當成 `other`（跟 `sourcePills` 同一套），
 *   兩邊不一致的話膠囊上的金額跟圖上的加總會對不起來。
 */
export function applySrcPicks<T extends { source?: string | null }>(
  revs: readonly T[], picks: readonly string[], allKeys: readonly string[],
): T[] {
  if (noSrcFilter(picks, allKeys)) return [...(revs ?? [])];
  const set = new Set(picks);
  return (revs ?? []).filter((r) => set.has(String(r.source ?? '').trim() || 'other'));
}

/** 一格（一個月）在各來源上的錢。key 是 `source`，沒有的當 `other` */
export function bySourceOf<T extends { source?: string | null }>(
  revs: readonly T[], amount: (r: T) => number,
): Record<string, number> {
  const m: Record<string, number> = {};
  for (const r of revs ?? []) {
    const k = String(r.source ?? '').trim() || 'other';
    m[k] = (m[k] ?? 0) + (Number(amount(r)) || 0);
  }
  return m;
}

/**
 * 把月份統一成 `YYYY-MM`。
 *
 * ★★★ 這個專案裡月份有**兩種形狀**:
 *     `revenue_recognitions.ym`   是 `YYYYMM`（`ymOf()` 產生的）
 *     `monthsBetween()` / 住房率  是 `YYYY-MM`
 *   拿其中一種去查另一種做的 map，**每一格都查不到** ——
 *   而 `?? 0` 會把它變成一根高度 0 的長條，**沒有任何地方會叫**。
 *   症狀就是「營收趨勢圖十二個月全部是 0」，而住房率那條線好好的。
 *
 * ★★ 同一個坑的第二種形狀:`ymMonth()` 吃的是 `YYYYMM`，
 *   餵 `YYYY-MM` 進去會回 `slice(4,6)` ＝ `'-1'`、`'-0'` ——
 *   x 軸上就是那幾個看不懂的東西。tsc 不會叫（兩邊都是 string）。
 *
 * ★ 所以這支**兩種都吃**。不要在呼叫端各自 replace('-','')。
 */
export function ymDash(ym: string | null | undefined): string {
  const v = String(ym ?? '').trim();
  if (v.includes('-')) return v.slice(0, 7);
  return v.length >= 6 ? `${v.slice(0, 4)}-${v.slice(4, 6)}` : v;
}

/** `YYYY-MM` 或 `YYYYMM` → `10月`。x 軸與表頭用 */
export function monthLabel(ym: string | null | undefined): string {
  const d = ymDash(ym);
  return d.length === 7 ? `${d.slice(5)}月` : d;
}
