import test from 'node:test';
import assert from 'node:assert/strict';
import {
  digitsOnly, formatAmount, parseAmount, toInput, caretAfterFormat,
} from './money-input.ts';

test('加千分位', () => {
  assert.equal(formatAmount('196000'), '196,000');
  assert.equal(formatAmount('1000'), '1,000');
  assert.equal(formatAmount('999'), '999');
  assert.equal(formatAmount('1234567'), '1,234,567');
});

test('★ 小數不加逗號,但要留著', () => {
  // Airbnb 的金額帶到分（95,231.63）。把小數吃掉會讓對帳永遠差幾毛
  assert.equal(formatAmount('95231.63'), '95,231.63');
  assert.equal(formatAmount('0.5'), '0.5');
});

test('★ 打到一半的「1234.」不能被吃掉那個點', () => {
  // 吃掉的話使用者永遠打不出小數 —— 每按一次點就消失一次
  assert.equal(formatAmount('1234.'), '1,234.');
});

test('已經有逗號的字串重新格式化不會壞', () => {
  assert.equal(formatAmount('196,000'), '196,000');
  assert.equal(formatAmount('1,9,6,0,0,0'), '196,000');
});

test('★ 第二個小數點丟掉', () => {
  // 「1.2.3」是打錯了,不是新的數字系統
  assert.equal(formatAmount('1.2.3'), '1.23');
});

test('非數字一律濾掉', () => {
  assert.equal(digitsOnly('$1,2a3'), '123');
  assert.equal(formatAmount('abc'), '');
  assert.equal(formatAmount(''), '');
});

test('★ 不接受負數', () => {
  // 訂單金額沒有負的。允許的話「-」會被當成合法輸入,
  // 而 -196000 在報表上會把整個月的營收拉下來
  assert.equal(formatAmount('-196000'), '196,000');
  assert.equal(parseAmount('-500'), 500);
});

test('轉回數字', () => {
  assert.equal(parseAmount('196,000'), 196000);
  assert.equal(parseAmount('95,231.63'), 95231.63);
  assert.equal(parseAmount(''), 0);
  assert.equal(parseAmount('.'), 0);
});

test('數字轉顯示字串,0 顯示空白', () => {
  assert.equal(toInput(196000), '196,000');
  assert.equal(toInput(0), '');
  assert.equal(toInput(null), '');
});

/* ── 游標 ────────────────────────────────────── */

test('★ 在尾巴打字,游標留在尾巴', () => {
  // 打「196000」的第六個字時字串會變成「196,000」——
  // 不處理的話游標會被丟到別的地方,下一個字就打錯位置
  assert.equal(caretAfterFormat('196000', 6, '196,000'), 7);
});

test('★ 改中間那一位,游標不會跳到最後', () => {
  // 這是不處理游標時最明顯的症狀:想改中間,每打一個字就跳到尾巴
  //   「1,234」游標在 3 後面（字元位置 3）→ 前面有 2 個數字
  //   格式化成「1,234」→ 第 2 個數字之後是位置 3
  assert.equal(caretAfterFormat('1234', 2, '1,234'), 3);
});

test('游標在開頭就留在開頭', () => {
  assert.equal(caretAfterFormat('1234', 0, '1,234'), 0);
});

test('刪到剩空字串不會爆掉', () => {
  assert.equal(caretAfterFormat('', 0, ''), 0);
});
