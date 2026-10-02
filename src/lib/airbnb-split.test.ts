import test from 'node:test';
import assert from 'node:assert/strict';
import { airbnbSplit, airbnbSplitLine } from './airbnb-split.ts';

const fmt = (n: number) => n.toLocaleString('en-US');

test('有搭檔：實收＋搭檔＝訂單金額（HM54DSP3QZ 那張）', () => {
  const s = airbnbSplit(182714, { earnings: '109628.41', cohost: '73085.61' });
  assert.deepEqual(s, { kind: 'split', earn: 109628.41, cohost: 73085.61, diff: 0 });
  assert.equal(airbnbSplitLine(s, fmt), '實收 109,628・搭檔 73,086');
});
test('沒有搭檔只寫實收', () => {
  assert.equal(airbnbSplitLine(airbnbSplit(17877, { earnings: 17877, cohost: 0 }), fmt), '實收 17,877');
});
test('快照沒有／實收是空的 → 沒有明細', () => {
  assert.equal(airbnbSplitLine(airbnbSplit(100, null), fmt), '沒有明細');
  assert.equal(airbnbSplit(100, { earnings: null, cohost: 5 }).kind, 'none');
});
test('搭檔沒抓到（null）：寫「搭檔 ?」，差額照實收算', () => {
  const s = airbnbSplit(175800, { earnings: 105479.73, cohost: null });
  assert.equal(airbnbSplitLine(s, fmt), '實收 105,480・搭檔 ?');
  assert.equal(s.kind === 'split' && s.diff, 70320);
});
test('差 1 元以內當作對得上（訂單金額存整數）', () => {
  const s = airbnbSplit(175800, { earnings: 105479.73, cohost: 70319.83 });
  assert.equal(s.kind === 'split' && s.diff, 0);
});
