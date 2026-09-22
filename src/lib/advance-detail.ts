/**
 * 一筆暫付的「來龍去脈」——**哪一天付多少、哪一天還多少、之後還欠多少**。
 *
 * ============================================================
 * 【為什麼寫在 `.ts` 而不是頁面裡】
 *
 * 測試執行環境不處理 JSX（CLAUDE.md）。而這裡每一件事都是
 * **錯了不會報錯**的類型：
 *
 *   · 順序排錯   → 「之後還欠」一路減下來的數字整排是錯的，而每一列看起來都很正常
 *   · 方向搞反   → 把「安幸出款」畫成「愛皮出款」，代墊的意思整個相反
 *   · 少算一列   → 最後一列的剩餘跟清單上的「剩餘」對不起來，而沒有地方會叫
 *
 * ============================================================
 * 【★★★ 方向：出款是安幸出的】（2026-09-22 使用者指正）
 *
 * 代墊＝**安幸先付、對方之後還**。所以：
 *
 *     出款  `advance_payments.paid_account`   ← **安幸的帳戶**
 *     還款  `advance_repayments.out_account`  ← 對方的帳戶
 *           `advance_repayments.in_account`   ← 安幸的帳戶
 *
 * ★★ 證據不是猜的：`defaultRefundAccount()` 把收回時的**收款帳戶**
 *   預設成 `paid_account`，而那個下拉是 `accountsForBook(…, 'anxing')`。
 *
 * ============================================================
 * 【★★★ 「之後還欠」為什麼要在這裡算，不是畫面上邊畫邊減】
 *
 * 它是一條跨列的累計。寫在 JSX 的 `map` 裡就測不到，而它錯的時候
 * 每一列自己都是對的 —— 只有最後一列跟清單上的「剩餘」對不起來，
 * 而那兩個數字不會並排出現。
 */

/** 一次還款打在這一筆暫付上的一列（`advance_repayment_lines` ＋ 它那張還款單）。 */
export type RepayLine = {
  id: string;
  /** 這一次扣在這筆暫付上的金額 */
  amount: number;
  /** 那張還款單 */
  repayment_id: string;
  repaid_on: string;
  /** 對方的帳戶（錢從這裡出去） */
  out_account?: string | null;
  /** 安幸的帳戶（錢進到這裡） */
  in_account?: string | null;
  note?: string | null;
  created_at?: string | null;
  /** 那一張還款單一共扣了幾列暫付。1 的時候畫面不顯示（是噪音） */
  siblings?: number | null;
};

export type LedgerKind = 'out' | 'in' | 'settle';

export type LedgerRow = {
  kind: LedgerKind;
  date: string;
  /** 一律正數。正負號是畫面的事（暫付頁要、其他收支帳不要） */
  amount: number;
  /** 錢從哪個帳戶出去 */
  from?: string | null;
  /** 錢進到哪個帳戶 */
  to?: string | null;
  note?: string | null;
  /** 這一列發生**之後**還欠多少 */
  rest: number;
  repaymentId?: string;
  siblings?: number;
};

export type Ledger = {
  rows: LedgerRow[];
  /** 現在還欠多少（結清了就是 0） */
  owe: number;
  /** 結清時沒收足的差額 —— 那是被扣，要記成費用 */
  forfeited: number;
};

/** 收到分。★ 浮點數相減會漂（7350 - 6000.1 得到 1349.8999999999996）。 */
const cent = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * 排序：還款日 → 建立時間 → id。
 *
 * ★★★ 三個鍵缺一不可。只排還款日的話，同一天的兩張還款單順序是
 *   資料庫隨便給的，**每次重新整理「之後還欠」那一欄可能不一樣** ——
 *   跟 `repayOrder()`（`advance-repay.ts`）同一個理由。
 */
export function lineOrder<T extends RepayLine>(lines: readonly T[]): T[] {
  return [...(lines ?? [])].sort((x, y) =>
    String(x.repaid_on ?? '').localeCompare(String(y.repaid_on ?? ''))
    || String(x.created_at ?? '').localeCompare(String(y.created_at ?? ''))
    || String(x.id).localeCompare(String(y.id)));
}

export type LedgerAdvance = {
  amount: number;
  paid_on?: string | null;
  paid_account?: string | null;
  refunded_on?: string | null;
  counterparty?: string | null;
};

/**
 * 組出那張表。
 *
 * ★ 還沒出款（`paid_on` 是空的）回空的 —— 錢還沒出去，沒有來龍去脈可言。
 *   回一列「出款 —」的話畫面會說一筆還沒發生的事發生了。
 */
export function ledgerOf(a: LedgerAdvance, lines: readonly RepayLine[]): Ledger {
  if (!a?.paid_on) return { rows: [], owe: 0, forfeited: 0 };

  const total = cent(a.amount);
  const rows: LedgerRow[] = [{
    kind: 'out',
    date: a.paid_on,
    amount: total,
    from: a.paid_account ?? null,
    rest: total,
  }];

  let rest = total;
  for (const l of lineOrder(lines ?? [])) {
    const cut = cent(l.amount);
    /* ★ 夾在 0 以上：資料壞掉時寧可停在 0，不要畫出一個負的欠款 */
    rest = Math.max(0, cent(rest - cut));
    rows.push({
      kind: 'in',
      date: l.repaid_on,
      amount: cut,
      from: l.out_account ?? null,
      to: l.in_account ?? null,
      note: l.note ?? null,
      rest,
      repaymentId: l.repayment_id,
      siblings: Number(l.siblings ?? 1) || 1,
    });
  }

  /*
   * ★★★ 結清了而且沒收足 → 多一列「已結清（被扣）」。
   *   少了它的話最後一列的「之後還欠」是 1,350，而清單上的剩餘是 0 ——
   *   兩個數字都對，但它們講的不是同一件事，而畫面上看不出來。
   */
  let forfeited = 0;
  if (a.refunded_on != null) {
    forfeited = rest;
    if (forfeited > 0) {
      rows.push({ kind: 'settle', date: a.refunded_on, amount: forfeited, rest: 0 });
    }
    rest = 0;
  }

  return { rows, owe: rest, forfeited };
}
