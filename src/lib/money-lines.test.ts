import test from 'node:test';
import assert from 'node:assert/strict';
import {
  toLines, fromLines, totalTwd, validateLines, blankLine, isTwd, fxTwd, TWD,
  type Line,
} from './money-lines.ts';

// ── 讀出來（資料庫 → 畫面）─────────────────────────

test('toLines:只有台幣的舊訂單', () => {
  assert.deepEqual(toLines(10000, [], 'revenue'), [{ cur: TWD, amt: 10000, rate: 1 }]);
});

test('toLines:台幣欄位永遠存在,即使是 0', () => {
  // 沒有這一列的話使用者要先按「新增幣別」才填得了台幣 —— 最常用的反而最難填
  assert.deepEqual(toLines(0, [], 'revenue'), [{ cur: TWD, amt: 0, rate: 1 }]);
  assert.deepEqual(toLines(null, null, 'deposit'), [{ cur: TWD, amt: 0, rate: 1 }]);
});

test('toLines:amount 是總額,要扣掉外幣換算後才是台幣本體', () => {
  // amount 13000 = 台幣 10000 + USD 100 × 30
  assert.deepEqual(toLines(13000, [{ cur: 'USD', amt: 100, rate: 30 }], 'revenue'), [
    { cur: TWD, amt: 10000, rate: 1 },
    { cur: 'USD', amt: 100, rate: 30 },
  ]);
});

test('toLines:全部都是外幣時台幣列是 0', () => {
  assert.deepEqual(toLines(3000, [{ cur: 'USD', amt: 100, rate: 30 }], 'revenue'), [
    { cur: TWD, amt: 0, rate: 1 },
    { cur: 'USD', amt: 100, rate: 30 },
  ]);
});

test('toLines:舊資料有換算誤差算出負數時夾在 0', () => {
  // 不夾的話畫面會出現「台幣 -500」,使用者完全不知道那是什麼
  assert.deepEqual(toLines(2500, [{ cur: 'USD', amt: 100, rate: 30 }], 'revenue')[0],
    { cur: TWD, amt: 0, rate: 1 });
});

test('toLines:押金不換匯,deposit 本來就只有台幣,不用扣', () => {
  assert.deepEqual(toLines(5000, [{ cur: 'JPY', amt: 10000 }], 'deposit'), [
    { cur: TWD, amt: 5000, rate: 1 },
    { cur: 'JPY', amt: 10000, rate: 1 },
  ]);
});

test('toLines:跳過沒有幣別的空列', () => {
  const r = toLines(5000, [{ cur: '', amt: 100 }] as never, 'deposit');
  assert.equal(r.length, 1);
});

// ── 存回去（畫面 → 資料庫）─────────────────────────

const L = (cur: string, amt: number, rate = 1): Line => ({ cur, amt, rate });

test('fromLines:台幣不會被寫進 fx —— 儲存格式跟改版前一致', () => {
  const r = fromLines([L(TWD, 10000), L('USD', 100, 30)], 'revenue');
  assert.equal(r.twd, 13000);                       // amount = 總額
  assert.deepEqual(r.fx, [{ cur: 'USD', amt: 100, rate: 30 }]);  // 只有非台幣
});

test('fromLines:押金存純台幣,fx 不帶匯率', () => {
  const r = fromLines([L(TWD, 5000), L('JPY', 10000)], 'deposit');
  assert.equal(r.twd, 5000);
  assert.deepEqual(r.fx, [{ cur: 'JPY', amt: 10000 }]);
});

test('fromLines:使用者自己多加一列 TWD 會被加總,不是只取其中一列', () => {
  // 不加總的話另一列會無聲消失
  const r = fromLines([L(TWD, 3000), L(TWD, 2000)], 'deposit');
  assert.equal(r.twd, 5000);
  assert.deepEqual(r.fx, []);
});

test('fromLines:0 元與空幣別的列會被濾掉', () => {
  const r = fromLines([L(TWD, 10000), L('USD', 0, 30), L('', 500)], 'revenue');
  assert.equal(r.twd, 10000);
  assert.deepEqual(r.fx, []);
});

test('fromLines:全空 → 0,不會變成 NaN', () => {
  const r = fromLines([L(TWD, 0)], 'revenue');
  assert.equal(r.twd, 0);
  assert.deepEqual(r.fx, []);
});

test('往返一致:讀出來再存回去,數字不變', () => {
  for (const [amount, fx] of [
    [13000, [{ cur: 'USD', amt: 100, rate: 30 }]],
    [10000, []],
    [3000, [{ cur: 'USD', amt: 100, rate: 30 }]],
  ] as [number, { cur: string; amt: number; rate: number }[]][]) {
    const back = fromLines(toLines(amount, fx, 'revenue'), 'revenue');
    assert.equal(back.twd, amount, `amount ${amount} 往返後變了`);
    assert.deepEqual(back.fx, fx);
  }
});

test('往返一致:押金', () => {
  const back = fromLines(toLines(5000, [{ cur: 'JPY', amt: 10000 }], 'deposit'), 'deposit');
  assert.equal(back.twd, 5000);
  assert.deepEqual(back.fx, [{ cur: 'JPY', amt: 10000 }]);
});

// ── 其他 ───────────────────────────────────────────

test('totalTwd', () => {
  assert.equal(totalTwd([L(TWD, 10000), L('USD', 100, 30)]), 13000);
  assert.equal(totalTwd([]), 0);
});

test('validateLines:有金額沒匯率要擋 —— 否則那筆外幣營收會算成 0 元溜進報表', () => {
  assert.equal(validateLines([L('USD', 100, 0)], 'revenue'), 'USD 有金額但沒有匯率');
});

test('validateLines:台幣不需要匯率', () => {
  assert.equal(validateLines([L(TWD, 10000, 1)], 'revenue'), null);
});

test('validateLines:押金不換匯,沒有匯率也過', () => {
  assert.equal(validateLines([L('JPY', 10000, 0)], 'deposit'), null);
});

test('validateLines:金額是 0 的列不檢查 —— 那是還沒填完的空列', () => {
  assert.equal(validateLines([L('USD', 0, 0)], 'revenue'), null);
});

test('validateLines:有金額但沒幣別', () => {
  assert.equal(validateLines([L('', 500, 1)], 'revenue'), '幣別沒有填');
});

test('blankLine:還沒有台幣就先給台幣,有了就留空讓使用者自己打', () => {
  assert.equal(blankLine([]).cur, TWD);
  assert.equal(blankLine([L(TWD, 100)]).cur, '');
});

test('isTwd:大小寫與空白都要認得', () => {
  assert.equal(isTwd('twd'), true);
  assert.equal(isTwd(' TWD '), true);
  assert.equal(isTwd('USD'), false);
});

test('fxTwd:押金那種沒有 rate 的當 1', () => {
  assert.equal(fxTwd([{ cur: 'JPY', amt: 10000 }]), 10000);
  assert.equal(fxTwd([{ cur: 'USD', amt: 100, rate: 30 }]), 3000);
});
