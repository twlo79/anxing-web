import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  itemPayState, payOrder, allocatePay, paidFromExpenses, payTotals, payError,
  payButtonLabel, partialBlockedReason, defaultPayTab, payTabBlocked,
} from './partial-pay.ts';

// PR-202608-058 的九項
const IT = [
  { id: 'a', amount: 10700 }, { id: 'b', amount: 59920 }, { id: 'c', amount: 8560 },
  { id: 'd', amount: 33170 }, { id: 'e', amount: 49220 }, { id: 'f', amount: 49220 },
  { id: 'g', amount: 48150 }, { id: 'h', amount: 26750 }, { id: 'i', amount: 27820 },
];

test('itemPayState', () => {
  assert.equal(itemPayState(100, 0), 'unpaid');
  assert.equal(itemPayState(100, 40), 'partial');
  assert.equal(itemPayState(100, 100), 'paid');
});

test('第一筆 $20,000：從最小的開始扣，剩下的扣到下一項', () => {
  const a = allocatePay(IT, {}, 20000);
  assert.deepEqual(a.map((x) => [x.id, x.give, x.done]), [['c', 8560, true], ['a', 10700, true], ['h', 740, false]]);
});

test('繼續付：先接著扣部分繳的那一項', () => {
  const paid = { c: 8560, a: 10700, h: 740 };
  const a = allocatePay(IT, paid, 10000);
  assert.deepEqual(a.map((x) => [x.id, x.give, x.after, x.done]), [['h', 10000, 10740, false]]);
  const b = allocatePay(IT, paid, 27000);
  assert.deepEqual(b.map((x) => [x.id, x.give]), [['h', 26010], ['i', 990]]);
});

test('一樣大的照 id 排', () => {
  const o = payOrder(IT, {}).map((x) => x.id);
  assert.deepEqual(o.slice(-3), ['e', 'f', 'b']);
});

test('付清尚差：全部項目付滿，沒有多分', () => {
  const t = payTotals(IT, [{ amount: 20000 }]);
  assert.equal(t.due, 313510); assert.equal(t.left, 293510);
  const paid = { c: 8560, a: 10700, h: 740 };
  const a = allocatePay(IT, paid, t.left);
  assert.equal(a.reduce((s, x) => s + x.give, 0), 293510);
  assert.ok(a.every((x) => x.done));
});

test('剛好付滿一項', () => {
  const a = allocatePay(IT, {}, 8560);
  assert.deepEqual(a.map((x) => [x.id, x.done]), [['c', true]]);
});

test('paidFromExpenses 照項目加總', () => {
  assert.deepEqual(paidFromExpenses([{ source_item_id: 'h', amount: 740 }, { source_item_id: 'h', amount: 10000 }, { source_item_id: null, amount: 5 }]), { h: 10740 });
});

test('payError', () => {
  assert.equal(payError(0, 100), '填實付金額');
  assert.match(payError(101, 100)!, /超過尚差 \$100/);
  assert.equal(payError(100, 100), null);
  assert.equal(payError(50, 100, { date: '', account: 'x' }), '填付款日');
  assert.equal(payError(50, 100, { date: '2026-10-07', account: '' }), '選安幸付款帳號');
});

test('payButtonLabel', () => {
  assert.equal(payButtonLabel(0, 313510), '付款');
  assert.equal(payButtonLabel(20000, 293510), '繼續付款 尚差 $293,510');
});

test('partialBlockedReason / payTabBlocked / defaultPayTab', () => {
  assert.equal(partialBlockedReason({}), null);
  assert.match(partialBlockedReason({ advance_category: '暫支' })!, /暫支款/);
  assert.match(partialBlockedReason({ isLend: true })!, /代墊/);
  assert.equal(payTabBlocked({ needPlan: true, planned: false }) !== null, true);
  assert.equal(payTabBlocked({ needPlan: false, planned: false }), null);
  assert.equal(defaultPayTab({ needPlan: true, planned: false, paid: 0 }), 'plan');
  assert.equal(defaultPayTab({ needPlan: true, planned: true, paid: 0 }), 'all');
  assert.equal(defaultPayTab({ needPlan: false, planned: false, paid: 10 }), 'all');
});
