import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  depLines, twdOf, fxOf, lineText, primaryText, extraLines,
  summaryText, isMultiCurrency, sumByCurrency,
  itemOf, hasDetail, lineKey,
} from './deposit-lines.ts';

const D = (lines: { cur: string; amt: number }[] | null, currency = 'TWD', amount = 0) =>
  ({ lines, currency, amount });

test('depLines:讀出明細', () => {
  assert.deepEqual(
    depLines(D([{ cur: 'TWD', amt: 160000 }, { cur: 'JPY', amt: 10000 }])),
    [{ cur: 'TWD', amt: 160000 }, { cur: 'JPY', amt: 10000 }]);
});

test('depLines:舊資料沒有 lines 時,用 currency + amount 退回一筆', () => {
  // 不退回的話那些押金在畫面上會變成「沒有金額」
  assert.deepEqual(depLines(D(null, 'TWD', 5000)), [{ cur: 'TWD', amt: 5000 }]);
  assert.deepEqual(depLines(D([], 'JPY', 10000)), [{ cur: 'JPY', amt: 10000 }]);
});

test('depLines:完全沒有金額時回空陣列,不是 [{amt:0}]', () => {
  assert.deepEqual(depLines(D([], 'TWD', 0)), []);
});

test('depLines:濾掉 0 元與沒有幣別的列', () => {
  assert.deepEqual(
    depLines(D([{ cur: 'TWD', amt: 5000 }, { cur: 'JPY', amt: 0 }, { cur: '', amt: 100 }])),
    [{ cur: 'TWD', amt: 5000 }]);
});

test('depLines:幣別一律轉大寫 —— 報表按字串分組,大小寫混用會裂開', () => {
  assert.deepEqual(depLines(D([{ cur: 'jpy', amt: 100 }])), [{ cur: 'JPY', amt: 100 }]);
});

test('twdOf / fxOf', () => {
  const d = D([{ cur: 'TWD', amt: 160000 }, { cur: 'JPY', amt: 10000 }, { cur: 'USD', amt: 300 }]);
  assert.equal(twdOf(d), 160000);
  assert.deepEqual(fxOf(d), [{ cur: 'JPY', amt: 10000 }, { cur: 'USD', amt: 300 }]);
});

test('twdOf:沒有台幣時是 0', () => {
  assert.equal(twdOf(D([{ cur: 'JPY', amt: 10000 }])), 0);
});

test('lineText:台幣加 NT$,外幣顯示代碼', () => {
  assert.equal(lineText({ cur: 'TWD', amt: 160000 }), 'NT$ 160,000');
  assert.equal(lineText({ cur: 'JPY', amt: 10000 }), 'JPY 10,000');
});

test('primaryText:有台幣就顯示台幣', () => {
  assert.equal(primaryText(D([{ cur: 'JPY', amt: 10000 }, { cur: 'TWD', amt: 160000 }])), 'NT$ 160,000');
});

test('primaryText:完全沒有台幣時顯示第一個外幣,不能是 NT$ 0', () => {
  // 顯示 NT$ 0 會看起來像沒收押金
  assert.equal(primaryText(D([{ cur: 'JPY', amt: 10000 }])), 'JPY 10,000');
});

test('primaryText:沒有任何金額回破折號', () => {
  assert.equal(primaryText(D([], 'TWD', 0)), '—');
});

test('extraLines:主要金額以外的那幾列', () => {
  assert.deepEqual(
    extraLines(D([{ cur: 'TWD', amt: 160000 }, { cur: 'JPY', amt: 10000 }])),
    [{ cur: 'JPY', amt: 10000 }]);
});

test('extraLines:沒有台幣時,第一個外幣當主要,其餘才是 extra', () => {
  assert.deepEqual(
    extraLines(D([{ cur: 'JPY', amt: 10000 }, { cur: 'USD', amt: 300 }])),
    [{ cur: 'USD', amt: 300 }]);
});

test('extraLines:單一幣別沒有 extra', () => {
  assert.deepEqual(extraLines(D([{ cur: 'TWD', amt: 5000 }])), []);
});

test('summaryText', () => {
  assert.equal(
    summaryText(D([{ cur: 'TWD', amt: 160000 }, { cur: 'JPY', amt: 10000 }])),
    'NT$ 160,000＋JPY 10,000');
  assert.equal(summaryText(D([], 'TWD', 0)), '—');
});

test('isMultiCurrency', () => {
  assert.equal(isMultiCurrency(D([{ cur: 'TWD', amt: 1 }])), false);
  assert.equal(isMultiCurrency(D([{ cur: 'TWD', amt: 1 }, { cur: 'JPY', amt: 1 }])), true);
});

test('sumByCurrency:外幣一定要進統計 —— 只加 amount 會漏掉而且看不出來', () => {
  const rows = [
    D([{ cur: 'TWD', amt: 5000 }, { cur: 'JPY', amt: 10000 }]),
    D([{ cur: 'TWD', amt: 3000 }]),
    D(null, 'USD', 300),   // 舊資料
  ];
  assert.deepEqual(sumByCurrency(rows), { TWD: 8000, JPY: 10000, USD: 300 });
});

test('sumByCurrency:空清單回空物件', () => {
  assert.deepEqual(sumByCurrency([]), {});
});

/* ══════════════════════════════════════════════════════════
 * 寵物押金（migration_194）—— 同一張押金可以有兩筆 TWD
 * ══════════════════════════════════════════════════════════ */
describe('寵物押金：兩筆台幣同時存在', () => {
  const PET = {
    amount: 130000,
    lines: [
      { cur: 'TWD', amt: 100000, item: '一般押金' },
      { cur: 'TWD', amt: 30000, item: '寵物押金' },
    ],
  };
  const PET_FX = {
    amount: 130000,
    lines: [
      { cur: 'TWD', amt: 100000, item: '一般押金' },
      { cur: 'TWD', amt: 30000, item: '寵物押金' },
      { cur: 'JPY', amt: 10000, item: '一般押金' },
    ],
  };
  /** 只押寵物、不押一般 —— 短住的房客常常這樣 */
  const PET_ONLY = { amount: 30000, lines: [{ cur: 'TWD', amt: 30000, item: '寵物押金' }] };
  /** 194 之前的舊資料：lines 沒有 item */
  const OLD = { amount: 160000, lines: [{ cur: 'TWD', amt: 160000 }] };

  test('itemOf：沒有 item 當一般押金', () => {
    assert.equal(itemOf({ cur: 'TWD', amt: 1 }), '一般押金');
    assert.equal(itemOf({ cur: 'TWD', amt: 1, item: null }), '一般押金');
    assert.equal(itemOf({ cur: 'TWD', amt: 1, item: '寵物押金' }), '寵物押金');
  });

  test('twdOf 是兩筆的合計，等於 amount', () => {
    assert.equal(twdOf(PET), 130000);
    assert.equal(twdOf(PET), PET.amount);
  });

  /*
   * ★★★ 原本 extraLines 是「台幣以外的都算 extra」——
   *   寵物押金也是台幣，會被那個過濾器整筆吃掉，
   *   於是畫面上只剩 100,000，30,000 憑空消失而且不會報錯。
   */
  test('extraLines 看得到寵物押金', () => {
    const ex = extraLines(PET);
    assert.equal(ex.length, 1);
    assert.equal(ex[0].amt, 30000);
  });

  test('primaryText 是一般押金那筆', () => {
    assert.equal(primaryText(PET), 'NT$ 100,000');
  });

  test('只有寵物押金時，主要金額就是它', () => {
    assert.equal(primaryText(PET_ONLY), '寵物押金 NT$ 30,000');
    assert.deepEqual(extraLines(PET_ONLY), []);
  });

  test('lineText 只有寵物押金加前綴', () => {
    assert.equal(lineText({ cur: 'TWD', amt: 100000, item: '一般押金' }), 'NT$ 100,000');
    assert.equal(lineText({ cur: 'TWD', amt: 30000, item: '寵物押金' }), '寵物押金 NT$ 30,000');
    assert.equal(lineText({ cur: 'JPY', amt: 10000, item: '寵物押金' }), '寵物押金 JPY 10,000');
  });

  /*
   * ★★★ 兩筆 TWD 不是「多幣別」。用列數判斷的話，
   *   純台幣的訂單加了寵物押金會被說成多幣別。
   */
  test('isMultiCurrency 看幣別種類，不看列數', () => {
    assert.equal(isMultiCurrency(PET), false);
    assert.equal(isMultiCurrency(PET_FX), true);
    assert.equal(isMultiCurrency(OLD), false);
  });

  test('hasDetail 看列數 —— 有寵物押金就要展開', () => {
    assert.equal(hasDetail(PET), true);
    assert.equal(hasDetail(OLD), false);
  });

  // ★ 重複的 key 會讓 React 把兩列搞混，而且只在 console 警告
  test('lineKey 兩筆 TWD 不會撞號', () => {
    const ls = depLines(PET);
    assert.notEqual(lineKey(ls[0], 0), lineKey(ls[1], 1));
  });

  test('sumByCurrency 兩筆台幣要加總', () => {
    assert.equal(sumByCurrency([PET])['TWD'], 130000);
  });

  test('summaryText 含寵物押金', () => {
    assert.equal(summaryText(PET), 'NT$ 100,000＋寵物押金 NT$ 30,000');
  });

  // 舊資料的行為一個字都不能變
  test('194 之前的舊資料顯示不變', () => {
    assert.equal(primaryText(OLD), 'NT$ 160,000');
    assert.equal(summaryText(OLD), 'NT$ 160,000');
    assert.deepEqual(extraLines(OLD), []);
  });
});
