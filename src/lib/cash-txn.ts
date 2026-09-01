/**
 * 現金帳戶的流水：餘額累加與必填檢查。
 *
 * ============================================================
 * 【為什麼寫在 `.ts` 而不是頁面裡】
 *
 * 測試執行環境不處理 JSX（見 CLAUDE.md）—— 寫在 `.tsx` 裡的判斷式測不到。
 * 而這裡的兩件事都是**錯了不會報錯**的類型:
 *
 *   · 餘額算錯 → 數字看起來很正常，只是跟現實對不上
 *   · 必填漏檢 → 存進去一列空白的流水，之後沒有人知道那是什麼
 *
 * ============================================================
 * 【現金帳戶跟銀行帳戶的根本差異】
 *
 * 銀行帳戶的餘額是**銀行印在對帳單上的事實**——程式只是搬過來。
 * 現金帳戶沒有人印給你，餘額是**推導出來的**:上一筆 ± 這一筆。
 *
 * ★★★ 推導的東西有一個銀行帳戶沒有的問題:**插進中間會影響後面全部**。
 *
 *   已有:  8/12 −1,200 → 餘 15,500
 *          8/18 +8,000 → 餘 23,500
 *   現在補一筆 8/15 −500:
 *          8/12 −1,200 → 餘 15,500
 *          8/15   −500 → 餘 15,000   ← 新的
 *          8/18 +8,000 → 餘 23,000   ← **舊的那一筆餘額也要改**
 *
 * 只算新那一筆的話，8/18 的餘額會停在 23,500，而它跟前後兜不攏。
 * 所以每次異動都**整串重算**（`recalcBalances`），不做增量。
 *
 * ★ 整串重算聽起來浪費，但現金流水是手 key 的 —— 一年幾百筆頂天。
 *   增量更新省下的時間量不出來，換來的是「某些路徑忘了更新」的 bug。
 */

/** 重算需要的最小欄位。真正的 `Txn` 欄位更多，這裡只要這幾個。 */
export type CashRow = {
  id?: string;
  /** 帳務日。同一天有多筆時用 `seq` 決定先後。 */
  post_date: string;
  seq?: number | null;
  debit: number | string;
  credit: number | string;
  balance?: number | string;
};

/** 一列的淨額：存入為正、支出為負。 */
export function netOf(r: Pick<CashRow, 'debit' | 'credit'>): number {
  return (Number(r.credit) || 0) - (Number(r.debit) || 0);
}

/**
 * 把整串流水依「帳務日 → seq」排好，從 `opening` 開始累加餘額。
 *
 * 回傳**新的陣列**（不改動傳進來的），順序是舊到新。
 *
 * @param rows    這個帳戶的全部流水（順序不拘）
 * @param opening 期初餘額。留空當 0（使用者 2026-08-31 選的）
 *
 * ★★ 排序鍵要跟畫面上一致 —— 畫面照日期排、餘額照另一種順序累加的話，
 *   同一天有兩筆時餘額欄會看起來是跳的。
 *
 * ★ `seq` 用 `?? 0`:新 key 的那筆還沒有 seq，讓它排在同日最前面
 *   會比排在不確定的位置好 —— 至少是穩定的。
 */
export function recalcBalances<T extends CashRow>(rows: T[], opening = 0): T[] {
  const sorted = [...rows].sort(
    (a, b) =>
      (a.post_date < b.post_date ? -1 : a.post_date > b.post_date ? 1 : 0) ||
      (a.seq ?? 0) - (b.seq ?? 0),
  );

  let running = Number(opening) || 0;
  return sorted.map((r) => {
    running += netOf(r);
    /*
     * ★★ 四捨五入到分。累加浮點數會漂 ——
     *   0.1 + 0.2 得到 0.30000000000000004，累積幾百筆之後
     *   餘額會出現 15499.999999999998 這種數字寫進 numeric(14,2)。
     *   那不會報錯，只會讓某一天的餘額少一分錢而沒有人知道為什麼。
     */
    return { ...r, balance: Math.round(running * 100) / 100 };
  });
}

/**
 * 重算後**只挑出餘額真的變了的那幾列**。
 *
 * ★ 給前端用來決定要寫回哪幾列。全部都寫回去也會對，
 *   但那會讓每次新增都去動幾百列 —— 而每一次寫入都是一次出錯的機會。
 */
export function changedBalances<T extends CashRow & { id?: string }>(
  before: T[],
  after: T[],
): { id: string; balance: number }[] {
  const was = new Map(before.map((r) => [r.id, Number(r.balance) || 0]));
  const out: { id: string; balance: number }[] = [];
  for (const r of after) {
    if (!r.id) continue;
    const now = Number(r.balance) || 0;
    if (was.get(r.id) !== now) out.push({ id: r.id, balance: now });
  }
  return out;
}

/** 新增／編輯表單的內容。 */
export type CashDraft = {
  post_date: string;
  /**
   * 「交易帳號」欄填的東西。**存到哪一欄看帳戶類型**（migration_192）:
   *
   *     現金（kind=cash）  填**人名**    → 存 `counterparty`
   *     08311（kind=bank） 填**帳號**    → 存 `ref_no`
   *
   * ★★ 現金沒有對方帳號，所以那一欄借來放人名（2026-08-31 使用者指定）。
   *   08311 是真的銀行帳戶，匯款進來的對方是有帳號的
   *   —— 把帳號存進 `counterparty` 的話，那一欄在報表上的意思就變了
   *   （其他三個帳戶的 `counterparty` 存的是銀行名稱）。
   */
  counterparty: string;
  /** 存入或支出。 */
  dir: 'credit' | 'debit';
  /** 金額。字串是因為它直接來自 input。 */
  amount: string;
  memo: string;
};

/**
 * 表單檢查。回傳錯誤訊息，沒問題回 null。
 *
 * ★★★ 一次只回**第一個**錯誤。全部列出來的話訊息會變成一段文章，
 *   而人只會看第一行 —— 不如就給第一行。
 *
 * ★★ 「對不上的不猜」（CLAUDE.md）:金額打成 `1,000` 或 `１０００`
 *   這種看得出意圖的，這裡**不自動修**。修錯一個沒有人會發現。
 */
export function validateCash(d: CashDraft, asCash = true): string | null {
  if (!d.post_date) return '要填交易日';

  /*
   * ★ 訊息要講**這個帳戶**該填什麼。
   *   一律寫「人名」的話，在 08311 上填帳號的人會以為自己填錯了。
   */
  const name = d.counterparty.trim();
  if (!name) return asCash ? '要填交易帳號（人名）' : '要填交易帳號';

  /*
   * ★ 金額用 `Number()` 而不是 `parseFloat()`。
   *   `parseFloat('100元')` 回 100 —— 它會吃掉尾巴然後裝作沒事，
   *   而使用者以為自己填的是 100 元的手續費之類的東西。
   *   `Number('100元')` 回 NaN，會被下面擋下來。
   */
  const amt = Number(d.amount.trim());
  if (!d.amount.trim()) return '要填金額';
  if (!Number.isFinite(amt)) return '金額只能填數字';
  if (amt <= 0) return '金額要大於 0（是支出還是存入用上面的下拉選）';
  /*
   * ★ 分以下擋掉。`numeric(14,2)` 會把 100.005 存成 100.01 ——
   *   使用者看到的數字跟他打的不一樣，而畫面不會說。
   */
  if (Math.round(amt * 100) !== amt * 100) return '金額最多到小數點後兩位';
  if (amt >= 1e12) return '金額太大了，確認一下有沒有多打幾個 0';

  return null;
}

/**
 * 下一個 `seq`。
 *
 * ============================================================
 * 【★★★ 為什麼現金流水一定要有 seq】（2026-08-31 使用者:「編排日期出問題」）
 *
 * `seq` 原本的用途是「在那份對帳單裡的第幾列」—— 銀行流水從 PDF
 * 讀出來時自然就有。現金是手 key 的，一開始沒給它值，於是全是 null。
 *
 * 結果是同一天的幾筆在排序時**全部平手**:
 *
 *   畫面   `.order('post_date', desc).order('seq', desc)`
 *   重算   `(a.seq ?? 0) - (b.seq ?? 0)`  → 全是 0
 *
 * 兩邊都退回「陣列本來的順序」，而那是資料庫回什麼就是什麼。
 *
 * ★★ 症狀有兩層:
 *   看得見的  日期新到舊、同一天內卻舊到新，餘額欄讀起來像壞了
 *   看不見的  **順序不保證穩定** —— 下次新增一筆觸發重算，
 *             同一天那幾筆可能換順序，每一列的餘額跟著改。
 *             總額不變，所以不會有任何錯誤訊息。
 *
 * ★ 用「整個帳戶的最大值 ＋1」而不是「當天的最大值 ＋1」:
 *   全域遞增的話，`seq` 同時也是**這個帳戶的第幾筆**，
 *   補一筆舊日期時也不會跟當天既有的撞號。
 */
export function nextSeq(rows: Pick<CashRow, 'seq'>[]): number {
  let max = 0;
  for (const r of rows) {
    const n = Number(r.seq);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max + 1;
}

/**
 * 把通過檢查的表單變成要寫進資料庫的那一列（餘額還沒算，由 `recalcBalances` 補）。
 *
 * @param seq    這一列的排序號。**新增時一定要給** —— 見 `nextSeq` 的說明。
 *               編輯既有的列時傳原本的值，不然那一列會跳到最後面。
 * @param asCash 是不是現金帳戶（`kind === 'cash'`）。
 *               決定「交易帳號」欄存到 `counterparty` 還是 `ref_no`，
 *               以及交易型態寫「現金」還是「手動」。
 */
export function draftToRow(
  d: CashDraft, accountId: string, seq?: number, asCash = true,
) {
  const amt = Number(d.amount.trim());
  return {
    account_id: accountId,
    post_date: d.post_date,
    txn_date: d.post_date,
    /*
     * ★ `seq` 沒給就不寫（`undefined` 在 supabase-js 會被忽略）——
     *   編輯既有的列時不該動到它的排序。
     */
    ...(seq === undefined ? {} : { seq }),
    /*
     * ★★ 交易型態**不讓人自由填**（使用者 2026-08-31 指定）——
     *   自由填的話會出現「現金」「現金交易」「CASH」三種寫法，
     *   而依型態分組時它們是三個不同的東西。
     *
     * ★ 現金帳戶固定寫「現金」，
     *   手動記帳的**銀行**帳戶（08311）寫「手動」——
     *   兩個都寫「現金」的話，之後依型態分組會把銀行的那幾筆算進現金。
     */
    description: asCash ? '現金' : '手動',
    /*
     * ★★★ 同一個輸入框，兩個欄位（見 CashDraft.counterparty 的說明）。
     *   現金 → counterparty（人名）；銀行 → ref_no（對方帳號）。
     *   沒用到的那一欄寫 null，不是空字串 ——
     *   空字串在畫面上跟 null 長得一樣，但 `is null` 的查詢會分岔。
     */
    counterparty: asCash ? (d.counterparty.trim() || null) : null,
    debit: d.dir === 'debit' ? amt : 0,
    credit: d.dir === 'credit' ? amt : 0,
    memo: d.memo.trim() || null,
    ref_no: asCash ? null : (d.counterparty.trim() || null),
    statement_id: null,
    bank_balance: null,
  };
}
