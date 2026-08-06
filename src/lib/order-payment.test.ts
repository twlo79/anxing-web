import test from 'node:test';
import assert from 'node:assert/strict';
import {
  payStatus, remaining, isExempt, checkPayment, sumPayments, lastPaidOn,
  type PayableOrder, type PaymentRow,
} from './order-payment.ts';

const o = (amount: number | null, paid_amount: number | null, source = 'private'): PayableOrder =>
  ({ source, amount, paid_amount });

test('payStatus:完全沒收 → 未收款', () => {
  assert.equal(payStatus(o(10000, 0)), 'unpaid');
  assert.equal(payStatus(o(10000, null)), 'unpaid');
});

test('payStatus:收了一部分 → 部分收款', () => {
  assert.equal(payStatus(o(10000, 3000)), 'partial');
  assert.equal(payStatus(o(10000, 9999)), 'partial');
});

test('payStatus:剛好收滿 → 已收款', () => {
  assert.equal(payStatus(o(10000, 10000)), 'paid');
});

test('payStatus:超收也算已收款,不是別的狀態', () => {
  assert.equal(payStatus(o(10000, 12000)), 'paid');
});

test('payStatus:Airbnb 與 Agoda 免填', () => {
  assert.equal(payStatus(o(10000, 0, 'airbnb')), 'exempt');
  assert.equal(payStatus(o(10000, 0, 'agoda')), 'exempt');
  assert.equal(payStatus(o(10000, 0, 'airbnb_cancelled')), 'exempt');
});

test('payStatus:搭檔收款仍要追 —— 錢在搭檔手上,還是得收回來', () => {
  assert.equal(payStatus(o(10000, 0, 'partner')), 'unpaid');
});

test('payStatus:0 元訂單視為已收款,不該永遠掛在待收清單', () => {
  assert.equal(payStatus(o(0, 0)), 'paid');
});

test('payStatus:負數訂單（折讓）視為已收款', () => {
  assert.equal(payStatus(o(-5000, 0)), 'paid');
});

test('payStatus:小數點四捨五入後相等就算收滿', () => {
  // 9999.6 → 10000，不該因為浮點差而永遠停在「部分收款」
  assert.equal(payStatus(o(10000, 9999.6)), 'paid');
});

test('remaining:還差多少', () => {
  assert.equal(remaining(o(10000, 3000)), 7000);
  assert.equal(remaining(o(10000, 0)), 10000);
});

test('remaining:收滿或超收都回 0,不會出現負數', () => {
  assert.equal(remaining(o(10000, 10000)), 0);
  assert.equal(remaining(o(10000, 12000)), 0);
});

test('isExempt', () => {
  assert.equal(isExempt('airbnb'), true);
  assert.equal(isExempt('private'), false);
  assert.equal(isExempt('oneoff'), false);
});

test('checkPayment:金額 0 或空 → 擋下', () => {
  assert.deepEqual(checkPayment(0, 5000, 10000), { ok: false, error: '請輸入收款金額' });
});

test('checkPayment:負數 → 擋下,並說明怎麼沖銷', () => {
  const r = checkPayment(-100, 5000, 10000);
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /刪除該筆收款/);
});

test('checkPayment:金額在尚欠之內 → 直接過,不囉嗦', () => {
  assert.deepEqual(checkPayment(3000, 5000, 10000), { ok: true });
  assert.deepEqual(checkPayment(5000, 5000, 10000), { ok: true });
});

test('checkPayment:超收 → 不擋,但要問一聲並說出差多少', () => {
  const r = checkPayment(6000, 5000, 10000);
  assert.equal(r.ok, true);
  assert.match((r as { confirm: string }).confirm, /超過尚欠的 \$5,000/);
  assert.match((r as { confirm: string }).confirm, /多 \$1,000/);
});

test('checkPayment:0 元訂單不做超收檢查', () => {
  assert.deepEqual(checkPayment(500, 0, 0), { ok: true });
});

const p = (paid_on: string, amount: number): PaymentRow =>
  ({ id: Math.random().toString(36).slice(2), paid_on, amount, account: null, note: null });

test('sumPayments', () => {
  assert.equal(sumPayments([p('2026-01-01', 3000), p('2026-02-01', 7000)]), 10000);
  assert.equal(sumPayments([]), 0);
});

test('lastPaidOn:取最晚的一天,不是最後輸入的那筆', () => {
  assert.equal(lastPaidOn([p('2026-03-01', 1), p('2026-01-01', 1), p('2026-02-01', 1)]), '2026-03-01');
  assert.equal(lastPaidOn([]), null);
});
