import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ncRowsOf, ncPick, ncTotal, ncYmOf } from './noncash.ts';

const rows = [
  { id: 'a', spent_on: '2026-09-30', amount: 300000, estate_id: 'zl' },
  { id: 'b', spent_on: '2026-09-30', amount: 1460, estate_id: 'zl' },
  { id: 'c', spent_on: '2026-09-15', amount: 980, estate_id: 'sz' },
  { id: 'd', spent_on: '2026-08-31', amount: 500, estate_id: 'zl' },
];
test('支出月', () => assert.equal(ncYmOf('2026-09-30'), '202609'));
test('篩物業＋月份；全部就是全部', () => {
  assert.deepEqual(ncRowsOf(rows, 'zl', '202609').map((r) => r.id), ['a', 'b']);
  assert.deepEqual(ncRowsOf(rows, '', '202609').map((r) => r.id), ['a', 'b', 'c']);
  assert.equal(ncRowsOf(rows, '', 'all').length, 4);
});
test('點了就全勾；合計只算勾的', () => {
  const s = ncPick(rows, 'zl', 'all');
  assert.deepEqual([...s].sort(), ['a', 'b', 'd']);
  assert.equal(ncTotal(rows, s), 301960);
});
