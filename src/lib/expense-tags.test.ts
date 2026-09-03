import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { TAG_NON_CASH, TAG_NON_CASH_PG, isNonCash } from './expense-tags.ts';

describe('expense-tags —— 標籤只有一個出處（2026-09-03）', () => {
  test('標籤是「非實支」', () => {
    assert.equal(TAG_NON_CASH, '非實支');
  });

  /*
   * ★★★ PostgREST 的 `cs` 要 `{非實支}` 這個格式。
   *   自己在呼叫端拼字串的話，改名時那裡不會跟著改 ——
   *   而症狀是「開關打開之後那幾十筆還在」，沒有任何錯誤。
   */
  test('PostgREST 格式是大括號包起來', () => {
    assert.equal(TAG_NON_CASH_PG, '{非實支}');
    assert.equal(TAG_NON_CASH_PG, `{${TAG_NON_CASH}}`, '兩者必須同步');
  });

  test('認得出有標的', () => {
    assert.equal(isNonCash(['非實支']), true);
    assert.equal(isNonCash(['非營運', '非實支']), true);
  });

  test('沒標的、空的、null 都是 false', () => {
    assert.equal(isNonCash(['非營運']), false);
    assert.equal(isNonCash([]), false);
    assert.equal(isNonCash(null), false);
    assert.equal(isNonCash(undefined), false);
  });

  // ★ 舊標籤不該再被認得 —— 認得的話等於兩種標籤並存，而沒有人知道
  test('舊的「房務」標籤不算非實支', () => {
    assert.equal(isNonCash(['房務']), false);
  });
});
