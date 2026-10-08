/**
 * 請款單「部分付款」的規則（migration_323，2026-10-07 David 過審 A 版）。
 *
 *   一張請款單可以分好幾次付。每付一次：
 *     · 記一筆付款（日期、金額、安幸付款帳號）
 *     · 按順序把錢分到項目上，分到多少就產生多少支出
 *     · 項目還沒付滿的，那幾筆支出掛「部分付款」標籤
 *   付滿整張的那一次，單子才填付款日（＝已付清）。
 *
 * ★★★ 分錢的順序（David：「由最低金額的開始選」「繼續付會從部分繳的繼續扣」）：
 *     ① 付過一部分、還沒付滿的那一項先扣
 *     ② 再從金額最小的開始
 *     ③ 一樣大的照項目 id 排（資料庫那邊同一個排法，兩邊算出來才一樣）
 *
 * ★ 資料庫的 pay_request_part() 是真正分錢的地方，這裡只負責「送出前的預覽」
 *   與畫面上的狀態。兩邊的排序規則一定要一樣 —— 改一邊要改另一邊。
 */

export type PayItem = { id: string; amount: number };
export type PayRow = { id: string; paid_on: string; amount: number; payment_method?: string | null; pay_account?: string | null };
export type Alloc = { id: string; give: number; before: number; after: number; amount: number; done: boolean };

const n = (x: unknown) => Math.round((Number(x) || 0) * 100) / 100;

/** 一項付了多少 → 狀態 */
export type ItemPayState = 'paid' | 'partial' | 'unpaid';
export function itemPayState(amount: number, paid: number): ItemPayState {
  if (n(paid) <= 0) return 'unpaid';
  return n(paid) >= n(amount) ? 'paid' : 'partial';
}

/** 排序：部分付款的先，再金額小到大，再 id */
export function payOrder<T extends PayItem>(items: T[], paid: Record<string, number>): T[] {
  return [...items].sort((a, b) => {
    const pa = itemPayState(a.amount, paid[a.id] ?? 0) === 'partial' ? 0 : 1;
    const pb = itemPayState(b.amount, paid[b.id] ?? 0) === 'partial' ? 0 : 1;
    if (pa !== pb) return pa - pb;
    if (n(a.amount) !== n(b.amount)) return n(a.amount) - n(b.amount);
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** 這一筆 amount 會怎麼分到項目上（只回有分到錢的項目，照扣的順序） */
export function allocatePay(items: PayItem[], paid: Record<string, number>, amount: number): Alloc[] {
  let left = n(amount);
  const out: Alloc[] = [];
  for (const it of payOrder(items, paid)) {
    if (left <= 0) break;
    const before = n(paid[it.id] ?? 0);
    const need = n(it.amount) - before;
    if (need <= 0) continue;
    const give = Math.min(need, left);
    left = n(left - give);
    out.push({ id: it.id, give: n(give), before, after: n(before + give), amount: n(it.amount), done: n(before + give) >= n(it.amount) });
  }
  return out;
}

/** 每一項付了多少：拿「部分付款產生的支出」照項目加總（那是事實，不從付款紀錄倒推） */
export function paidFromExpenses(rows: { source_item_id: string | null; amount: number }[]): Record<string, number> {
  const paid: Record<string, number> = {};
  for (const r of rows) if (r.source_item_id) paid[r.source_item_id] = n((paid[r.source_item_id] ?? 0) + n(r.amount));
  return paid;
}

/** 儀表板：應付、已付、尚差 */
export function payTotals(items: PayItem[], payments: { amount: number }[]) {
  const due = n(items.reduce((s, i) => s + n(i.amount), 0));
  const paid = n(payments.reduce((s, p) => s + n(p.amount), 0));
  return { due, paid, left: n(Math.max(0, due - paid)), pct: due > 0 ? Math.min(100, (paid / due) * 100) : 0 };
}

/** 送出前的擋門。回 null 才能送 */
export function payError(amount: number, left: number, opts: { date?: string; account?: string } = {}): string | null {
  if (!(n(amount) > 0)) return '填實付金額';
  if (n(amount) > n(left)) return `超過尚差 $${Math.round(left).toLocaleString()}，不能多付`;
  if (opts.date !== undefined && !opts.date) return '填付款日';
  if (opts.account !== undefined && !opts.account) return '選安幸付款帳號';
  return null;
}

/** 抽屜底部那顆按鈕的字 */
export function payButtonLabel(paid: number, left: number): string {
  return n(paid) > 0 && n(left) > 0 ? `繼續付款 尚差 $${Math.round(left).toLocaleString()}` : '付款';
}

/**
 * 部分付款這條路能不能走（資料庫也會擋，這裡是讓畫面先講原因）。
 * ★ 暫支款與代墊的單只能一次付清 —— 那兩條路會在付清那一刻建暫付，
 *   分次付的話暫付要拆成好幾列，目前不支援。
 */
export function partialBlockedReason(r: { advance_category?: string | null; isLend?: boolean }): string | null {
  if (r.advance_category) return '暫支款的單只能一次付清';
  if (r.isLend) return '安幸代墊別本帳的單只能一次付清';
  return null;
}

/** 彈窗打開時停在哪一頁 */
export type PayTab = 'plan' | 'part' | 'all';
export function defaultPayTab(r: { needPlan: boolean; planned: boolean; paid: number }): PayTab {
  if (n(r.paid) > 0) return 'all';
  if (r.needPlan && !r.planned) return 'plan';
  return 'all';
}

/**
 * 付款那兩頁（部分付款／付清）能不能用。
 * ★ 匯款、信用卡、臨櫃、自動繳款要先排日期才能付（原本「排付款 → 確認付款日」的規則不變）。
 */
export function payTabBlocked(r: { needPlan: boolean; planned: boolean }): string | null {
  return r.needPlan && !r.planned ? '這種付款方式要先排日期，才能記付款' : null;
}
