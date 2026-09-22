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
   * 收款方式（`orders.account`，收付款帳號的 code）。**只有收入有。**
   *
   * ★ 本來沒帶到畫面上 —— 表單填得到、存得進去，但抽屜上看不到，
   *   於是「這筆到底收進哪個帳」只能回頭按編輯才知道（2026-09-22 補）。
   */
  payAccount?: string | null;
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

/* ══════════════════════════════════════════════════════════
 * 應支與實支（migration_277）
 *
 * 2026-09-17 使用者:「愛皮 洪鯊 金額改成 應支 與 實支 /
 *   點進去 可以編輯 實際支出 / 看板區 應支 實支 差距」
 *
 * ══════════════════════════════════════════════════════════
 * 【★★★ 應支與實支是兩件事，而且來源不同】
 *
 *     應支  `expenses.amount`   —— 這筆帳欠多少
 *     實支  **看是不是代墊**:
 *           代墊  → 安幸在暫付頁按「收回」時記的 `refunded_amount`
 *           其餘  → `other_book_payments` 加起來
 *
 * ★★★ 代墊為什麼不在這裡記:同一筆錢**只有一個人寫**。
 *   兩邊各記一次的話會不一致，而且不會有任何地方報錯
 *   （README:一份資料存在兩個地方）。資料庫也有觸發器擋
 *   （`trg_obp_block_lent`）—— 這裡只是讓畫面先講得出為什麼。
 *
 * ★★ 差距**不存** —— 它是算出來的（README:推導值存成欄位）。
 * ══════════════════════════════════════════════════════════ */

/** 實支明細的一列。欄位名跟資料庫一致。 */
export type Payment = {
  id?: string;
  expense_id: string;
  paid_on: string | null;
  amount: number;
  method?: string | null;
  account?: string | null;
  note?: string | null;
};

/** 付費方式（2026-09-17 使用者指定的四種）。 */
export const PAY_METHODS = ['現金', '匯款', '信用卡', '加密貨幣'] as const;
export type PayMethod = (typeof PAY_METHODS)[number];

/** 這一列欠多少（應支）。 */
export const dueOf = (e: Entry): number => round(e.amount);

/**
 * 這一列實際付了多少（實支）。
 *
 * @param paymentsOf  這筆支出的付款明細
 * @param refundedOf  代墊時:那一列暫付收回了多少。**還沒收回回 null**
 *
 * ★★ `null` 與 `0` 是兩件事（跟 `advance.statusOf` 同一條規則）:
 *   還沒收回是 null，全額被扣才是 0。這裡兩者都算「實支 0」——
 *   因為從愛皮的帳上看，錢都還沒付出去。
 */
export function paidOf(
  e: Entry,
  paymentsOf: (expenseId: string) => Payment[] | undefined,
  refundedOf: (advanceId: string) => number | null | undefined,
): number {
  /* ★ 收入不走這一套 —— 它有自己的「已收款沒」（`settled`） */
  if (e.kind === 'income') return round(e.amount);
  if (isLent(e)) {
    const back = refundedOf(e.advanceId as string);
    return back == null ? 0 : round(back);
  }
  return (paymentsOf(e.id) ?? []).reduce((n, p) => n + round(p.amount), 0);
}

/**
 * 還差多少。**不會是負數** —— 付超過是另一件事（多付要退，不是「欠 −500」）。
 *
 * ★★ 這個帳本**一律整數台幣**（檔頭那支 `round()` 收到元）。
 *   所以先各自收成整數再相減 —— 反過來的話
 *   「3000.4 − 1000.4」會留下一個畫面上看不到的 0.0000001。
 */
export const gapOf = (due: number, paid: number): number =>
  Math.max(0, round(due) - round(paid));

/** 付清了沒。★ 應支 0 的那幾筆算付清 —— 沒有東西要付。 */
export const isSettledExpense = (due: number, paid: number): boolean =>
  round(paid) >= round(due);

/** 一整個月的總計（應支與實支分開）。 */
export type BookTotals = {
  income: number;
  /** 支出：**實支**總計（2026-09-17 使用者:「上方的支出 是 實支 總計」） */
  expense: number;
  /** 應支總計。跟實支不一樣時才要印出來 */
  due: number;
  net: number;
};

export function bookTotals(entries: Entry[], paid: (e: Entry) => number): BookTotals {
  let income = 0; let expense = 0; let due = 0;
  for (const e of entries ?? []) {
    if (e.kind === 'income') { income += round(e.amount); continue; }
    expense += round(paid(e));
    due += round(e.amount);
  }
  /* ★ 淨額用**實支** —— 那是真的離開過帳戶的錢 */
  return { income, expense, due, net: income - expense };
}

/**
 * 記一筆實支之前的檢查。回第一個錯，沒問題回 null。
 *
 * ★★ 這幾條跟資料庫是同一組規則（migration_277 的 `obp_amount_chk`、
 *   `paid_on not null`、`trg_obp_block_lent`）。兩邊都寫是刻意的:
 *   資料庫擋住任何路徑，這一層負責講出**為什麼**。
 */
export function validatePayment(
  e: Entry, p: Partial<Payment>, alreadyPaid: number,
): string | null {
  /*
   * ★★★ 代墊的不在這裡記 —— 同一筆錢只有一個人寫。
   *   訊息要說得出**去哪裡記**，不然他只知道不能按。
   */
  if (isLent(e)) {
    return '這筆是安幸代墊的 —— 實支請到「暫收付管理 → 暫付」按收回，那邊記完這裡會自己出現。';
  }
  if (!p.paid_on) return '要填付款日';
  const amt = Number(p.amount);
  if (!Number.isFinite(amt)) return '金額只能填數字';
  if (amt <= 0) return '金額要大於 0';
  /*
   * ★★ 這個帳本**只收整數** —— 畫面上的 `round()` 收到元，
   *   讓它存 1.5 的話「存進去的」跟「看到的」是兩個數字，
   *   而加總對不起來時沒有人查得出那 0.5 在哪
   *   （README:兩個格式不同的字串拿去比對，同一種病）。
   */
  if (!Number.isInteger(amt)) return '金額要填整數（這本帳不記小數）';

  /*
   * ★ 付超過**是提醒不是禁止**（跟暫付的收款帳戶同一條原則:
   *   系統負責看見，人負責決定）—— 所以這裡回 null，
   *   多付的那一句由 `overpayWarning()` 講。
   */
  return null;
}

/** 付超過時的提醒。沒超過回 null。 */
export function overpayWarning(due: number, paid: number, adding: number): string | null {
  const after = round(paid) + round(adding);
  if (after <= round(due)) return null;
  return `記完會變成實支 ${after}，比應支 ${round(due)} 多 ${round(after - round(due))} —— 確定嗎？`;
}


/* ══════════════════════════════════════════════════════════
 * 檢視抽屜長什麼樣（2026-09-22 使用者：「收入都是實收／要可以刪除／
 * 不用記一筆實支」）
 *
 * ★★★ 為什麼要有這支:那個抽屜本來**完全沒有分收入跟支出**，
 *   兩種都印支出的樣子 —— 標題寫「這筆支出」、看板是
 *   「應支／實支／差距」、底下掛著「＋ 記一筆實支」。
 *   收入根本沒有「應收多少 vs 實際收到多少」這個落差。
 *
 * ★★ 寫成一支純函式而不是在 `.tsx` 裡散三個 `kind === 'income'`:
 *   散著寫的話，以後補第三段時很容易只改到其中兩個，
 *   而畫面上就是「收入又冒出實支明細」—— 沒有地方會叫
 *   （「同一條規則在三個地方各寫一次」那條坑）。
 * ══════════════════════════════════════════════════════════ */
export type DrawerShape = {
  /** 上面那一段的標題 */
  title: string;
  /** 看板:收入是一個金額，支出是三格 */
  board: 'amount' | 'due-paid-gap';
  /** 有沒有「收款方式」那一列（收入才有的欄位） */
  payAccount: boolean;
  /** 有沒有「實支明細」那一段（含「＋ 記一筆實支」） */
  payments: boolean;
  /** 底下有沒有「刪除」 */
  del: boolean;
};

export function drawerShape(kind: Entry['kind']): DrawerShape {
  return kind === 'income'
    ? { title: '這筆收入', board: 'amount', payAccount: true, payments: false, del: true }
    : { title: '這筆支出', board: 'due-paid-gap', payAccount: false, payments: true, del: false };
}

/**
 * 刪收入之前要問的那一句。
 *
 * ★★ 括號裡寫**實際後果** —— 進回收桶的寫「可以復原」，真的 cascade 的
 *   寫「不可復原」。兩種寫成同一句話的話，那句話就不再有意義
 *   （anxing-ui 四-3）。這一筆走 `soft_delete`，所以是可以復原的那一種。
 * ★ 金額要印出來 —— 「刪除這筆收入?」自己講不出刪掉的是哪一筆。
 */
export function delIncomeMsg(name: string, amountText: string): string {
  return `刪除這筆收入「${name}」?\n\n`
    + `金額 $${amountText}\n\n`
    + `會移到回收桶 —— 復原之後這筆收入也會回來。`;
}
