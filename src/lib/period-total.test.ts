import test from 'node:test';
import assert from 'node:assert/strict';
import { periodTotal, feeLabel, type PeriodOrder } from './period-total.ts';

const rent = (amount: number, paid = false): PeriodOrder => ({ amount, paid });
const fixed = (amount: number, fee_type: string, paid = false, item_name?: string): PeriodOrder =>
  ({ amount, paid, imported_via: 'contract_fee', fee_type, item_name });
const oneoff = (amount: number, fee_type: string, paid = false): PeriodOrder =>
  ({ amount, paid, imported_via: 'manual', fee_type });
const disc = (amount: number, paid = false): PeriodOrder =>
  ({ amount: -Math.abs(amount), paid, imported_via: 'manual', fee_type: '折讓' });

// ── 使用者要的那個數字 ─────────────────────────────

test('應收 = 房租 + 固定加費 + 一次性費用', () => {
  const t = periodTotal([rent(110000)], [fixed(2000, '管理費'), oneoff(1500, '電費')]);
  assert.equal(t.rent, 110000);
  assert.equal(t.fixed, 2000);
  assert.equal(t.oneoff, 1500);
  assert.equal(t.net, 113500);
});

test('折讓是減項', () => {
  const t = periodTotal([rent(110000)], [fixed(2000, '管理費'), disc(5000)]);
  assert.equal(t.discount, 5000);
  assert.equal(t.net, 107000);
});

test('沒有任何加費時,應收就是房租', () => {
  const t = periodTotal([rent(110000)], []);
  assert.equal(t.net, 110000);
  assert.deepEqual(t.lines.map((l) => l.kind), ['rent']);
});

test('季繳:三張月租單合成一行房租', () => {
  const t = periodTotal([rent(30000), rent(30000), rent(30000)], []);
  assert.equal(t.rent, 90000);
  assert.equal(t.lines.length, 1, '年繳不該變成 12 行一樣的房租');
  assert.equal(t.lines[0].amount, 90000);
});

// ── 收齊判斷 ───────────────────────────────────────

test('★ 手動加費沒收就不算收齊 —— 改版前的 bug', () => {
  // 房租與固定加費都收了,只差一筆手動加的電費
  const t = periodTotal([rent(110000, true)], [fixed(2000, '管理費', true), oneoff(1500, '電費', false)]);
  assert.equal(t.allPaid, false,
    '改版前這裡是 true:畫面整期變綠,而那 $1,500 靜靜留在未收清單裡');
});

test('每一筆都收了才算收齊', () => {
  const t = periodTotal([rent(110000, true)], [fixed(2000, '管理費', true), oneoff(1500, '電費', true)]);
  assert.equal(t.allPaid, true);
});

test('固定加費沒收也不算收齊', () => {
  const t = periodTotal([rent(110000, true)], [fixed(2000, '管理費', false)]);
  assert.equal(t.allPaid, false);
});

test('季繳只收了兩個月不算收齊', () => {
  const t = periodTotal([rent(30000, true), rent(30000, true), rent(30000, false)], []);
  assert.equal(t.allPaid, false);
});

test('一張單都沒有時不算收齊 —— 空的不該顯示成已結清', () => {
  assert.equal(periodTotal([], []).allPaid, false);
});

// ── 明細的順序與標籤 ───────────────────────────────

test('順序固定:房租 → 固定加費 → 一次性 → 折讓', () => {
  const t = periodTotal([rent(110000)],
    [disc(1000), oneoff(1500, '電費'), fixed(2000, '管理費')]);
  assert.deepEqual(t.lines.map((l) => l.kind), ['rent', 'fixed', 'oneoff', 'discount']);
});

test('折讓標成負數,畫面才會顯示減號', () => {
  const t = periodTotal([rent(100)], [disc(50)]);
  assert.equal(t.lines[1].negative, true);
  assert.equal(t.lines[1].amount, 50, '金額存正數,正負由 negative 表達');
});

test('設備費要帶細目,否則三筆長得一模一樣', () => {
  assert.equal(feeLabel({ amount: 0, fee_type: '設備費', item_name: '冰箱' }), '設備費－冰箱');
  assert.equal(feeLabel({ amount: 0, fee_type: '管理費', item_name: null }), '管理費');
  assert.equal(feeLabel({ amount: 0, fee_type: null }), '加費');
});

test('金額 0 的加費不列出來 —— 那是雜訊', () => {
  const t = periodTotal([rent(100)], [fixed(0, '停車費')]);
  assert.equal(t.lines.length, 1);
});

