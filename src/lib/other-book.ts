/**
 * 其他收支帳的算式。
 *
 * ============================================================
 * 【為什麼跟安幸的算法不一樣】
 *
 * 安幸的營收表讀 `revenue_recognitions`（一筆長租拆成每個月認列多少）。
 * **愛皮洪鯊沒有跨月這回事** —— 使用者確認「都是一次性直接收入」，
 * 所以直接加總 `orders` / `expenses`。
 *
 * ★ 兩邊的數字**不能互相對照**。安幸看的是「這個月認列多少」，
 *   愛皮看的是「這個月實際收多少」。畫面上要標清楚，
 *   不然有人會拿兩個數字相加然後問為什麼跟銀行對不起來。
 *
 * 【為什麼寫在 .ts 不是 .tsx】
 * 測試環境不處理 JSX。這裡每一條算式都是報表上的數字。
 */

const round = (n: unknown) => Math.round(Number(n) || 0);

/** 流水帳的一列。收入與支出攤平成同一個形狀。 */
export type Entry = {
  id: string;
  kind: 'income' | 'expense';
  /** 收入是 checkin、支出是 spent_on */
  date: string | null;
  name: string;
  account_code: string | null;
  /** 收入的客戶／支出的廠商 */
  party: string | null;
  amount: number;
  note: string | null;
  /** 收入:已收款沒；支出:一律已付（支出是錢出去之後才產生的） */
  settled: boolean;
  /**
   * 這一筆是**請款單產生的**（2026-09-10）。
   *
   * ★★★ 金額不給改。請款單那邊還留著原始金額，
   *   在這裡改一個數字的話，同一筆錢在兩張表上是兩個值 ——
   *   而**兩邊各自看起來都正常**，只有相減的時候差一截。
   *
   * ★ 日期、項目、科目、備註照樣改得動 —— 那幾欄不影響對帳。
   */
  fromRequest?: boolean;
  /**
   * 這一筆是**安幸代墊**的（migration_236 / 237）。有值就是那列暫付的 id。
   *
   * ══════════════════════════════════════════════════════════
   * 【為什麼要帶到這一頁來】（2026-09-17 使用者連問三次）
   *
   * 愛皮這個月 8 筆支出全部都是安幸先墊的，而這一頁**一個字都沒說**。
   * 要知道就得跑去「暫收付管理 → 暫付」把 4,530／1,329／7,350
   * 三個數字加起來對 —— 使用者就是這樣連問了三次
   * 「怎麼還是三筆」「全都代墊」。
   *
   * ★ 資料一直都是對的。缺的是畫面上那一句話。
   * ══════════════════════════════════════════════════════════
   */
  advanceId?: string | null;
};

/** 這一筆是不是安幸代墊的。 */
export const isLent = (e: Entry | null | undefined) => !!e?.advanceId;

/**
 * 這個月有多少錢是安幸先墊的。
 *
 * ★★ 算的是**支出**那一側。收入沒有代墊這回事 ——
 *   代墊的定義就是「安幸替別本帳付錢」，錢進來不會經過這條路。
 *   不濾 kind 的話，哪天收入那邊有人塞了 advanceId 進來，
 *   這個數字會變大而沒有人知道為什麼。
 */
export function lentTotal(entries: Entry[] | null | undefined): number {
  let n = 0;
  for (const e of entries ?? []) {
    if (e.kind === 'expense' && isLent(e)) n += round(e.amount);
  }
  return n;
}

/**
 * 同一列暫付底下的其他幾筆（點開「安幸代墊」那顆籤要看的）。
 *
 * ★ 從**已經載進來的資料**裡撈，不另外查一次資料庫 ——
 *   同一張請款單的支出日期都是那張單的出款日，
 *   所以它們一定在同一個月份、同一份清單裡。
 *
 * ★★ 回傳**含自己**。少掉自己的話，五筆的那一組點開只看到四筆，
 *   而合計對不起來的時候沒有人知道少了哪一筆。
 */
export function lentSiblings(entries: Entry[] | null | undefined, advanceId: string | null | undefined): Entry[] {
  if (!advanceId) return [];
  return (entries ?? []).filter((e) => e.advanceId === advanceId);
}

/** 收入為正、支出為負。淨額直接把這一欄加起來就好。 */
export const signed = (e: Entry) => (e.kind === 'income' ? round(e.amount) : -round(e.amount));

export type Totals = { income: number; expense: number; net: number };

export function totals(entries: Entry[]): Totals {
  let income = 0;
  let expense = 0;
  for (const e of entries ?? []) {
    if (e.kind === 'income') income += round(e.amount);
    else expense += round(e.amount);
  }
  return { income, expense, net: income - expense };
}

/**
 * 跟上個月比的增減百分比。
 *
 * ★ 上個月是 0 時回 null，**不要回 Infinity 或 100%**。
 *   「從 0 變成 5 萬」不是成長 100%，是「上個月沒有資料」——
 *   印一個百分比等於編一個看起來很有意義的數字。
 */
export function pctChange(now: number, prev: number): number | null {
  if (!prev) return null;
  return Math.round(((now - prev) / Math.abs(prev)) * 100);
}

/** 按月分組，回傳連續的 n 個月（沒有資料的月份補 0，不是跳過）。 */
export function byMonth(entries: Entry[], endYm: string, months = 12): { ym: string; income: number; expense: number }[] {
  const map: Record<string, { income: number; expense: number }> = {};
  for (const e of entries ?? []) {
    const ym = (e.date ?? '').slice(0, 7);
    if (!ym) continue;
    const m = (map[ym] ??= { income: 0, expense: 0 });
    if (e.kind === 'income') m.income += round(e.amount);
    else m.expense += round(e.amount);
  }
  /*
   * ★ 沒有資料的月份要補 0 而不是跳過。
   *   跳過的話長條圖上 3 月接著 7 月，看起來像連續的四個月 ——
   *   而中間那三個月的「沒有生意」正是最該看到的訊息。
   */
  const out: { ym: string; income: number; expense: number }[] = [];
  const [y0, m0] = endYm.split('-').map(Number);
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(y0, (m0 - 1) - i, 1));
    const ym = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    out.push({ ym, ...(map[ym] ?? { income: 0, expense: 0 }) });
  }
  return out;
}

/**
 * 按會計科目分組，金額由大到小。
 *
 * `top` 之後的併成「其他 N 項」—— 列十七個科目的話，
 * 前三名反而被淹沒，而那三個才是真正要看的。
 */
export function byCode(
  entries: Entry[], kind: 'income' | 'expense',
  nameOf: (code: string | null) => string, top = 5,
): { name: string; amount: number }[] {
  const map: Record<string, number> = {};
  for (const e of entries ?? []) {
    if (e.kind !== kind) continue;
    const k = e.account_code ?? '';
    map[k] = (map[k] ?? 0) + round(e.amount);
  }
  const rows = Object.entries(map)
    .map(([code, amount]) => ({ name: nameOf(code || null), amount }))
    .sort((a, b) => b.amount - a.amount);
  if (rows.length <= top) return rows;
  const rest = rows.slice(top).reduce((a, r) => a + r.amount, 0);
  return [...rows.slice(0, top), { name: `其他 ${rows.length - top} 項`, amount: rest }];
}

/** 還沒收到的錢。**只算收入** —— 支出是錢已經出去才產生的紀錄。 */
export function unsettled(entries: Entry[]): { n: number; amount: number } {
  const rows = (entries ?? []).filter((e) => e.kind === 'income' && !e.settled);
  return { n: rows.length, amount: rows.reduce((a, e) => a + round(e.amount), 0) };
}

/* ══════════════ 篩選 ══════════════ */

export type Filters = {
  kind?: '' | 'income' | 'expense';
  code?: string;
  kw?: string;
  from?: string;
  to?: string;
};

/**
 * 前端篩選。
 *
 * ★ 關鍵字比對**項目名、對象、備註**三欄。只比項目名的話，
 *   使用者記得的常常是廠商名字而不是當初怎麼寫的品項。
 */
export function applyFilters(entries: Entry[], f: Filters): Entry[] {
  const kw = (f.kw ?? '').trim().toLowerCase();
  return (entries ?? []).filter((e) => {
    if (f.kind && e.kind !== f.kind) return false;
    if (f.code && e.account_code !== f.code) return false;
    if (f.from && (e.date ?? '') < f.from) return false;
    if (f.to && (e.date ?? '') > f.to) return false;
    if (kw) {
      const hay = `${e.name} ${e.party ?? ''} ${e.note ?? ''}`.toLowerCase();
      if (!hay.includes(kw)) return false;
    }
    return true;
  });
}

/** 月份字串 → 那個月的頭尾（含）。 */
export function monthRange(ym: string): { from: string; to: string } {
  const [y, m] = ym.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${ym}-01`, to: `${ym}-${String(last).padStart(2, '0')}` };
}

/** 上一個月。跨年要退到 12 月，不是月份變成 0。 */
export function prevMonth(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
