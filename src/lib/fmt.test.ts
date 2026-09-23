import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fmtInt, fmtIntOrBlank } from './fmt.ts';

/* 被取代掉的那幾種舊寫法 —— 新的一定要印出一模一樣的東西 */
const OLD_A = (n: number | null | undefined) => Math.round(Number(n) || 0).toLocaleString('en-US');
const OLD_A2 = (n: number | null) => (n == null ? '0' : Math.round(n).toLocaleString());
const OLD_A3 = (n: number) => Math.round(n).toLocaleString();
const OLD_B = (n: number | null | undefined) => (n == null ? '' : Math.round(n).toLocaleString());

const NUMS = [0, 1, 999, 1000, 1234.4, 1234.5, 1234.6, 12345678, -5, -1234.5, 0.4, 0.5, 156797];

describe('fmtInt —— 空值印 0', () => {
  for (const n of NUMS) {
    test(`跟舊寫法一樣：${n}`, () => {
      assert.equal(fmtInt(n), OLD_A(n));
      assert.equal(fmtInt(n), OLD_A2(n));
      assert.equal(fmtInt(n), OLD_A3(n));
    });
  }
  test('null／undefined → 0', () => {
    assert.equal(fmtInt(null), '0'); assert.equal(fmtInt(undefined), '0');
    assert.equal(fmtInt(null), OLD_A(null)); assert.equal(fmtInt(null), OLD_A2(null));
  });
  test('NaN 與空字串 → 0（不印 "NaN"）', () => {
    assert.equal(fmtInt(NaN), '0'); assert.equal(fmtInt(''), '0');
  });
  test('字串數字也吃（資料庫的 numeric 常常是字串回來）', () => {
    assert.equal(fmtInt('1234.6'), '1,235');
  });
  test('四捨五入到整數：1234.5 → 1,235', () => assert.equal(fmtInt(1234.5), '1,235'));
  test('負數', () => assert.equal(fmtInt(-1234.5), OLD_A(-1234.5)));
});

describe('fmtIntOrBlank —— 空值留白', () => {
  for (const n of NUMS) {
    test(`跟舊寫法一樣：${n}`, () => assert.equal(fmtIntOrBlank(n), OLD_B(n)));
  }
  test('null／undefined／空字串 → 空白', () => {
    assert.equal(fmtIntOrBlank(null), ''); assert.equal(fmtIntOrBlank(undefined), '');
    assert.equal(fmtIntOrBlank(''), '');
    assert.equal(fmtIntOrBlank(null), OLD_B(null));
  });
  test('★ 0 不是空值 —— 要印 0', () => assert.equal(fmtIntOrBlank(0), '0'));
});
