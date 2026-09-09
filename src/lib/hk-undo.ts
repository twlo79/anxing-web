/**
 * 撤銷「產生收支」的那一批。
 *
 * ============================================================
 * 【★★★ 為什麼需要它】（2026-09-09 使用者:「多一個功能 產生後的可以撤銷」）
 *
 * 產生是**冪等**的:已經產生過的不會再產生一次。這在正常情況下很好，
 * 但單價設錯、工單漏登、拆帳金額打錯的時候就變成
 * 「按下去就回不來了」—— 而那正是最需要回得來的時候。
 *
 * 在有這支之前，唯一的解法是進 SQL Editor 手寫 DELETE。
 * 而那條路我們踩過:SQL Editor 沒有 `auth.uid()`,
 * `soft_delete()` 會**回成功但一筆都沒刪**（2026-09-04 踩過）。
 *
 * ============================================================
 * 【★★ 撤銷的範圍是「這個月整批」，不是「剛才按的那次」】
 *
 * 記錄「哪一次按的」要另外存批次 id，多一層狀態卻解不了真正的問題:
 * 隔天發現單價錯的時候，想撤的是整個月，不是某一次的點擊。
 *
 * ★ 而且產生本來就是每月冪等的 —— 「這個月的那一批」是有定義的東西。
 *
 * ============================================================
 * 【★★★ 成對的兩筆一定要一起走】
 *
 * 只刪支出不刪收入的話，安幸帳上會留著一筆收入而物業沒有成本 ——
 * 兩張報表各自看起來都正常，只有相減的時候差一截。
 *
 * 所以這支把兩邊放進**同一個清單**，畫面上也一起數。
 *
 * ============================================================
 * 【被動過的那幾筆】（2026-09-09 使用者選「照刪，但先讓我看過」）
 *
 * 產生完之後有人改了項目名稱、設了遞延、或那筆收入已經收款 ——
 * 那些**照樣刪**，但要先列出來讓人看到自己在刪什麼。
 *
 * ★ 不擋下來的理由:擋住的話那幾筆會變成孤兒 ——
 *   成對的另一半被刪了，它自己留在帳上，而那比整批刪掉更難查。
 */

/** 產生出來的支出（撤銷時要判斷的欄位）。 */
export type UndoExpense = {
  id: string;
  hk_job_key: string | null;
  hk_labor_key: string | null;
  item_name: string | null;
  amount: number;
  spent_on: string;
  deferred?: boolean | null;
  parent_expense_id?: string | null;
};

/** 產生出來的收入。 */
export type UndoOrder = {
  id: string;
  order_key: string;
  item_name: string | null;
  amount: number;
  checkin: string | null;
  paid?: boolean | null;
};

export type UndoRow = {
  id: string;
  kind: 'expense' | 'order';
  /** 冪等鍵。撤銷完之後再按產生，靠它重新長回來 */
  key: string;
  /** 給人看的一行：日期 ＋ 項目 */
  label: string;
  amount: number;
  /** 被動過的原因。`null` = 產生之後沒有人碰過 */
  touched: string | null;
};

export type UndoPlan = {
  rows: UndoRow[];
  expCount: number; expAmount: number;
  incCount: number; incAmount: number;
  /** 被動過的那幾筆（`rows` 的子集，順序一致） */
  touched: UndoRow[];
};

export const REV_PREFIX = 'HKREV|';
export const LABREV_PREFIX = 'HKLABREV|';

/** 從收入的 `order_key` 取回它對應的支出鍵。不是這兩種前綴就回 null。 */
export function keyOfOrder(orderKey: string): string | null {
  if (orderKey?.startsWith(REV_PREFIX)) return orderKey.slice(REV_PREFIX.length);
  if (orderKey?.startsWith(LABREV_PREFIX)) return orderKey.slice(LABREV_PREFIX.length);
  return null;
}

const money = (n: number) => Math.round(Number(n) || 0);

export function planUndo(input: {
  expenses: UndoExpense[];
  orders: UndoOrder[];
  /** 這個月預覽算出來的支出鍵 —— 範圍就是它 */
  keys: ReadonlySet<string>;
  /**
   * 這個鍵**現在**算出來的項目名稱。
   *
   * ★ 用來判斷「有沒有被改過」。查不到就回 undefined —— 那時候不判斷，
   *   不要因為查不到就說「被改過」，那會讓每一筆都亮黃燈。
   */
  expectedName?: (key: string) => string | undefined;
}): UndoPlan {
  const rows: UndoRow[] = [];
  const nameOf = input.expectedName ?? (() => undefined);

  const changed = (key: string, actual: string | null): string | null => {
    const want = nameOf(key);
    if (want == null) return null;
    return (actual ?? '') === want ? null : '項目名稱被改過';
  };

  for (const e of input.expenses ?? []) {
    const key = (e.hk_job_key && input.keys.has(e.hk_job_key)) ? e.hk_job_key
      : (e.hk_labor_key && input.keys.has(e.hk_labor_key)) ? e.hk_labor_key
        : null;
    if (!key) continue;
    /*
     * ★★ 遞延排在名稱之前 —— 一筆同時被改名又設了遞延時，
     *   要講的是遞延（刪掉會連子單一起沒），改名只是文字。
     */
    const why = (e.deferred || e.parent_expense_id) ? '設了遞延認列'
      : changed(key, e.item_name);
    rows.push({
      id: e.id, kind: 'expense', key,
      label: `${e.spent_on}　${e.item_name ?? '（沒有項目）'}`,
      amount: money(e.amount), touched: why,
    });
  }

  for (const o of input.orders ?? []) {
    const key = keyOfOrder(o.order_key);
    if (!key || !input.keys.has(key)) continue;
    const why = o.paid ? '這筆收入已經收款'
      : changed(key, o.item_name);
    rows.push({
      id: o.id, kind: 'order', key,
      label: `${o.checkin ?? ''}　${o.item_name ?? '（沒有項目）'}`,
      amount: money(o.amount), touched: why,
    });
  }

  const exp = rows.filter((r) => r.kind === 'expense');
  const inc = rows.filter((r) => r.kind === 'order');
  return {
    rows,
    expCount: exp.length, expAmount: exp.reduce((a, r) => a + r.amount, 0),
    incCount: inc.length, incAmount: inc.reduce((a, r) => a + r.amount, 0),
    touched: rows.filter((r) => r.touched),
  };
}

/*
 * ══════════════════════════════════════════════════════
 * 【這裡曾經有 undoConfirmText()，2026-09-09 當天就刪了】
 *
 * 它產生一段給 `confirm()` 用的文字。但確認改成畫在面板裡了 ——
 * `confirm()` 是瀏覽器的彈窗，而這一頁的規矩是
 * **訊息要出現在動作發生的地方**（flash 跳在頁面最上方那條坑）。
 *
 * ★ 不留著「以防萬一」:一支沒有人呼叫的文案函式，
 *   下一個人會以為那是現行的說法，然後改它 —— 而畫面不會有任何反應。
 * ══════════════════════════════════════════════════════
 */
