import test from 'node:test';
import assert from 'node:assert/strict';
import {
  linesTotal, parentAmount, childLines, checkDeferral,
  deferralLabel, childLabel,
  recognizedTotal, paidTotal, paidCell,
  type DeferralLine, type ExpenseRow,
} from './deferral.ts';

const L = (on: string, amount: number): DeferralLine => ({ on, amount });
const PAID = '2026-08-08';

// ── 使用者給的兩個例子 ─────────────────────────────

test('例一：8/8 付 10,000,遞延到 9/8 與 10/8 → 母單本期 0,兩張子單', () => {
  const lines = [L('2026-09-08', 5000), L('2026-10-08', 5000)];
  assert.equal(parentAmount(10000, PAID, lines), 0);
  assert.deepEqual(childLines(PAID, lines), lines);
});

test('例二：其中一筆落在出款日 → 併進母單,只剩一張子單', () => {
  const lines = [L('2026-08-08', 5000), L('2026-09-08', 5000)];
  assert.equal(parentAmount(10000, PAID, lines), 5000);
  assert.deepEqual(childLines(PAID, lines), [L('2026-09-08', 5000)]);
});

test('母單 + 子單合計恆等於實付總額 —— 報表就是靠這條不用改', () => {
  for (const lines of [
    [L('2026-09-08', 5000), L('2026-10-08', 5000)],
    [L('2026-08-08', 5000), L('2026-09-08', 5000)],
    [L('2026-08-08', 10000)],
  ]) {
    const p = parentAmount(10000, PAID, lines);
    const c = linesTotal(childLines(PAID, lines));
    assert.equal(p + c, 10000, `合計不符:${JSON.stringify(lines)}`);
  }
});

test('全部落在出款日 → 沒有子單,母單就是全額', () => {
  const lines = [L('2026-08-08', 10000)];
  assert.equal(parentAmount(10000, PAID, lines), 10000);
  assert.deepEqual(childLines(PAID, lines), []);
});

// ── checkDeferral ──────────────────────────────────

test('合計剛好等於實付總額 → 過', () => {
  assert.deepEqual(checkDeferral(10000, PAID, [L('2026-09-08', 5000), L('2026-10-08', 5000)]), { ok: true });
});

test('合計少了就擋,並講出差多少', () => {
  const r = checkDeferral(10000, PAID, [L('2026-09-08', 5000)]);
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /還差 \$5,000/);
});

test('合計超過也擋', () => {
  const r = checkDeferral(10000, PAID, [L('2026-09-08', 8000), L('2026-10-08', 5000)]);
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /超過實付總額 \$3,000/);
});

test('一筆都沒填 → 擋', () => {
  assert.equal(checkDeferral(10000, PAID, []).ok, false);
});

test('缺日期或金額 <= 0 → 擋', () => {
  assert.equal(checkDeferral(10000, PAID, [L('', 10000)]).ok, false);
  assert.equal(checkDeferral(10000, PAID, [L('2026-09-08', 0), L('2026-10-08', 10000)]).ok, false);
  assert.equal(checkDeferral(10000, PAID, [L('2026-09-08', -5000), L('2026-10-08', 15000)]).ok, false);
});

test('同一天兩筆 → 擋,叫使用者合併', () => {
  const r = checkDeferral(10000, PAID, [L('2026-09-08', 5000), L('2026-09-08', 5000)]);
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /同一天/);
});

test('母單金額是 0 或負數 → 不能設遞延', () => {
  assert.equal(checkDeferral(0, PAID, [L('2026-09-08', 100)]).ok, false);
  assert.equal(checkDeferral(-100, PAID, [L('2026-09-08', 100)]).ok, false);
});

test('認列日早於出款日 → 不擋,但要提示會改動哪個月', () => {
  const r = checkDeferral(10000, PAID, [L('2026-07-08', 5000), L('2026-09-08', 5000)]);
  assert.equal(r.ok, true);
  assert.match((r as { warn: string }).warn, /2026-07/);
});

test('認列日都不早於出款日 → 沒有提示', () => {
  const r = checkDeferral(10000, PAID, [L('2026-08-08', 5000), L('2026-09-08', 5000)]);
  assert.deepEqual(r, { ok: true });
});

// ── 顯示文字 ───────────────────────────────────────

test('紅字要同時有實付總額與本期 —— 只有本期的話發票對不上', () => {
  const s = deferralLabel(10000, 5000);
  assert.match(s, /實付 \$10,000/);
  assert.match(s, /本期 \$5,000/);
});

test('childLabel 指回母單的日期', () => {
  assert.equal(childLabel('2026-08-08', '房租'), '↳ 遞延自 2026-08-08 房租');
  assert.equal(childLabel('2026-08-08', null), '↳ 遞延自 2026-08-08');
});

// ── 認列支出 vs 實際支出 ───────────────────────────

/** 8/8 付 10,000,分 8/8 5,000 與 9/8 5,000 兩期認列 */
const AUG: ExpenseRow[] = [
  { amount: 5000, gross_amount: 10000, parent_expense_id: null },   // 母單
];
const SEP: ExpenseRow[] = [
  { amount: 5000, gross_amount: null, parent_expense_id: 'p1' },    // 子單
];

test('8 月:認列 5,000,實際付了 10,000', () => {
  assert.equal(recognizedTotal(AUG), 5000);
  assert.equal(paidTotal(AUG), 10000);
});

test('9 月:認列 5,000,實際付了 0 —— 錢是 8 月出去的', () => {
  assert.equal(recognizedTotal(SEP), 5000);
  assert.equal(paidTotal(SEP), 0);
});

test('全期間:認列與實際都是 10,000', () => {
  const all = [...AUG, ...SEP];
  assert.equal(recognizedTotal(all), 10000);
  assert.equal(paidTotal(all), 10000);
});

test('沒有遞延時兩個數字相同 —— 舊資料的行為不變', () => {
  const plain: ExpenseRow[] = [
    { amount: 3000, gross_amount: null, parent_expense_id: null },
    { amount: 800, gross_amount: null, parent_expense_id: null },
  ];
  assert.equal(recognizedTotal(plain), 3800);
  assert.equal(paidTotal(plain), 3800);
});

test('paidCell:子單留空,不要印 0 讓人以為那天付了 0 元', () => {
  assert.equal(paidCell({ amount: 5000, parent_expense_id: 'p1' }), '');
  assert.equal(paidCell({ amount: 5000, gross_amount: 10000, parent_expense_id: null }), 10000);
  assert.equal(paidCell({ amount: 3000, parent_expense_id: null }), 3000);
});
