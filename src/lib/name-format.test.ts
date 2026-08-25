import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  titleCaseName, nameKey, firstNameToken, needsNormalize, roomNameDiff,
} from './name-format.ts';

describe('titleCaseName', () => {
  test('★★ 使用者截圖裡那四筆', () => {
    assert.equal(titleCaseName('LILIAN'), 'Lilian');
    assert.equal(titleCaseName('Lilian'), 'Lilian');
    assert.equal(titleCaseName('Lilian Hong'), 'Lilian Hong');
    assert.equal(titleCaseName('LILIAN WA'), 'Lilian Wa');
  });

  test('★★ 中文原樣保留 —— 「鎖英文輸入」不能照字面做', () => {
    // 真的鎖成只能打英文的話,洪國竣、時兆物業這些名字就存不進去
    assert.equal(titleCaseName('洪國竣'), '洪國竣');
    assert.equal(titleCaseName('時兆物業'), '時兆物業');
  });

  test('中英混合', () => {
    assert.equal(titleCaseName('王 lilian'), '王 Lilian');
    assert.equal(titleCaseName('王lilian'), '王Lilian');
  });

  test("★ O'Brien 與 Anne-Marie —— 分隔不只有空白", () => {
    assert.equal(titleCaseName("o'brien"), "O'Brien");
    assert.equal(titleCaseName('anne-marie'), 'Anne-Marie');
    assert.equal(titleCaseName('j.r. smith'), 'J.R. Smith');
  });

  test('★ 空白收乾淨 —— 全形空白也算', () => {
    assert.equal(titleCaseName('  lilian   wa  '), 'Lilian Wa');
    assert.equal(titleCaseName('王　大明'), '王 大明');
  });

  test('空值', () => {
    assert.equal(titleCaseName(null), '');
    assert.equal(titleCaseName(undefined), '');
    assert.equal(titleCaseName('   '), '');
  });

  test('★ 冪等 —— 存過一次再存一次結果要一樣', () => {
    for (const s of ['LILIAN WA', "o'brien", '王 lilian', '洪國竣']) {
      assert.equal(titleCaseName(titleCaseName(s)), titleCaseName(s), s);
    }
  });

  test('數字與符號不動', () => {
    assert.equal(titleCaseName('B8'), 'B8');
    assert.equal(titleCaseName('南京5'), '南京5');
  });
});

describe('nameKey', () => {
  test('★★ 大小寫與空白不同 → 同一個 key', () => {
    assert.equal(nameKey('LILIAN WA'), nameKey('Lilian Wa'));
    assert.equal(nameKey('LILIAN WA'), nameKey('lilianwa'));
  });

  test('不同的人 → 不同的 key', () => {
    assert.notEqual(nameKey('Lilian'), nameKey('Lilian Hong'));
  });

  test('標點不影響', () => {
    assert.equal(nameKey("O'Brien"), nameKey('OBrien'));
  });
});

describe('firstNameToken', () => {
  test('★★ Lilian / Lilian Hong / LILIAN WA 第一個詞相同', () => {
    const a = firstNameToken('Lilian');
    assert.equal(firstNameToken('Lilian Hong'), a);
    assert.equal(firstNameToken('LILIAN WA'), a);
  });

  test('中文名也給得出 token', () => {
    assert.equal(firstNameToken('洪國竣'), '洪國竣');
  });

  test('★ 空字串表示判斷不了 —— 呼叫端要當「不比對」', () => {
    assert.equal(firstNameToken(''), '');
    assert.equal(firstNameToken(null), '');
    assert.equal(firstNameToken('   '), '');
    // 純標點也算判斷不了,不能讓它們自成一組
    assert.equal(firstNameToken('---'), '');
  });
});

describe('needsNormalize', () => {
  test('★ 已經是正規形式 → 不用回寫', () => {
    // 全部無條件回寫的話,四千多筆的 updated_at 會全變今天,
    // 「最近改過什麼」這個問題就永遠答不出來
    assert.equal(needsNormalize('Lilian Wa'), false);
    assert.equal(needsNormalize('洪國竣'), false);
  });

  test('要回寫的', () => {
    assert.equal(needsNormalize('LILIAN WA'), true);
    assert.equal(needsNormalize(' Lilian '), true);
  });

  test('null 不用回寫 —— 沒填就是沒填,不要變成空字串', () => {
    assert.equal(needsNormalize(null), false);
    assert.equal(needsNormalize(undefined), false);
  });
});

describe('roomNameDiff', () => {
  test('★★ 只差空白 —— B8 那一筆最可能是這個', () => {
    assert.equal(roomNameDiff('B8 ', 'B8'), '空白');
    assert.equal(roomNameDiff('B 8', 'B8'), '空白');
  });

  test('★ 只差大小寫', () => {
    assert.equal(roomNameDiff('b8', 'B8'), '大小寫');
  });

  test('兩者都差', () => {
    assert.equal(roomNameDiff(' b8 ', 'B8'), '空白與大小寫');
  });

  test('★ 真的不同 → null,不要亂講', () => {
    assert.equal(roomNameDiff('B8', 'B6'), null);
    assert.equal(roomNameDiff('南京5', 'B8'), null);
  });

  test('完全相同 → null（沒有差異可講）', () => {
    assert.equal(roomNameDiff('B8', 'B8'), null);
  });
});
