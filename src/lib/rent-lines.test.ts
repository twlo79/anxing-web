import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeLines, linesSum, linesProblem, linesTitle } from './rent-lines.ts';

describe('normalizeLines', () => {
  it('不是陣列 → 空', () => {
    assert.deepEqual(normalizeLines(null), []);
    assert.deepEqual(normalizeLines('x'), []);
    assert.deepEqual(normalizeLines({ label: '房租' }), []);
  });
  it('缺欄位、髒值都收乾淨', () => {
    assert.deepEqual(normalizeLines([{ label: ' 房租 ', amount: '150000' }, { amount: 'abc' }, {}]),
      [{ label: '房租', amount: 150000 }, { label: '', amount: 0 }, { label: '', amount: 0 }]);
  });
  it('小數四捨五入成整數', () => {
    assert.deepEqual(normalizeLines([{ label: 'a', amount: 10.6 }]), [{ label: 'a', amount: 11 }]);
  });
});

describe('linesSum', () => {
  it('加總', () => assert.equal(linesSum([{ label: 'a', amount: 150000 }, { label: 'b', amount: 6797 }]), 156797));
  it('空 → 0', () => assert.equal(linesSum([]), 0));
});

describe('linesProblem', () => {
  const ok = [{ label: '房租', amount: 150000 }, { label: '設備租賃', amount: 6797 }];
  it('沒明細一律可以存（明細是選填）', () => {
    assert.equal(linesProblem([], 156797), null);
    assert.equal(linesProblem([], null), null);
    assert.equal(linesProblem([], 0), null);
  });
  it('加總等於每期租金 → 可以存', () => assert.equal(linesProblem(ok, 156797), null));
  it('加總不等 → 擋，訊息帶差額與方向', () => {
    assert.equal(linesProblem(ok, 160000), '明細合計 156,797，跟每期租金差 +3,203');
    assert.equal(linesProblem(ok, 150000), '明細合計 156,797，跟每期租金差 -6,797');
  });
  it('每期租金空著但有明細 → 差額就是整個合計（擋）', () => {
    assert.equal(linesProblem(ok, null), '明細合計 156,797，跟每期租金差 -156,797');
  });
  it('項目沒填 → 擋，而且比合計先報', () => {
    assert.equal(linesProblem([{ label: '', amount: 156797 }], 156797), '有一列明細沒填項目');
    assert.equal(linesProblem([{ label: '  ', amount: 1 }], 999), '有一列明細沒填項目');
  });
  it('負數 → 擋', () => {
    assert.equal(linesProblem([{ label: 'a', amount: -1 }, { label: 'b', amount: 2 }], 1), '明細金額不能是負的');
  });
  it('0 元的列可以（例如免收的項目要列出來）', () => {
    assert.equal(linesProblem([{ label: '房租', amount: 100 }, { label: '車位', amount: 0 }], 100), null);
  });
});

describe('linesTitle', () => {
  it('0 → ＋ 拆明細；N → 明細（N 項）', () => {
    assert.equal(linesTitle(0), '＋ 拆明細');
    assert.equal(linesTitle(2), '明細（2 項）');
  });
});
