import test from 'node:test';
import assert from 'node:assert/strict';
import {
  depLines, twdOf, fxOf, lineText, primaryText, extraLines,
  summaryText, isMultiCurrency, sumByCurrency,
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
