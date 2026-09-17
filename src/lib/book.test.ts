/**
 * lib/book.ts 的測試 —— 只涵蓋「安幸代墊」那一組（canLend / lendFor / autoLend）。
 *
 * ★ 這三支決定的是**安幸那邊記不記得到那筆應收**。
 *   2026-09-17 查到有請款單的支出 195 筆而代墊只有 2 筆 ——
 *   那個落差就是這裡沒測到的後果。
 *
 * 跑法：node --experimental-strip-types --test src/lib/book.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canLend, lendFor, autoLend, toBook, DEFAULT_BOOK } from './book.ts';

/* ══════════════ canLend ══════════════ */

test('canLend：安幸自己不用跟自己借', () => {
  assert.equal(canLend('anxing'), false);
  assert.equal(canLend(DEFAULT_BOOK), false);
});

test('canLend：愛皮與洪鯊都會', () => {
  assert.equal(canLend('aipi'), true);
  assert.equal(canLend('hongsha'), true);
});

test('canLend：null／空／不認得的值一律當安幸（toBook 的規則）', () => {
  assert.equal(canLend(null), false);
  assert.equal(canLend(undefined), false);
  assert.equal(canLend(''), false);
  assert.equal(canLend('AIPI'), false);   // 大小寫不同就是不認得
  assert.equal(canLend('愛皮'), false);   // 標籤不是值
});

/* ══════════════ lendFor ══════════════ */

test('lendFor：勾了就一律回這張單的帳本，不讓人挑', () => {
  assert.equal(lendFor('aipi', true), 'aipi');
  assert.equal(lendFor('hongsha', true), 'hongsha');
});

test('lendFor：沒勾就是 null', () => {
  assert.equal(lendFor('aipi', false), null);
  assert.equal(lendFor('hongsha', false), null);
});

test('lendFor：安幸的單勾了也還是 null（防呆）', () => {
  assert.equal(lendFor('anxing', true), null);
  assert.equal(lendFor(null, true), null);
});

test('lendFor：回傳值永遠等於 toBook(book) 或 null —— 不會指向另一家', () => {
  for (const b of ['anxing', 'aipi', 'hongsha', null, '', 'xxx']) {
    const v = lendFor(b, true);
    assert.ok(v === null || v === toBook(b),
      `lendFor(${String(b)}) 回了 ${String(v)}，跟 book 對不起來`);
  }
});

/* ══════════════ autoLend ══════════════ */

test('autoLend：換成愛皮就自動填上愛皮', () => {
  assert.equal(autoLend('aipi', {}), 'aipi');
});

test('autoLend：換成洪鯊就自動填上洪鯊', () => {
  assert.equal(autoLend('hongsha', {}), 'hongsha');
});

test('autoLend：換回安幸要清掉 —— 留著的話會是「安幸代墊給安幸」', () => {
  assert.equal(autoLend('anxing', {}), null);
  assert.equal(autoLend(DEFAULT_BOOK, { advance_for_book: 'aipi' } as never), null);
});

test('autoLend：還沒選事業體（null）不要先勾起來', () => {
  assert.equal(autoLend(null, {}), null);
  assert.equal(autoLend('', {}), null);
  assert.equal(autoLend(undefined, {}), null);
});

test('autoLend：已經是暫支款的話不覆蓋 —— 兩者互斥，硬塞會被資料庫 raise', () => {
  assert.equal(autoLend('aipi', { advance_category: '押金' }), null);
  assert.equal(autoLend('hongsha', { advance_category: '零用金' }), null);
});

test('autoLend：暫支款欄位是空字串／null 時不算有暫支款', () => {
  assert.equal(autoLend('aipi', { advance_category: '' }), 'aipi');
  assert.equal(autoLend('aipi', { advance_category: null }), 'aipi');
});

test('autoLend：cur 傳 null／undefined 不炸', () => {
  assert.equal(autoLend('aipi', null), 'aipi');
  assert.equal(autoLend('aipi', undefined), 'aipi');
});

/*
 * ★★★ 這一條是整組的重點:autoLend 算出來的東西，
 *   存檔時一定過得了 lendFor 那一關。
 *
 *   存檔走的是 `lendFor(edit.book, !!edit.advance_for_book)`（purchases/page.tsx）。
 *   如果 autoLend 填了一個 lendFor 會清掉的值，畫面上勾著、存進去是 null ——
 *   而那正是「安幸少記一筆應收」的同一種症狀，只是換了個原因。
 */
test('autoLend 與 lendFor 一致：勾起來的值存檔時不會被清掉', () => {
  for (const b of ['anxing', 'aipi', 'hongsha', null, '', 'xxx']) {
    const auto = autoLend(b, {});
    const saved = lendFor(b, !!auto);
    assert.equal(saved, auto,
      `book=${String(b)}：autoLend 給 ${String(auto)}，存檔卻變成 ${String(saved)}`);
  }
});

/*
 * ★★ 跑幾次結果一樣 —— autoLend 不吃自己上一次的輸出。
 *   吃的話，「換帳本 → 勾起來 → 再換一次」會出現第三種狀態。
 */
test('autoLend 是冪等的', () => {
  const once = autoLend('aipi', {});
  const twice = autoLend('aipi', { advance_category: null });
  assert.equal(once, twice);
});
