/**
 * lib/other-book.ts 的「安幸代墊」那一組（2026-09-17）。
 *
 * ★ 這幾支決定的是**畫面上看不看得出哪幾筆是代墊**。
 *   使用者 2026-09-17 連問三次「怎麼還是三筆」「全都代墊」——
 *   每一次都是因為這一頁沒有這個籤。
 *
 * 跑法：node --experimental-strip-types --test src/lib/other-book.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isLent, lentTotal, lentSiblings, type Entry } from './other-book.ts';

const ex = (id: string, amount: number, advanceId?: string | null): Entry => ({
  id, kind: 'expense', date: '2026-09-08', name: id, account_code: null,
  party: null, amount, note: null, settled: true, advanceId: advanceId ?? null,
});
const inc = (id: string, amount: number, advanceId?: string | null): Entry => ({
  ...ex(id, amount, advanceId), kind: 'income',
});

/* ══════════════ isLent ══════════════ */

test('isLent：有 advanceId 就是代墊', () => {
  assert.equal(isLent(ex('a', 100, 'AP1')), true);
});

test('isLent：null／空字串／沒這個欄位都不是', () => {
  assert.equal(isLent(ex('a', 100, null)), false);
  assert.equal(isLent(ex('a', 100, '')), false);
  assert.equal(isLent({ ...ex('a', 100) , advanceId: undefined }), false);
  assert.equal(isLent(null), false);
  assert.equal(isLent(undefined), false);
});

/* ══════════════ lentTotal ══════════════ */

test('★★★ lentTotal：愛皮 2026-09 的真實數字', () => {
  // 三張請款單、8 筆支出（2026-09-17 線上資料）
  const rows = [
    ex('健保費', 1428, 'AP075'), ex('勞保費', 3102, 'AP075'),
    ex('旅平險', 261, 'AP086'), ex('電信0975-7月', 246, 'AP086'),
    ex('電信2778-8月', 305, 'AP086'), ex('電信2778-7月', 300, 'AP086'),
    ex('電信0975-8月', 217, 'AP086'),
    ex('管理服務費', 7350, 'AP077'),
  ];
  assert.equal(lentTotal(rows), 13209);
  // 暫付那三列加起來也要是同一個數 —— 兩邊對不上就是漏了一筆
  assert.equal(4530 + 1329 + 7350, 13209);
});

test('lentTotal：沒代墊的不算進去', () => {
  assert.equal(lentTotal([ex('a', 100, 'AP1'), ex('b', 50, null)]), 100);
});

test('★★ lentTotal 只算支出 —— 收入沒有代墊這回事', () => {
  // 收入那一側就算被塞了 advanceId 也不該讓這個數字變大
  assert.equal(lentTotal([ex('a', 100, 'AP1'), inc('b', 999, 'AP1')]), 100);
});

test('lentTotal：空清單／null 回 0，不是 NaN', () => {
  assert.equal(lentTotal([]), 0);
  assert.equal(lentTotal(null), 0);
  assert.equal(lentTotal(undefined), 0);
});

test('lentTotal：金額四捨五入到整數（台幣沒有小數）', () => {
  assert.equal(lentTotal([ex('a', 100.4, 'AP1'), ex('b', 100.6, 'AP1')]), 201);
});

/* ══════════════ lentSiblings ══════════════ */

test('★★★ lentSiblings：五筆的那一組要回五筆（含自己）', () => {
  const rows = [
    ex('健保費', 1428, 'AP075'), ex('勞保費', 3102, 'AP075'),
    ex('旅平險', 261, 'AP086'), ex('電信0975-7月', 246, 'AP086'),
    ex('電信2778-8月', 305, 'AP086'), ex('電信2778-7月', 300, 'AP086'),
    ex('電信0975-8月', 217, 'AP086'),
  ];
  const five = lentSiblings(rows, 'AP086');
  assert.equal(five.length, 5);
  assert.equal(five.reduce((s, e) => s + e.amount, 0), 1329);

  const two = lentSiblings(rows, 'AP075');
  assert.equal(two.length, 2);
  assert.equal(two.reduce((s, e) => s + e.amount, 0), 4530);
});

test('lentSiblings：沒有 advanceId 就回空陣列，不是全部', () => {
  const rows = [ex('a', 1, 'AP1'), ex('b', 2, 'AP2')];
  assert.deepEqual(lentSiblings(rows, null), []);
  assert.deepEqual(lentSiblings(rows, undefined), []);
  assert.deepEqual(lentSiblings(rows, ''), []);
});

test('lentSiblings：撈不到就是空的，不要回 undefined', () => {
  assert.deepEqual(lentSiblings([ex('a', 1, 'AP1')], 'AP9'), []);
  assert.deepEqual(lentSiblings(null, 'AP1'), []);
});

/*
 * ★★ 分組加總 == 總額。分組漏掉一筆的話,
 *   點開來的明細加起來會比那一列暫付少 —— 而畫面上兩個數字都「看起來正常」。
 */
test('★★ 每一組的加總，合起來要等於 lentTotal', () => {
  const rows = [
    ex('健保費', 1428, 'AP075'), ex('勞保費', 3102, 'AP075'),
    ex('旅平險', 261, 'AP086'), ex('電信0975-7月', 246, 'AP086'),
    ex('電信2778-8月', 305, 'AP086'), ex('電信2778-7月', 300, 'AP086'),
    ex('電信0975-8月', 217, 'AP086'),
    ex('管理服務費', 7350, 'AP077'),
    ex('自己付的', 500, null),
  ];
  const ids = [...new Set(rows.map((r) => r.advanceId).filter(Boolean))] as string[];
  const sum = ids.reduce(
    (s, id) => s + lentSiblings(rows, id).reduce((n, e) => n + e.amount, 0), 0);
  assert.equal(sum, lentTotal(rows));
  assert.equal(sum, 13209);
});
