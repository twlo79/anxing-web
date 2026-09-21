import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  needsPayout, payAccountsFor, accountsForBook, payAccountsForBook,
} from './purchase-pay.ts';

const A = (code: string, method: string, book?: string | null) => ({ code, method, book });

/** 真實的帳號主檔形狀（migration_284 之後） */
const ACCTS = [
  A('8088', 'transfer', 'anxing'),
  A('0564', 'transfer', 'anxing'),
  A('2915', 'credit_card', 'anxing'),
  A('安幸現金', 'cash', 'anxing'),
  A('正隆現金', 'cash', 'anxing'),
  A('4195', 'transfer', 'aipi'),
  A('愛皮現金', 'cash', 'aipi'),
  A('1624', 'transfer', 'hongsha'),
  A('洪鯊現金', 'cash', 'hongsha'),
];
const codes = (xs: { code: string }[]) => xs.map((x) => x.code);

/* ── accountsForBook ─────────────────────────────────────── */

test('★★★ 安幸的頁面只看得到安幸的帳號', () => {
  assert.deepEqual(codes(accountsForBook(ACCTS, 'anxing')),
    ['8088', '0564', '2915', '安幸現金', '正隆現金']);
});

test('★★★ 愛皮的頁面只看得到愛皮的帳號', () => {
  assert.deepEqual(codes(accountsForBook(ACCTS, 'aipi')), ['4195', '愛皮現金']);
});

test('洪鯊的頁面只看得到洪鯊的帳號', () => {
  assert.deepEqual(codes(accountsForBook(ACCTS, 'hongsha')), ['1624', '洪鯊現金']);
});

test('★★★ allowAnxing：請款單要同時看得到安幸的（代墊靠它）', () => {
  assert.deepEqual(codes(accountsForBook(ACCTS, 'aipi', true)),
    ['8088', '0564', '2915', '安幸現金', '正隆現金', '4195', '愛皮現金']);
});

test('★ allowAnxing 對安幸自己那一頁沒有差別（不會重複列）', () => {
  assert.deepEqual(codes(accountsForBook(ACCTS, 'anxing', true)),
    codes(accountsForBook(ACCTS, 'anxing', false)));
});

test('★★ book 是空的當成安幸 —— 不要回空陣列讓下拉整個消失', () => {
  assert.deepEqual(codes(accountsForBook(ACCTS, null)), codes(accountsForBook(ACCTS, 'anxing')));
  assert.deepEqual(codes(accountsForBook(ACCTS, '  ')), codes(accountsForBook(ACCTS, 'anxing')));
});

test('★★★ 帳號沒有 book 欄位（284 還沒跑）一律當安幸', () => {
  const old = [{ code: 'x', method: 'transfer' }, { code: 'y', method: 'cash' }];
  assert.deepEqual(codes(accountsForBook(old, 'anxing')), ['x', 'y']);
  assert.deepEqual(codes(accountsForBook(old, 'aipi')), []);
  assert.deepEqual(codes(accountsForBook(old, 'aipi', true)), ['x', 'y']);
});

test('沒有帳號就是空陣列，不會當掉', () => {
  assert.deepEqual(accountsForBook([], 'aipi'), []);
  assert.deepEqual(accountsForBook(null, 'aipi'), []);
  assert.deepEqual(accountsForBook(undefined, 'aipi'), []);
});

/* ── payAccountsForBook：兩個條件一起 ───────────────────── */

test('★★★ 付款方式與帳本要一起篩 —— 愛皮匯款只剩 4195', () => {
  assert.deepEqual(codes(payAccountsForBook(ACCTS, 'transfer', 'aipi')), ['4195']);
});

test('★★★ 愛皮的現金只剩愛皮現金 —— 不會看到安幸現金', () => {
  assert.deepEqual(codes(payAccountsForBook(ACCTS, 'cash', 'aipi')), ['愛皮現金']);
});

test('★★ 愛皮沒有信用卡 → 空的（而不是掉回安幸那幾張）', () => {
  assert.deepEqual(codes(payAccountsForBook(ACCTS, 'credit_card', 'aipi')), []);
});

test('★★ 臨櫃吃匯款＋現金兩類，帳本照樣要篩', () => {
  assert.deepEqual(codes(payAccountsForBook(ACCTS, 'counter', 'aipi')), ['4195', '愛皮現金']);
  assert.deepEqual(codes(payAccountsForBook(ACCTS, 'counter', 'anxing')),
    ['8088', '0564', '安幸現金', '正隆現金']);
});

test('★★★ 請款單（allowAnxing）：愛皮的匯款單也選得到安幸的戶頭 —— 那就是代墊', () => {
  assert.deepEqual(codes(payAccountsForBook(ACCTS, 'transfer', 'aipi', true)),
    ['8088', '0564', '4195']);
});

test('★★★ 新的一定是舊的子集，而且少掉的剛好是別本帳的', () => {
  /*
   * ★ 這是這次改動的**本質**:同一個付款方式，新的下拉是舊的子集，
   *   而被拿掉的每一個都不是安幸的。
   *   寫成「新舊結果一樣」是錯的 —— 那等於說這次什麼都沒改。
   */
  for (const m of ['transfer', 'credit_card', 'cash', 'counter', 'autopay']) {
    const before = payAccountsFor(ACCTS, m);
    const after = payAccountsForBook(ACCTS, m, 'anxing');
    assert.ok(codes(after).every((c) => codes(before).includes(c)), `${m}:新的不是舊的子集`);
    const dropped = before.filter((a) => !after.includes(a));
    assert.ok(dropped.every((a) => a.book !== 'anxing'),
      `${m}:拿掉了安幸自己的帳號 —— ${codes(dropped).join('、')}`);
  }
});

test('★★ 具體看一組：匯款從 4 個變 2 個，掉的是愛皮與洪鯊', () => {
  assert.deepEqual(codes(payAccountsFor(ACCTS, 'transfer')), ['8088', '0564', '4195', '1624']);
  assert.deepEqual(codes(payAccountsForBook(ACCTS, 'transfer', 'anxing')), ['8088', '0564']);
});

test('★ needsPayout 本來就包含現金（2026-09-09）—— 所以不用第二條規則', () => {
  assert.equal(needsPayout('cash'), true);
  assert.equal(needsPayout('transfer'), true);
  assert.equal(needsPayout(null), false);
});
