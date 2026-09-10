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
  /**
   * ★ 型別從 `CATEGORIES` 推導，不要再手寫一次字串聯集 ——
   *   2026-09-03 加「零用金」時就是兩邊各一份而漏掉這裡，tsc 才擋下來。
   *   往下再加一種時只要改 `CATEGORIES`。
   */
  category: (typeof CATEGORIES)[number];
  counterparty: string;
  usage: string;
  estate_id?: string | null;
  /** 用途的種類:'estate' | 'office'（migration_212）。跟 estate_id 一起才完整。 */
  purpose_type?: string | null;
  amount: number;
  paid_on?: string | null;
  /** 從哪個帳戶付出去的。收回時錢要回到同一個（2026-09-02 使用者指定）。 */
  paid_account?: string | null;
  refunded_on?: string | null;
  /** 實際收回多少。**null 與 0 是兩件事** —— 見 `statusOf`。 */
  refunded_amount?: number | null;
  refund_account?: string | null;
  forfeit_expense_id?: string | null;
  /**
   * 被扣的差額要記到哪個會計科目。
   *
   * ★ **不存進 advance_payments** —— 它是那筆支出的屬性，
   *   寫進 `expenses.account_code` 就好。放在型別裡只是為了讓
   *   收款抽屜的檢查看得到它（同一份表單的欄位）。
   */
  forfeit_account_code?: string | null;
  note?: string | null;
};

/** 2026-09-02 使用者:「類別有其他」。跟 migration_202 的 check 約束一致。 */
/**
 * 全部合法的類別 —— **驗證與顯示**用這一份。
 *
 * ★★★ 2026-09-10 補上「代墊」。migration_236 把它加進資料庫的 check，
 *   但這裡沒跟著加，於是:
 *
 *   ① `validateAdvance()` 會說一筆**完全正常**的代墊「要選類別」
 *   ② 下拉裡沒有這個值 → `<select>` 顯示成**空白**，
 *      而使用者隨手選一個，那一列就從代墊變成押金 ——
 *      **存檔成功，沒有任何東西會叫**
 *
 * ★★ 這是 `CLAUDE.md` 那條「加了新的寫入方式卻沒更新讀取端」
 *   的第五次（前四次:兩支月租單產生器、`hk_day.rooms_override`、
 *   憑證的借看層、`expenses.book`）。
 */
export const CATEGORIES = ['押金', '保證金', '零用金', '代墊', '其他'] as const;

/**
 * **人可以自己選**的類別 —— 新增暫付的下拉用這一份。
 *
 * ★★★ 「代墊」不在裡面:它只由請款單的觸發器產生
 *   （`gen_expenses_from_pr`，勾了「安幸代墊」時）。
 *   讓人手動建一筆代墊的話，那筆錢對不到任何一張請款單，
 *   而 `advance_id` 是空的 —— 沖銷時找不到要沖哪一筆支出。
 *
 * ★ 兩份清單分開，不是把「代墊」藏在畫面上用 if 過濾 ——
 *   規則寫在資料裡才測得到（下面有測試釘住兩份的關係）。
 */
export const MANUAL_CATEGORIES = CATEGORIES.filter((c) => c !== '代墊');

/**
 * 用途的種類（migration_212）。
 *
 * ★★★ 跟 `expenses.purpose_type` **同一套語意** —— 兩頁的「用途」
 *   必須是同一個意思，不然使用者要記兩套（CLAUDE.md 統一用語）。
 *
 * ★ 安幸辦公室不是物業，`estates` 裡沒有它。塞一筆進去的話
 *   它會出現在每一個物業下拉、每一張物業損益裡 —— 而它不出租。
 */
export const PURPOSE_OFFICE = 'office';
export const PURPOSE_ESTATE = 'estate';
export const OFFICE_LABEL = '安幸辦公室';

/** 用途那一格要顯示什麼。★ 沒填就是「—」，不要編一個出來。 */
export function purposeLabel(
  purposeType: string | null | undefined,
  estateId: string | null | undefined,
  estateName: (id: string) => string | undefined,
): string {
  if (purposeType === PURPOSE_OFFICE) return OFFICE_LABEL;
  return (estateId ? estateName(estateId) : '') || '—';
}

/**
 * 下拉選到某個值時，`purpose_type` 與 `estate_id` 該長什麼樣。
 *
 * ★★ 兩個欄位一起才構成「用途」，所以**一定要一起算**。
 *   分開設的話會出現 `office` 配一個 estate_id 的矛盾列 ——
 *   畫面顯示其中一個、報表讀另一個，而兩邊都不會叫
 *   （migration_210 那次就是這個形狀）。資料庫也有 `ap_purpose_chk` 擋。
 */
export function purposeFromSelect(v: string): { purpose_type: string; estate_id: string | null } {
  return v === PURPOSE_OFFICE
    ? { purpose_type: PURPOSE_OFFICE, estate_id: null }
    : { purpose_type: PURPOSE_ESTATE, estate_id: v || null };
}

/** 下拉現在該選哪一個。 */
export function purposeToSelect(
  purposeType: string | null | undefined,
  estateId: string | null | undefined,
): string {
  return purposeType === PURPOSE_OFFICE ? PURPOSE_OFFICE : (estateId ?? '');
}

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
/**
 * 缺哪幾個必填欄位（畫面順序）。
 *
 * ★★★ 2026-09-10 抽出來。`validateAdvance()` 一次只回**一句話**，
 *   畫面拿不到「是哪幾格」—— 於是四個紅星底下一格都畫不出紅框，
 *   使用者按了存不了、只看到一句話，要自己在四格裡找。
 *
 * ★★ 這裡**只管「有沒有填」**。格式錯（金額三位小數、類別不在清單裡）
 *   還是留給 `validateAdvance()` —— 那不是「沒填」，
 *   把它算成缺欄位的話紅框會指著一個明明填了東西的格子。
 *
 * ★ 標籤字要跟畫面上的一模一樣。2026-09-03「用途」改名叫「項目」時
 *   訊息沒跟著改，變成「畫面說項目、報錯說用途」——
 *   使用者會去找一個不存在的欄位。
 */
export function advanceMissing(a: Advance): string[] {
  const out: string[] = [];
  if (!a.usage?.trim()) out.push('項目');
  if (!(CATEGORIES as readonly string[]).includes(a.category)) out.push('類別');
  if (!a.counterparty?.trim()) out.push('對象');
  if (!(Number(a.amount) > 0)) out.push('暫付款');
  return out;
}

export function validateAdvance(a: Advance): string | null {
  if (!(CATEGORIES as readonly string[]).includes(a.category)) return '要選類別';
  if (!a.counterparty?.trim()) return '要填對象（錢付給誰）';
  /*
   * ★ 項目是必填。留空的話三個月後看到一筆 150,000 的暫付，
   *   只知道付給誰、不知道為什麼 —— 而要收回時得先想起那是什麼。
   *
   * ★★ 訊息裡的欄位名要跟**畫面上的標籤一致**。這一欄 2026-09-03
   *   從「用途」改名成「項目」（用途讓給了物業那個下拉），
   *   訊息沒跟著改的話會變成「畫面說項目、報錯說用途」——
   *   使用者會去找一個不存在的欄位。
   */
  if (!a.usage?.trim()) return '要填項目';

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

  /*
   * ★★★ 被扣的差額要選會計科目（2026-09-02 使用者:「可選會計科目」）。
   *
   *   不強制的話那筆支出會落進「未分類」或空的科目 —— 而三個月後
   *   看到一筆 2,000 的支出，沒有人查得出它是哪一筆押金被扣的。
   *
   * ★ 只在**這一次要產生**時才要求（`needsForfeitExpense`）。
   *   已經產生過的（forfeit_expense_id 有值）再開來看不該又被擋住 ——
   *   那筆支出早就存在，科目在它自己身上。
   */
  if (needsForfeitExpense(a) && !a.forfeit_account_code?.trim()) {
    return `沒收回的 ${forfeitedOf(a)} 要記成支出 —— 請選會計科目`;
  }

  return null;
}

/**
 * 收回時「收款帳戶」的預設值 —— **原本的出款帳戶**（2026-09-02 使用者指定）。
 *
 * ★ 回 null 時表示那筆暫付沒有記出款帳戶（手動建的、或舊單沒填），
 *   這時候要讓使用者自己選，而不是留空讓他以為系統知道。
 */
export const defaultRefundAccount = (a: Advance): string | null =>
  a.paid_account?.trim() || null;

/**
 * 收款帳戶跟出款帳戶不一樣時的提醒。一樣（或無從比較）回 null。
 *
 * ============================================================
 * 【★★ 為什麼是提醒不是禁止】
 *
 * 規則是「暫支要回到原支出帳戶」，但錢**確實有可能**回到別的帳戶 ——
 * 換帳戶、對方匯錯、公司帳戶關掉。硬鎖住的話那筆錢就記不進系統，
 * 而使用者只能改資料庫或亂填一個。
 *
 * ★ 系統負責看見，人負責決定（CLAUDE.md 的判斷原則）——
 *   所以這裡回一句話讓他看到，按下去還是存得了。
 */
export function refundAccountWarning(a: Advance): string | null {
  const from = a.paid_account?.trim();
  const to = a.refund_account?.trim();
  if (!from || !to) return null;
  if (from === to) return null;
  return `跟出款帳戶不同（原本是 ${from}）`;
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
