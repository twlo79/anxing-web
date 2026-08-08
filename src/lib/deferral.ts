/**
 * 支出的遞延認列。
 *
 * ============================================================
 * 【要解決什麼】
 *
 * 8/8 付了一整年的房租 120,000，但那筆錢應該分 12 個月認列，
 * 不該讓 8 月的費用暴增然後之後 11 個月都是 0。
 *
 *
 * ============================================================
 * 【為什麼母單的金額會變小 —— 這是整支最重要的一件事】
 *
 * 系統裡**沒有支出認列表**。營收有 revenue_recognitions，支出沒有：
 * 財務儀表板、Excel、月報全都是直接
 *
 *     sum(expenses.amount) group by spent_on
 *
 * 所以如果母單留著 10,000、又生出 5,000 + 5,000 的子單，
 * 儀表板會算出 8月 10,000 ＋ 9月 5,000 ＋ 10月 5,000 = **20,000**。
 * 這筆房租變成兩倍，而且不會報錯。
 *
 * 解法是讓 amount 的語意從「付了多少」變成「這一天認列多少」：
 *
 *     母單.amount = 實付總額 − 所有子單合計
 *     母單.gross_amount = 實付總額（給對發票、對銀行用）
 *
 * 這樣 sum(amount) 恆等於實付總額，**所有既有報表一行都不用改**。
 *
 * 代價是母單那一列的金額可能是 0。畫面上必須把實付總額顯示出來，
 * 否則會計拿 10,000 的發票來搜會找不到 —— 見 deferralLabel()。
 *
 *
 * ============================================================
 * 【子單日期 = 出款日時會併進母單】
 *
 * 8/8 付款，遞延填「8/8 5,000、9/8 5,000」：
 *
 *     母單 8/8  amount 5,000   ← 8/8 那筆併進來了
 *     子單 9/8  amount 5,000
 *
 * 不併的話會出現兩列同一天的支出，看起來像重複入帳。
 */

export type DeferralLine = {
  /** 認列日 'YYYY-MM-DD' */
  on: string;
  amount: number;
};

const round = (n: unknown) => Math.round(Number(n) || 0);

/** 明細合計。 */
export const linesTotal = (lines: DeferralLine[]) =>
  (lines ?? []).reduce((a, l) => a + round(l.amount), 0);

/**
 * 母單自己那一期認列多少。
 *
 * = 實付總額 − 不在出款日的子單合計
 *
 * 換句話說：落在出款日當天的明細會併進母單，其餘的才變成子單。
 */
export function parentAmount(gross: number, paidOn: string, lines: DeferralLine[]): number {
  const children = (lines ?? []).filter((l) => l.on !== paidOn);
  return round(gross) - linesTotal(children);
}

/** 真正會變成獨立子單的那幾筆（排除跟出款日同一天的）。 */
export function childLines(paidOn: string, lines: DeferralLine[]): DeferralLine[] {
  return (lines ?? []).filter((l) => l.on !== paidOn && round(l.amount) !== 0);
}

export type DeferralCheck =
  | { ok: true; warn?: string }
  | { ok: false; error: string };

/**
 * 存檔前的檢查。
 *
 * 規則（使用者定的）：**合計必須剛好等於實付總額，否則不成立**。
 * 差一塊都不給存 —— 不擋的話母單金額會變成負數或多出一筆對不到的錢，
 * 而且因為報表只看 sum(amount)，那個差額會靜靜地混進某個月的費用裡。
 */
export function checkDeferral(gross: number, paidOn: string, lines: DeferralLine[]): DeferralCheck {
  const g = round(gross);
  if (g <= 0) return { ok: false, error: '這筆支出沒有金額,不能設遞延認列' };

  const rows = (lines ?? []).filter((l) => l.on || round(l.amount));
  if (!rows.length) return { ok: false, error: '請至少填一筆認列日與金額' };

  for (const l of rows) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(l.on || '')) return { ok: false, error: '每一筆都要填認列日' };
    if (round(l.amount) <= 0) return { ok: false, error: '認列金額要大於 0' };
  }

  const dup = rows.map((l) => l.on);
  if (new Set(dup).size !== dup.length) {
    return { ok: false, error: '同一天不能有兩筆認列,請合併成一筆' };
  }

  const total = linesTotal(rows);
  if (total !== g) {
    const diff = g - total;
    return {
      ok: false,
      error: diff > 0
        ? `還差 $${diff.toLocaleString('en-US')} 才等於實付總額 $${g.toLocaleString('en-US')}`
        : `超過實付總額 $${Math.abs(diff).toLocaleString('en-US')}`,
    };
  }

  /*
   * 認列日早於出款日 = 回頭改動已經過去的月份。
   * 不擋 —— 預付費用的回沖確實存在 —— 但要講出來:
   * 那個月的費用總額當下就變了,如果已經對過帳就對不上了。
   */
  const back = rows.filter((l) => l.on < paidOn).map((l) => l.on.slice(0, 7));
  if (back.length) {
    const ms = Array.from(new Set(back)).sort().join('、');
    return { ok: true, warn: `有認列日早於出款日,會改動 ${ms} 的費用總額。該月若已對帳請重新確認。` };
  }
  return { ok: true };
}

const money = (n: number) => Math.round(n).toLocaleString('en-US');

/**
 * 母單那一列的紅字。
 *
 * 一定要同時講出「實付總額」與「本期認列」——
 * 只顯示本期的話,會計拿 10,000 的發票對不上任何一列。
 */
export function deferralLabel(gross: number, thisPeriod: number): string {
  return `遞延認列・實付 $${money(gross)}・本期 $${money(thisPeriod)}`;
}

/** 子單那一列的說明，點了可以回母單。 */
export function childLabel(paidOn: string, itemName: string | null): string {
  return `↳ 遞延自 ${paidOn} ${itemName ?? ''}`.trim();
}

/**
 * 遞延之後，支出有兩個數字，兩個都要看得到。
 *
 * 【為什麼一定要分開】
 * 8/8 付了 10,000 分兩期認列。8 月的
 *
 *     認列支出 = 0        （費用還沒發生）
 *     實際支出 = 10,000   （錢真的出去了）
 *
 * 只看認列會以為 8 月沒花錢，銀行對帳時對不上；
 * 只看實際會讓 9、10 月的費用憑空消失。兩個都要。
 */
export type ExpenseRow = {
  amount: number | null;
  gross_amount?: number | null;
  parent_expense_id?: string | null;
};

/**
 * 認列支出 —— 這段期間的費用是多少。
 * 就是 sum(amount)，跟改版前的「總支出」完全一樣。
 */
export function recognizedTotal(rows: ExpenseRow[]): number {
  return (rows ?? []).reduce((a, r) => a + round(r.amount), 0);
}

/**
 * 實際支出 —— 這段期間真的付出去多少錢。
 *
 * 子單不算：那幾筆沒有付款事實，錢是母單那天一次付掉的。
 * 母單算 gross_amount（實付總額），一般支出算 amount。
 */
export function paidTotal(rows: ExpenseRow[]): number {
  return (rows ?? [])
    .filter((r) => !r.parent_expense_id)
    .reduce((a, r) => a + round(r.gross_amount ?? r.amount), 0);
}

/** Excel 的「實際支出」欄。子單留空 —— 那一列沒有付款事實。 */
export function paidCell(r: ExpenseRow): number | '' {
  if (r.parent_expense_id) return '';
  return round(r.gross_amount ?? r.amount);
}
