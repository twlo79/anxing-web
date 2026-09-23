import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { extendEnd, extendYms, restoreEnd, isGuessedRestore } from './contract-extend.ts';

describe('extendEnd —— 展延之後的迄日永遠是月底', () => {
  test('2028-10-30 展延 1 個月 → 2028-11-30', () => {
    assert.equal(extendEnd('2028-10-30', 1), '2028-11-30');
  });
  test('跨年：2026-12-01 展延 1 個月 → 2027-01-31', () => {
    assert.equal(extendEnd('2026-12-01', 1), '2027-01-31');
  });
  test('展延 12 個月', () => assert.equal(extendEnd('2026-03-15', 12), '2027-03-31'));
  test('★ 閏年二月：2027-01-31 展延 1 個月 → 2027-02-28', () => {
    assert.equal(extendEnd('2027-01-31', 1), '2027-02-28');
  });
  test('★ 閏年二月：2028-01-31 展延 1 個月 → 2028-02-29', () => {
    assert.equal(extendEnd('2028-01-31', 1), '2028-02-29');
  });
  test('n < 1 原樣回傳，不丟例外', () => {
    assert.equal(extendEnd('2028-10-30', 0), '2028-10-30');
  });
});

describe('extendYms —— 長出來的是哪幾個月', () => {
  test('2028-10-30 展延 3 個月 → 11、12、隔年 1 月', () => {
    assert.deepEqual(extendYms('2028-10-30', 3), ['202811', '202812', '202901']);
  });
  test('跨年', () => assert.deepEqual(extendYms('2026-12-01', 2), ['202701', '202702']));
});

describe('★★★ 展延 → 刪除 要回得到原本那一天', () => {
  const cases: [string, number][] = [
    ['2028-10-30', 1], ['2028-10-31', 1], ['2028-10-05', 1],
    ['2027-02-14', 1], ['2026-12-01', 1], ['2026-02-29' as string, 1],
    ['2027-06-30', 6], ['2026-01-01', 12],
  ];
  for (const [end, n] of cases) {
    test(`留底還原：${end} 展延 ${n} 個月再刪掉 → ${end}`, () => {
      const after = extendEnd(end, n);
      const startYm = extendYms(end, n)[0];
      // 展延時把原本的迄日留底，刪除時讀回來
      assert.equal(restoreEnd(startYm, end), end, `${end} 還原不回去`);
      assert.notEqual(after, end);
    });
  }

  test('★ 沒有留底時才會猜 —— 而且只有原本就是月底才猜得對', () => {
    // 月底：猜得對
    assert.equal(restoreEnd(extendYms('2028-10-31', 1)[0], null), '2028-10-31');
    // 不是月底：猜出來的比原本晚
    assert.equal(restoreEnd(extendYms('2028-10-30', 1)[0], null), '2028-10-31');
    assert.equal(restoreEnd(extendYms('2026-12-01', 1)[0], null), '2026-12-31');
  });

  test('★★ 刪後面那幾批不用留底 —— 前一批的結果本來就是月底', () => {
    const afterFirst = extendEnd('2028-10-30', 1);   // 2028-11-30，月底
    const secondYm = extendYms(afterFirst, 1)[0];    // 202812
    assert.equal(restoreEnd(secondYm, null), afterFirst);
  });
});

describe('isGuessedRestore —— 要不要在畫面上說「沒有留底」', () => {
  test('最早那批 ＋ 沒留底 → 要說', () => assert.equal(isGuessedRestore(true, null), true));
  test('最早那批 ＋ 有留底 → 不用說', () => assert.equal(isGuessedRestore(true, '2028-10-30'), false));
  test('後面那幾批 → 不用說（回推月底本來就對）', () => assert.equal(isGuessedRestore(false, null), false));
});
