import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { TAG_NON_CASH, TAG_NON_CASH_PG, isNonCash, withNonCash } from './expense-tags.ts';

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

describe('withNonCash —— 勾選框存回去（2026-09-03）', () => {
  test('勾起來就加上', () => {
    assert.deepEqual(withNonCash(null, true), ['非實支']);
    assert.deepEqual(withNonCash([], true), ['非實支']);
  });

  /*
   * ★★★ 沒有標籤時是 `[]` 不是 null。
   *   `expenses.tags` 是 `not null default '{}'` —— 寫 null 進去
   *   **每一次存檔都會失敗**，而且是整個支出頁一起壞
   *   （2026-09-03 踩過，使用者只是想改一個用途就撞上）。
   */
  test('★★★ 取消就拿掉，而且是空陣列不是 null', () => {
    assert.deepEqual(withNonCash(['非實支'], false), []);
    assert.notEqual(withNonCash(['非實支'], false), null, 'tags 欄位是 not null');
  });

  /*
   * ★★★ 其他標籤要留著。直接寫 ['非實支'] 的話，之後多了第二種標籤，
   *   使用者一存檔就把它洗掉 —— 而畫面上只是少一顆 chip，沒有錯誤。
   */
  test('★★★ 不會洗掉別的標籤', () => {
    assert.deepEqual(withNonCash(['其他標籤'], true), ['其他標籤', '非實支']);
    assert.deepEqual(withNonCash(['其他標籤', '非實支'], false), ['其他標籤']);
  });

  test('重複勾不會變兩個', () => {
    assert.deepEqual(withNonCash(['非實支'], true), ['非實支']);
  });

  // ★ 每一種輸入都要回陣列 —— 回 null 的那一刻整頁就壞了
  test('★ 任何輸入都回陣列', () => {
    for (const [t, on] of [[null, false], [undefined, false], [[], false],
                           [['非實支'], false], [null, true]] as const) {
      assert.ok(Array.isArray(withNonCash(t as any, on)), `${t} / ${on} 要回陣列`);
    }
  });

  test('存回去的結果 isNonCash 讀得出來', () => {
    assert.equal(isNonCash(withNonCash(null, true)), true);
    assert.equal(isNonCash(withNonCash(['非實支'], false)), false);
  });
});
