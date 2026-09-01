/**
 * 暫付：公司付出去、之後要收回來的押金與保證金（migration_196）。
 *
 * ============================================================
 * 【為什麼寫在 `.ts` 而不是頁面裡】
 *
 * 測試執行環境不處理 JSX（見 CLAUDE.md）—— 寫在 `.tsx` 裡的判斷式測不到。
 * 而這裡三件事全都是**錯了不會報錯**的類型:
 *
 *   · 狀態判斷錯   → 一筆早就收回的錢還躺在「在外面」的清單裡
 *   · 差額算錯     → 產生一筆金額不對的支出，而它看起來很正常
 *   · 重複產生支出 → 總額只是「多了一筆」，沒有人會回去比對
 *
 * ============================================================
 * 【★★★ 這個功能的會計立場】（2026-09-01 使用者選的）
 *
 *   出款   **不記費用**  —— 押金是暫時放在別人那裡的資產，不是花掉的錢
 *   收回   **不記收入**  —— 拿回自己的錢，不是賺到
 *   被扣   **記費用**    —— 這是唯一真的損失
 *
 * ★★ 站上對房客押金已經是這個立場（儀表板寫著「訂單總額・押金非營收」），
 *   我方付出去的押金要一致。不一致的話同一個概念在兩張報表上算法不同，
 *   而兩個數字都看起來很合理。
 */

/** 一列暫付。欄位名跟資料庫一致 —— 中間多一層對照表只會多一個出錯的地方。 */
export type Advance = {
  id?: string;
  category: '押金' | '保證金';
  counterparty: string;
  usage: string;
  estate_id?: string | null;
  amount: number;
  paid_on?: string | null;
  refunded_on?: string | null;
  /** 實際收回多少。**null 與 0 是兩件事** —— 見 `statusOf`。 */
  refunded_amount?: number | null;
  forfeit_expense_id?: string | null;
  note?: string | null;
};

export const CATEGORIES = ['押金', '保證金'] as const;

/**
 * 狀態。
 *
 * ★★★ `null` 與 `0` **不能合成一個**:
 *
 *     refunded_amount = null → 還沒收回，錢在外面
 *     refunded_amount = 0    → 收回了，但**全額被扣**（錢沒了）
 *
 *   用 `!refunded_amount` 判斷的話兩者都是 true，於是一筆被全額沒收的
 *   押金會永遠躺在「錢還在外面」的清單裡等一個不會來的退款。
 */
export type AdvanceStatus = 'draft' | 'paid' | 'refunded' | 'partial';

export function statusOf(a: Advance): AdvanceStatus {
  if (!a.paid_on) return 'draft';
  // ★ 用 `== null` 同時涵蓋 null 與 undefined，但**不涵蓋 0**
  if (a.refunded_on == null || a.refunded_amount == null) return 'paid';
  return Number(a.refunded_amount) < Number(a.amount) ? 'partial' : 'refunded';
}

export const STATUS_LABEL: Record<AdvanceStatus, string> = {
  draft:    '待出款',
  paid:     '已付款',
  refunded: '已退款',
  partial:  '部分退',
};

/**
 * 被扣掉多少 —— 也就是要轉成支出的金額。
 *
 * 還沒收回回 0（不是 null）：這個函式回答的是「目前確定損失多少」，
 * 而還沒收回時確定損失是 0。
 *
 * ★ 用 `Math.round(x * 100) / 100` 收到分。浮點數相減會漂
 *   （150000 - 148000.1 得到 1999.8999999999996），而那個數字
 *   會直接變成一筆支出的金額寫進資料庫。
 */
export function forfeitedOf(a: Advance): number {
  if (a.refunded_on == null || a.refunded_amount == null) return 0;
  const diff = Number(a.amount) - Number(a.refunded_amount);
  return Math.max(0, Math.round(diff * 100) / 100);
}

/**
 * 這一筆要不要產生「被扣」的支出。
 *
 * ★★★ 三個條件缺一不可:
 *   · 真的被扣了（差額 > 0）
 *   · 而且**還沒產生過**（`forfeit_expense_id` 是空的）—— 冪等靠這一條，
 *     沒有它的話重複按「確認收回」就是重複支出，
 *     而總額看起來只是「多了一筆」
 *   · 而且已經收回了（`statusOf` 是 partial）
 */
export function needsForfeitExpense(a: Advance): boolean {
  return statusOf(a) === 'partial'
    && forfeitedOf(a) > 0
    && !a.forfeit_expense_id;
}

/** 錢還在外面（已付款但還沒收回）。統計卡與「待收回」清單用。 */
export const isOutstanding = (a: Advance) => statusOf(a) === 'paid';

/**
 * 新增／編輯的必填檢查。回傳錯誤訊息，沒問題回 null。
 *
 * ★★ 一次只回**第一個**錯誤。全部列出來會變成一段文章，而人只看第一行。
 */
export function validateAdvance(a: Advance): string | null {
  if (!CATEGORIES.includes(a.category)) return '要選押金或保證金';
  if (!a.counterparty?.trim()) return '要填對象（錢付給誰）';
  /*
   * ★ 用途是必填。留空的話三個月後看到一筆 150,000 的暫付，
   *   只知道付給誰、不知道為什麼 —— 而要收回時得先想起那是什麼。
   */
  if (!a.usage?.trim()) return '要填用途';

  const amt = Number(a.amount);
  if (!Number.isFinite(amt)) return '金額只能填數字';
  if (amt <= 0) return '金額要大於 0';
  if (Math.round(amt * 100) !== amt * 100) return '金額最多到小數點後兩位';

  return validateRefund(a);
}

/**
 * 收回那一段的檢查。獨立出來因為「確認收回」的視窗只填這幾欄。
 *
 * ★★★ 這幾條跟資料庫的 check 約束**是同一組規則**（migration_196）。
 *   兩邊都寫是刻意的:資料庫那層擋住任何路徑（包含手動改資料），
 *   這一層負責講出**為什麼** —— 資料庫只會回一句
 *   `violates check constraint "ap_refund_pair_chk"`，
 *   而使用者看到那句話不知道要改哪一欄。
 */
export function validateRefund(a: Advance): string | null {
  const hasDate = !!a.refunded_on;
  const hasAmt = a.refunded_amount != null && a.refunded_amount !== ('' as unknown as number);

  // ★ 成對。只有其中一個的話，狀態落在「已退款」與「已付款」之間
  if (hasDate !== hasAmt) {
    return hasDate ? '填了收回日就要填收回金額（全額被扣就填 0）' : '填了收回金額就要填收回日';
  }
  if (!hasDate) return null;

  const back = Number(a.refunded_amount);
  if (!Number.isFinite(back)) return '收回金額只能填數字';
  if (back < 0) return '收回金額不能是負數';
  if (back > Number(a.amount)) {
    return `收回 ${back} 比付出去的 ${a.amount} 還多 —— 多的那部分不是押金，要另外記一筆收入`;
  }
  if (!a.paid_on) return '還沒出款，不能先收回';
  if (a.refunded_on! < a.paid_on) return '收回日不能早於出款日';

  return null;
}

/** 一組暫付的統計。暫付分頁的三張卡用。 */
export type AdvanceStats = {
  paid:      { n: number; amt: number };   // 錢還在外面
  refunded:  { n: number; amt: number };   // 收回了（含部分退收回的部分）
  forfeited: { n: number; amt: number };   // 被扣掉的
};

/**
 * ★★ 「被扣」單獨一格，不混進「已退款」。
 *   混在一起的話「我們今年被扣了多少押金」永遠沒有人查得到 ——
 *   而那正是這張表存在的理由之一。
 */
export function statsOf(rows: Advance[]): AdvanceStats {
  const out: AdvanceStats = {
    paid: { n: 0, amt: 0 }, refunded: { n: 0, amt: 0 }, forfeited: { n: 0, amt: 0 },
  };
  for (const a of rows ?? []) {
    const st = statusOf(a);
    if (st === 'draft') continue;   // 還沒出款的錢還在我們帳上，不算暫付
    if (st === 'paid') {
      out.paid.n += 1;
      out.paid.amt += Number(a.amount) || 0;
      continue;
    }
    out.refunded.n += 1;
    out.refunded.amt += Number(a.refunded_amount) || 0;
    const lost = forfeitedOf(a);
    if (lost > 0) { out.forfeited.n += 1; out.forfeited.amt += lost; }
  }
  // ★ 四捨五入到分。累加浮點數會漂，而漂出來的數字會直接印在卡片上
  for (const k of ['paid', 'refunded', 'forfeited'] as const) {
    out[k].amt = Math.round(out[k].amt * 100) / 100;
  }
  return out;
}
