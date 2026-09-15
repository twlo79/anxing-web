/**
 * 押金的幣別明細。
 *
 * 【為什麼是一筆多幣別，不是一幣別一筆】
 * 多幣別的現金實務上放在同一個保險箱一起保管，之後一起退。
 * 一次收、一次退、一組帳戶 —— 拆成多列的話使用者要填好幾次一樣的東西，
 * 而且各列的收款日還可能不小心填得不一樣，事後看不出哪個才對。
 *
 * 所以 deposits 一筆一列，幣別明細存在 lines（migration_87）：
 *
 *     amount  台幣那部分（統計、報表、Excel 都讀它，語意沒變）
 *     lines   [{cur:'TWD',amt:160000},{cur:'JPY',amt:10000}]
 *
 * 外幣**只**在 lines 裡。所以任何要「看到全部幣別」的地方都得走這裡，
 * 只讀 amount 會漏掉外幣而且不會有任何跡象。
 */

/**
 * 一筆明細。
 *
 * `item` 是押金項目（migration_194）。**194 之前的資料沒有這個欄位** ——
 * 那時候還沒有寵物押金這回事，所以缺的一律是一般押金。
 * 顯示一律走 `itemOf()`，不要在各處自己寫 `?? '一般押金'`。
 *
 * ★★★ 同一種幣別**可以有兩筆**（一般押金 TWD ＋ 寵物押金 TWD）——
 *   這是 194 之後才成立的，而它打破了一個舊假設:
 *   原本 `cur` 是唯一的，所以畫面上拿它當 React 的 key。現在不行了。
 */
export type DepLine = { cur: string; amt: number; item?: string | null };

const num = (n: unknown) => Number(n) || 0;

/** 押金項目。空的一律當一般押金 —— 但**不寫回資料庫**（migration_194）。 */
export const itemOf = (l: DepLine): string => l.item || '一般押金';

/** 是不是寵物押金那一筆。 */
export const isPetLine = (l: DepLine) => itemOf(l) === '寵物押金';

/**
 * 讀出明細。
 *
 * 舊資料（migration_87 之前）沒有 lines，退回用 currency + amount 組一筆 ——
 * 不退回的話那些押金在畫面上會變成「沒有金額」。
 */
export function depLines(d: { lines?: DepLine[] | null; currency?: string | null; amount?: number | null }): DepLine[] {
  const ls = (d.lines ?? []).filter((l) => l && l.cur && num(l.amt) !== 0);
  /*
   * ★★ `item` **有值才帶**，不要一律補成 null。
   *
   *   一律補的話，194 之前的資料經過這裡會從 `{cur, amt}` 變成
   *   `{cur, amt, item: null}` —— 多一個鍵，而這個函式的輸出
   *   會被存回 lines、被比對、被序列化進 Excel。
   *
   * ★ 空值的表達方式只留一種:**沒有這個鍵**。
   *   「null」與「不存在」在畫面上一樣、在 `?` 運算子下不一樣，
   *   兩種都允許的話自檢與 migration 的條件都要寫兩遍。
   */
  if (ls.length) {
    return ls.map((l) => (l.item
      ? { cur: l.cur.toUpperCase(), amt: num(l.amt), item: l.item }
      : { cur: l.cur.toUpperCase(), amt: num(l.amt) }));
  }
  if (num(d.amount)) return [{ cur: (d.currency || 'TWD').toUpperCase(), amt: num(d.amount) }];
  return [];
}

export const isTwdLine = (l: DepLine) => l.cur === 'TWD';

/**
 * 這一筆**實際收到**多少（依幣別）。
 *
 * ============================================================
 * 【★★★ 為什麼要有這一支】（2026-09-15）
 *
 * 統計卡的「已收」原本加的是 `depLines()` ＝ **應收**。
 * 19B3 碩美的押金應收 350,000、訂金轉入只收了 175,000，
 * 卻整筆 350,000 被算進「已收 NT$17,613,395」——
 * 而那張卡的標題寫著「**錢在我們手上**」。
 *
 * ★ 使用者 2026-09-15：「已收，部分收就算部分；部分押金的一樣歸類在已收。」
 *   所以**歸類不動**（還是算在已收那一格、筆數照算），
 *   只有**金額**改成實收。
 *
 * ============================================================
 * 【外幣為什麼照舊算應收】
 *
 * `received_amount` 是**一個數字**，沒有幣別 —— 抽屜上顯示的
 * 「已收 $175,000」就是台幣。外幣沒有「收了一部分」的資料可用。
 *
 * ★ 所以外幣那幾行:有收款日就當作收到，沒有就當作沒收。
 *   硬要按比例拆的話是**發明數字**，而發明出來的數字會進報表。
 */
export function depPaidLines(
  d: Parameters<typeof depLines>[0] & {
    received_amount?: number | null; received_on?: string | null;
  },
): DepLine[] {
  const got = d.received_amount == null ? null : Math.max(0, num(d.received_amount));
  return depLines(d).map((l) => {
    if (!isTwdLine(l)) {
      // 外幣:有收款日就算收到，沒有就算沒收
      return { ...l, amt: d.received_on ? l.amt : 0 };
    }
    /*
     * ★ `received_amount` 是 null 的舊資料退回「有收款日就是收滿」——
     *   2026-09-15 查過，現在一筆都沒有，但匯入或補資料可能再造出來，
     *   而那時候當成 0 會讓「已收」整批歸零。
     */
    if (got == null) return { ...l, amt: d.received_on ? l.amt : 0 };
    // ★ 不超過應收。超收是另一件事，不該讓「已收」那格膨脹
    return { ...l, amt: Math.min(l.amt, got) };
  }).filter((l) => l.amt !== 0);
}

/** 這一筆還**尚欠**多少（依幣別）。`應收 − 實收`，不回負數。 */
export function depOwedLines(
  d: Parameters<typeof depPaidLines>[0],
): DepLine[] {
  const paid: Record<string, number> = {};
  depPaidLines(d).forEach((l) => { paid[l.cur] = (paid[l.cur] ?? 0) + l.amt; });
  return depLines(d)
    .map((l) => ({ ...l, amt: Math.max(0, l.amt - (paid[l.cur] ?? 0)) }))
    .filter((l) => l.amt !== 0);
}

/** 台幣那部分。等於 deposits.amount —— 兩者對不起來就是資料壞了。 */
export function twdOf(d: Parameters<typeof depLines>[0]): number {
  return depLines(d).filter(isTwdLine).reduce((a, l) => a + l.amt, 0);
}

/** 非台幣的幾列。列表上顯示在台幣底下的小字。 */
export function fxOf(d: Parameters<typeof depLines>[0]): DepLine[] {
  return depLines(d).filter((l) => !isTwdLine(l));
}

const money = (n: number) => Math.round(n).toLocaleString('en-US');

/**
 * 一列的顯示文字：「NT$ 160,000」／「JPY 10,000」／「寵物押金 NT$ 30,000」。
 *
 * ★★ 只有**不是一般押金**的才加項目前綴。全部都加的話，
 *   站上 105 筆既有押金會通通從「NT$ 160,000」變成
 *   「一般押金 NT$ 160,000」—— 那是替 99% 的情況加一個不提供資訊的字。
 *   標記的價值來自它只在例外時出現。
 */
export function lineText(l: DepLine): string {
  const amt = isTwdLine(l) ? `NT$ ${money(l.amt)}` : `${l.cur} ${money(l.amt)}`;
  return isPetLine(l) ? `寵物押金 ${amt}` : amt;
}

/**
 * 列表上的主要金額。
 *
 * 有台幣就顯示台幣；**完全沒有台幣的押金要顯示第一個外幣**，
 * 不然畫面會是「NT$ 0」，看起來像沒收押金。
 */
export function primaryText(d: Parameters<typeof depLines>[0]): string {
  const ls = depLines(d);
  if (!ls.length) return '—';
  return lineText(ls[primaryIndex(ls)]);
}

/**
 * 主要那一列的位置。
 *
 * ★★★ 找的是「台幣**而且不是寵物押金**」。原本只找 `isTwdLine` ——
 *   而 194 之後同一張訂單可以有兩筆 TWD，只押寵物不押一般的訂單
 *   會讓主要金額變成「寵物押金 NT$ 30,000」而 extraLines 是空的。
 *   那其實是對的，所以順序是:一般押金 → 任何台幣 → 第一列。
 */
function primaryIndex(ls: DepLine[]): number {
  const i = ls.findIndex((l) => isTwdLine(l) && !isPetLine(l));
  if (i >= 0) return i;
  const j = ls.findIndex(isTwdLine);
  return j >= 0 ? j : 0;
}

/**
 * 主要金額以外的那幾列，列表上當小字。
 *
 * ★★★ 用**位置**排除主要那一列，不是用 `!isTwdLine` 過濾。
 *   原本的寫法是「台幣以外的都算 extra」—— 194 之後
 *   寵物押金也是台幣，會被那個過濾器整筆吃掉，
 *   於是畫面上只剩 100,000，30,000 憑空消失而且不會報錯。
 */
export function extraLines(d: Parameters<typeof depLines>[0]): DepLine[] {
  const ls = depLines(d);
  if (!ls.length) return [];
  const p = primaryIndex(ls);
  return ls.filter((_, i) => i !== p);
}

/**
 * React 的 key。
 *
 * ★★ 不能用 `l.cur` —— 194 之後同一張押金可以有兩筆 TWD，
 *   重複的 key 會讓 React 在更新時把兩列搞混（而且只在 console 警告）。
 */
export const lineKey = (l: DepLine, i: number) => `${i}-${l.cur}-${itemOf(l)}`;

/** 一行的完整摘要，給 Excel 與分享訊息用：「NT$ 160,000＋JPY 10,000」。 */
export function summaryText(d: Parameters<typeof depLines>[0]): string {
  const ls = depLines(d);
  return ls.length ? ls.map(lineText).join('＋') : '—';
}

/**
 * 真的有兩種以上**幣別**嗎。
 *
 * ★★★ 194 之後不能再用 `depLines().length > 1` 判斷 ——
 *   一般押金 ＋ 寵物押金是兩列，但都是台幣。
 *   那樣會讓純台幣的訂單被說成「多幣別」。
 */
export const isMultiCurrency = (d: Parameters<typeof depLines>[0]) =>
  new Set(depLines(d).map((l) => l.cur)).size > 1;

/**
 * 畫面上要不要展開明細。
 *
 * ★ 跟 `isMultiCurrency` 分開:展開的理由是「不只一筆」，
 *   而多幣別只是其中一種理由 —— 寵物押金是另一種。
 *   合用一個判斷式的話，加了寵物押金的純台幣訂單會不展開，
 *   使用者看到的總額對不上他填的東西。
 */
export const hasDetail = (d: Parameters<typeof depLines>[0]) => depLines(d).length > 1;

/**
 * 各幣別合計。押金頁的統計卡用。
 *
 * **不能只加 amount** —— 那樣外幣完全不會出現在統計裡，
 * 而且因為數字看起來很正常，沒有人會發現少了。
 */
export function sumByCurrency(rows: Parameters<typeof depLines>[0][]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) for (const l of depLines(r)) out[l.cur] = (out[l.cur] ?? 0) + l.amt;
  return out;
}
