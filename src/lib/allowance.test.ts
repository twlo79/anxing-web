import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allowanceError, allowanceFields, allowanceLabel } from './allowance.ts';

const D = { no: '', date: '', amount: 3000, note: '' };

test('折讓：只有金額必填；單號有填才檢查格式', () => {
  assert.equal(allowanceError(D), null);
  assert.match(allowanceError({ ...D, amount: 0 }) ?? '', /金額/);
  assert.equal(allowanceError({ ...D, no: 'ab12345678' }), null);   // 小寫自動轉大寫
  assert.match(allowanceError({ ...D, no: 'AB1234' }) ?? '', /格式不對/);
});

test('折讓：日期沒填用這一期第一天；備註寫進 item_name', () => {
  assert.deepEqual(allowanceFields(D, '2026-11-01'), { allowance_no: null, checkin: '2026-11-01', item_name: null });
  assert.deepEqual(allowanceFields({ ...D, no: 'ab12345678', date: '2026-11-15', note: ' 冷氣維修補償 ' }, '2026-11-01'),
    { allowance_no: 'AB12345678', checkin: '2026-11-15', item_name: '冷氣維修補償' });
});

test('折讓：顯示名稱', () => {
  assert.equal(allowanceLabel(null), '折讓');
  assert.equal(allowanceLabel('  '), '折讓');
  assert.equal(allowanceLabel('冷氣維修補償'), '冷氣維修補償');
});

import { allowanceBase, allowanceDeductError, allowanceDeductFields } from './allowance.ts';

test('折讓退款扣除：折讓金額取折讓單絕對值，沒讀到就用 實退＋扣除 推回去', () => {
  assert.equal(allowanceBase({ amount: -18000 }, { refund_amount: 17100, refund_deduct_amount: 900 }), 18000);
  assert.equal(allowanceBase(null, { refund_amount: 17100, refund_deduct_amount: 900 }), 18000);
  assert.equal(allowanceBase(null, { refund_amount: 18000 }), 18000);
});

test('折讓退款扣除：擋負數、擋超過折讓、有扣就要填項目', () => {
  assert.equal(allowanceDeductError(18000, '稅金', 900), null);
  assert.equal(allowanceDeductError(18000, '', 0), null);
  assert.match(allowanceDeductError(18000, '稅金', -1) ?? '', /負數/);
  assert.match(allowanceDeductError(18000, '稅金', 20000) ?? '', /超過/);
  assert.match(allowanceDeductError(18000, '  ', 900) ?? '', /項目/);
});

test('折讓退款扣除：實退 ＝ 折讓 − 扣除；扣 0 就清掉項目', () => {
  assert.deepEqual(allowanceDeductFields(18000, ' 稅金 ', 900), { refund_deduct_item: '稅金', refund_deduct_amount: 900, refund_amount: 17100 });
  assert.deepEqual(allowanceDeductFields(18000, '稅金', 0), { refund_deduct_item: null, refund_deduct_amount: 0, refund_amount: 18000 });
  assert.deepEqual(allowanceDeductFields(18000, '', 899.6), { refund_deduct_item: null, refund_deduct_amount: 900, refund_amount: 17100 });
});
