import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { periodSplit } from './period-split.ts';

describe('periodSplit', () => {
  it('月繳：就是每期金額', () => {
    assert.deepEqual(periodSplit(30000, 1), { base: 30000, last: 30000, remainder: 0 });
  });
  it('整除：最後一個月跟其他月一樣', () => {
    assert.deepEqual(periodSplit(834000, 6), { base: 139000, last: 139000, remainder: 0 });
  });
  it('年繳少 4 的那種（8A5）：最後一個月補回來', () => {
    const r = periodSplit(1867576, 12);
    assert.deepEqual(r, { base: 155631, last: 155635, remainder: 4 });
    assert.equal(r.base * 11 + r.last, 1867576);
  });
  it('年繳多 4 的那種（8A3）：最後一個月扣回來', () => {
    const r = periodSplit(2001272, 12);
    assert.deepEqual(r, { base: 166773, last: 166769, remainder: -4 });
    assert.equal(r.base * 11 + r.last, 2001272);
  });
  it('9A3 差 3', () => {
    const r = periodSplit(1501605, 12);
    assert.equal(r.base * 11 + r.last, 1501605);
    assert.equal(r.remainder, -3);
  });
  it('每一期加起來一定等於每期金額（掃 1..12 個月、各種金額）', () => {
    for (const step of [1, 3, 6, 12]) for (let per = 0; per < 5000; per += 7) {
      const r = periodSplit(per, step);
      assert.equal(r.base * (step - 1) + r.last, per, `per=${per} step=${step}`);
    }
  });
  it('餘數絕對值不會超過 step−1 的一半多一點', () => {
    for (let per = 100000; per < 100200; per++) {
      const r = periodSplit(per, 12);
      assert.ok(Math.abs(r.remainder) <= 6, `per=${per} rem=${r.remainder}`);
    }
  });
  it('壞輸入：step 0／負／NaN 當 1；per NaN 當 0', () => {
    assert.deepEqual(periodSplit(100, 0), { base: 100, last: 100, remainder: 0 });
    assert.deepEqual(periodSplit(100, -3), { base: 100, last: 100, remainder: 0 });
    assert.deepEqual(periodSplit(Number.NaN, 12), { base: 0, last: 0, remainder: 0 });
  });
});

import { periodAmounts } from './period-split.ts';
describe('periodAmounts', () => {
  it('整期：前 11 個月 base、第 12 個月吸收餘數，加總 = 每期', () => {
    const a = periodAmounts(1867576, 12, 12);
    assert.equal(a.length, 12);
    assert.deepEqual(a.slice(0, 11), Array(11).fill(155631));
    assert.equal(a[11], 155635);
    assert.equal(a.reduce((x, y) => x + y, 0), 1867576);
  });
  it('不足整期（季繳最後一期只有 2 個月）：全部 base，沒有餘數月', () => {
    assert.deepEqual(periodAmounts(90000, 3, 2), [30000, 30000]);
    assert.deepEqual(periodAmounts(100001, 3, 2), [33334, 33334]);
  });
  it('月繳：一個月就是每期', () => {
    assert.deepEqual(periodAmounts(30000, 1, 1), [30000]);
  });
  it('壞輸入：months 0／負／NaN → 空陣列', () => {
    assert.deepEqual(periodAmounts(1000, 12, 0), []);
    assert.deepEqual(periodAmounts(1000, 12, -2), []);
    assert.deepEqual(periodAmounts(1000, 12, Number.NaN), []);
  });
});
