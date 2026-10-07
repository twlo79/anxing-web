import { test } from 'node:test';
import assert from 'node:assert/strict';
import { byHolder, shTotals, runningOwed, lastPeer, shMissing, accountFieldLabel, type ShTxn } from './shareholder.ts';

const T = (id: string, d: string, who: string, dir: 'in' | 'out', amt: number, peer?: string): ShTxn => ({
  id, txn_date: d, shareholder: who, direction: dir, amount: amt, method: 'transfer',
  account_code: '8088', peer_bank_code: peer ? '812' : null, peer_account: peer ?? null, summary: null });
const rows = [
  T('a', '2026-06-01', 'David', 'in', 520000),
  T('b', '2026-07-15', 'Ken', 'in', 150000),
  T('c', '2025-12-01', 'Ken', 'out', 0 + 150000),
  T('d', '2026-09-10', 'David', 'in', 500000, '111'),
  T('e', '2026-10-05', 'David', 'out', 200000),
  T('f', '2026-08-01', 'Amy', 'in', 350000),
];

test('依股東：欠最多的在前；已還清的是 0', () => {
  const h = byHolder(rows);
  assert.deepEqual(h.map((x) => [x.name, x.owed]), [['David', 820000], ['Amy', 350000], ['Ken', 0]]);
});
test('三張卡：借入、已還（本年）、尚欠、有欠款的股東數', () => {
  const t = shTotals(rows, '2026');
  assert.equal(t.inSum, 1520000);
  assert.equal(t.outSum, 350000);
  assert.equal(t.outYear, 200000);
  assert.equal(t.owed, 1170000);
  assert.equal(t.owingHolders, 2);
});
test('每列餘額：照日期累加、各股東分開算', () => {
  const r = runningOwed(rows);
  assert.equal(r.get('a'), 520000);
  assert.equal(r.get('d'), 1020000);
  assert.equal(r.get('e'), 820000);
  assert.equal(r.get('c'), -150000);   // Ken 先被還（資料順序上），餘額先變負
  assert.equal(r.get('b'), 0);
});
test('上次的帳號自動帶入', () => {
  assert.deepEqual(lastPeer(rows, 'David'), { bank: '812', account: '111' });
  assert.equal(lastPeer(rows, 'Amy'), null);
});
test('必填與欄名', () => {
  assert.deepEqual(shMissing({ direction: 'in', txn_date: '2026-10-07', shareholder: 'D', amount: 1 }), []);
  assert.deepEqual(shMissing({}), ['收支', '日期', '股東', '金額']);
  assert.equal(accountFieldLabel('in', 'transfer'), '安幸收款帳號');
  assert.equal(accountFieldLabel('out', 'cash'), '現金從哪裡出');
});
