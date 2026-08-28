import { test } from 'node:test';
import assert from 'node:assert/strict';
import { syncFrom, syncTo, isReversed } from './date-range.ts';

/**
 * 這一支釘的是「什麼時候**不要**動另一頭」。
 *
 * 補空的那部分寫錯了使用者看得到（迄日沒跟上）；
 * 而多動了一下 —— 把人家選好的區間吃掉 —— 他只會覺得「怎麼又要重選」，
 * 不會回報，也不會有人知道是這裡做的。
 */

// ── 改起點 ────────────────────────────────────────
test('★★ 迄點是空的 → 補成起點', () => {
  assert.deepEqual(syncFrom('2026-08', ''), { from: '2026-08', to: '2026-08' });
});

test('★★ 迄點早於新起點（就是截圖那個情況）→ 拉成起點', () => {
  // 2026-08 ~ 2026-07 查不到任何東西,而畫面只會寫「$0・0 筆」
  assert.deepEqual(syncFrom('2026-08', '2026-07'), { from: '2026-08', to: '2026-08' });
});

test('★★ 迄點還在起點之後 → 一個字都不要動', () => {
  // 選好 1~12 月的人只是把起點往前挪,不該被沒收迄點
  assert.deepEqual(syncFrom('2026-03', '2026-12'), { from: '2026-03', to: '2026-12' });
});

test('起訖相同 → 不動（那是合法的單月/單日）', () => {
  assert.deepEqual(syncFrom('2026-08', '2026-08'), { from: '2026-08', to: '2026-08' });
});

test('★ 清空起點不連動 —— 那是「不要限制這一頭」，是明確的意圖', () => {
  assert.deepEqual(syncFrom('', '2026-07'), { from: '', to: '2026-07' });
});

// ── 改迄點 ────────────────────────────────────────
test('★★ 起點是空的 → 補成迄點', () => {
  assert.deepEqual(syncTo('', '2026-08'), { from: '2026-08', to: '2026-08' });
});

test('★★ 起點晚於新迄點 → 拉成迄點', () => {
  assert.deepEqual(syncTo('2026-09', '2026-08'), { from: '2026-08', to: '2026-08' });
});

test('★★ 起點還在迄點之前 → 一個字都不要動', () => {
  assert.deepEqual(syncTo('2026-03', '2026-12'), { from: '2026-03', to: '2026-12' });
});

test('★ 清空迄點不連動', () => {
  assert.deepEqual(syncTo('2026-07', ''), { from: '2026-07', to: '' });
});

// ── 日期與月份共用同一套 ──────────────────────────
test('★★ 完整日期走同一支，不要分兩套', () => {
  assert.deepEqual(syncFrom('2026-08-27', '2026-08-01'),
    { from: '2026-08-27', to: '2026-08-27' });
  assert.deepEqual(syncFrom('2026-08-01', '2026-08-27'),
    { from: '2026-08-01', to: '2026-08-27' });
});

test('跨年比得對（字典序 = 時間序）', () => {
  assert.deepEqual(syncFrom('2027-01', '2026-12'), { from: '2027-01', to: '2027-01' });
  assert.deepEqual(syncFrom('2026-12', '2027-01'), { from: '2026-12', to: '2027-01' });
});

// ── null / 空白 ───────────────────────────────────
test('null / undefined / 空白都當成沒填，不要變成 "null" 去比大小', () => {
  assert.deepEqual(syncFrom(null, undefined), { from: '', to: '' });
  assert.deepEqual(syncFrom('2026-08', null), { from: '2026-08', to: '2026-08' });
  assert.deepEqual(syncFrom('  2026-08  ', ' '), { from: '2026-08', to: '2026-08' });
});

// ── isReversed ────────────────────────────────────
test('★ 反的區間認得出來（舊網址／書籤沒有經過連動）', () => {
  assert.equal(isReversed('2026-08', '2026-07'), true);
});

test('正常、相同、任一頭空的都不算反', () => {
  assert.equal(isReversed('2026-07', '2026-08'), false);
  assert.equal(isReversed('2026-08', '2026-08'), false);
  assert.equal(isReversed('', '2026-08'), false);
  assert.equal(isReversed('2026-08', ''), false);
  assert.equal(isReversed(null, null), false);
});

// ── 不變式 ────────────────────────────────────────
test('★★ 兩支的結果都不可能是反的', () => {
  const vals = ['', '2026-01', '2026-06', '2026-12', '2027-01'];
  for (const a of vals) for (const b of vals) {
    for (const r of [syncFrom(a, b), syncTo(a, b)]) {
      assert.equal(isReversed(r.from, r.to), false, `${a} / ${b} → ${r.from} ~ ${r.to}`);
    }
  }
});
