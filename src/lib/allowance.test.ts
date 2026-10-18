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
