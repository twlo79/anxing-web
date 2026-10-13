import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  earnedTo, livedText, termTotals, depositAvailable, refundOf, termPicks, termError, settlePath,
} from './contract-terminate.ts';

const ZYA = { start_date: '2026-02-01', end_date: '2029-01-31', monthly_rent: 110250 };

test('earnedTo：周羽艾住到 5/31 ＝ 4 個月 441,000（跟資料庫 contract_earned_to 一樣）', () => {
  assert.equal(earnedTo(ZYA, '2026-05-31'), 441000);
  assert.equal(earnedTo(ZYA, '2026-02-28'), 110250);
  assert.equal(earnedTo(ZYA, '2026-01-31'), 0);
});

test('earnedTo：月中起租、月中終止照天數', () => {
  // 31000／月，1/1 ～ 5/15：4 個月 ＋ 5 月 15/31
  assert.equal(earnedTo({ start_date: '2026-01-01', monthly_rent: 31000 }, '2026-05-15'), 139000);
  // 1/16 起租 ～ 2/15：1 月 16/31 ＋ 2 月 15/28
  assert.equal(earnedTo({ start_date: '2026-01-16', monthly_rent: 31000 }, '2026-02-15'),
    Math.round(31000 * 16 / 31 + 31000 * 15 / 28));
  assert.equal(earnedTo({ start_date: null, monthly_rent: 1 }, '2026-01-01'), 0);
});

test('livedText', () => {
  assert.equal(livedText('2026-02-01', '2026-05-31'), '4 個月');
  assert.equal(livedText('2026-02-01', '2026-05-15'), '3 個月又 15 天');
  assert.equal(livedText('2026-02-01', '2026-01-01'), '');
});

test('termTotals：預收沒住的不會是負的（欠租時是 0）', () => {
  assert.deepEqual(termTotals(1323000, 441000, 210000),
    { rentPaid: 1323000, earned: 441000, prepaid: 882000, deposit: 210000, total: 1092000 });
  assert.equal(termTotals(62000, 139000, 0).prepaid, 0);
});

test('depositAvailable：沒收到／已退／已沒收都是 0，扣掉加費', () => {
  assert.equal(depositAvailable({ received_on: '2025-11-07', amount: 210000 }), 210000);
  assert.equal(depositAvailable({ received_on: '2025-11-07', amount: 210000, received_amount: 200000 }, 5000), 195000);
  assert.equal(depositAvailable({ received_on: null, amount: 210000 }), 0);
  assert.equal(depositAvailable({ received_on: '2025-11-07', amount: 210000, returned_on: '2026-06-01' }), 0);
  assert.equal(depositAvailable({ received_on: '2025-11-07', amount: 210000, forfeited_on: '2026-06-01' }), 0);
  assert.equal(depositAvailable(null), 0);
});

test('refundOf／termPicks', () => {
  const t = termTotals(1323000, 441000, 210000);
  assert.deepEqual(refundOf(t, { rentForfeit: 282000, depForfeit: 0 }), { rent: 600000, dep: 210000, total: 810000 });
  assert.deepEqual(termPicks(t).map((p) => p.label), ['全部沒收', '只沒收押金', '只沒收租金', '全退']);
  assert.deepEqual(termPicks(termTotals(0, 0, 0)), []);
  assert.deepEqual(termPicks(termTotals(0, 0, 5000)).map((p) => p.label), ['全部沒收', '全退']);
});

test('termError', () => {
  const t = termTotals(1323000, 441000, 210000);
  const ok = { rentForfeit: 282000, depForfeit: 0 };
  assert.equal(termError(ZYA, '', t, ok), '填終止日');
  assert.match(termError(ZYA, '2026-01-01', t, ok) ?? '', /不能早於起租日/);
  assert.match(termError(ZYA, '2029-02-01', t, ok) ?? '', /不能晚於原本的迄日/);
  assert.match(termError(ZYA, '2026-05-31', t, { rentForfeit: 900000, depForfeit: 0 }) ?? '', /預收租金最多沒收 \$882,000/);
  assert.match(termError(ZYA, '2026-05-31', t, { rentForfeit: 0, depForfeit: 210001 }) ?? '', /押金最多沒收/);
  assert.equal(termError(ZYA, '2026-05-31', t, ok, { name: '', account: '' }), '要退還的話，房客戶名與收款帳號要填');
  assert.equal(termError(ZYA, '2026-05-31', t, { rentForfeit: 882000, depForfeit: 210000 }, { name: '', account: '' }), null);
  assert.equal(termError(ZYA, '2026-05-31', t, ok, { name: '周羽艾', account: '123' }), null);
});

test('settlePath 跟取消訂單同一條', () => {
  assert.equal(settlePath(0), 'close');
  assert.equal(settlePath(2999), 'direct');
  assert.equal(settlePath(3000), 'review');
});
