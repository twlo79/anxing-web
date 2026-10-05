import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canPricingFee, feeOf, pricingAccountOf, totalsByAccount, PRICING_TITLE, ymOfCheckin, orderIdOfKey, recentYms, rowsOfMonth, pickMonth } from './pricing-fee.ts';

test('canPricingFee：跟支出同一組角色', () => {
  assert.equal(canPricingFee('accountant'), true);
  assert.equal(canPricingFee('super_admin'), true);
  assert.equal(canPricingFee('housekeeper'), false);
  assert.equal(canPricingFee(null), false);
});
test('feeOf：訂單 × 費率，無條件進位到元（migration_313）', () => {
  assert.equal(feeOf(32268, 0.015), 485);     // 484.02 → 485
  assert.equal(feeOf(35493, 0.015), 533);     // 532.395 → 533
  assert.equal(feeOf(32976, 0.015), 495);     // 494.64 → 495
  assert.equal(feeOf(20000, 0.015), 300);     // 剛好整除：JS 浮點 300.00000000000006 不可以變 301
  assert.equal(feeOf(41200, 0.015), 618);
  assert.equal(feeOf(null, 0.015), 0);
});
test('付款帳戶：正隆 4145，其他 8088', () => {
  assert.equal(pricingAccountOf('正隆'), '4145');
  assert.equal(pricingAccountOf('開封'), '8088');
  assert.equal(pricingAccountOf(null), '8088');
  assert.deepEqual(totalsByAccount([{ pay_account: '8088', amount: 174 }, { pay_account: '4145', amount: 2427 }, { pay_account: '8088', amount: 485 }]),
    [['4145', 2427], ['8088', 659]]);
});
test('標題：調價費支出 ＋ emoji', () => {
  assert.ok(PRICING_TITLE.endsWith('調價費支出'));
});
test('ymOfCheckin／orderIdOfKey', () => {
  assert.equal(ymOfCheckin('2026-09-24'), '202609');
  assert.equal(ymOfCheckin(null), '');
  assert.equal(orderIdOfKey('pricing:order:abc'), 'abc');
  assert.equal(orderIdOfKey('pricing:est:202609'), null);
  assert.equal(orderIdOfKey(null), null);
});
test('recentYms：跨年', () => {
  assert.deepEqual(recentYms('202610'), ['202610', '202609', '202608']);
  assert.deepEqual(recentYms('202601'), ['202601', '202512', '202511']);
});
test('pickMonth：只勾那個月、而且跳過已產生的', () => {
  const rows = [
    { id: 'a', checkin: '2026-09-01' }, { id: 'b', checkin: '2026-09-20' },
    { id: 'c', checkin: '2026-08-26' }, { id: 'd', checkin: null },
  ];
  assert.deepEqual([...pickMonth(rows, '202609', new Set(['b']))], ['a']);
  assert.deepEqual([...pickMonth(rows, 'all', new Set(['b']))].sort(), ['a', 'c', 'd']);
  assert.equal(rowsOfMonth(rows, '202608').length, 1);
});
