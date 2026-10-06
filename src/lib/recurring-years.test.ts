import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupRcByYear, rcYearOpenByDefault } from './recurring-years.ts';

const o = (ym: string, amount: number, paid = false) => ({ id: ym, order_key: `RC_x_${ym}`, amount, paid });

test('分年：新年份在前、月份由舊到新、合計與未填', () => {
  const g = groupRcByYear([o('202602', 4800), o('202512', 5200), o('202601', 3550), o('202610', 0), o('202501', 3350)]);
  assert.deepEqual(g.map((x) => x.year), ['2026', '2025']);
  assert.deepEqual(g[0].list.map((x) => x.id), ['202601', '202602', '202610']);
  assert.equal(g[0].total, 8350);
  assert.equal(g[0].zero, 1);
  assert.equal(g[1].total, 8550);
});
test('預設展開：今年；往年有未填也展開', () => {
  assert.equal(rcYearOpenByDefault({ year: '2026', zero: 0 }, '2026'), true);
  assert.equal(rcYearOpenByDefault({ year: '2025', zero: 0 }, '2026'), false);
  assert.equal(rcYearOpenByDefault({ year: '2025', zero: 2 }, '2026'), true);
});
