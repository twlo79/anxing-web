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

import { ymAdd, missingYms, defaultEntryYm, entryMissing } from './recurring-years.ts';
test('ymAdd 跨年', () => {
  assert.equal(ymAdd('202612', 1), '202701');
  assert.equal(ymAdd('202601', -1), '202512');
});
test('缺：最後一筆之後到上個月；新項目不算缺；這個月不算', () => {
  assert.deepEqual(missingYms(['202607', '202608'], '202610'), ['202609']);
  assert.deepEqual(missingYms(['202609'], '202610'), []);
  assert.deepEqual(missingYms([], '202610'), []);
  assert.deepEqual(missingYms(['202610'], '202610'), []);
});
test('記一筆的預設月份', () => {
  assert.equal(defaultEntryYm(['202607', '202608'], '202610'), '202609');
  assert.equal(defaultEntryYm(['202609'], '202610'), '202610');
  assert.equal(defaultEntryYm([], '202610'), '202609');
});
test('記一筆必填：金額要 > 0', () => {
  assert.deepEqual(entryMissing({ estate_id: 'x', item: '烘衣機', ym: '202609', amount: 2600 }), []);
  assert.deepEqual(entryMissing({ estate_id: '', item: ' ', ym: '2026', amount: 0 }), ['物業', '項目', '月份', '收入金額']);
});
