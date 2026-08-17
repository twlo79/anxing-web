import test from 'node:test';
import assert from 'node:assert/strict';
import { annualLeaveDays, monthsBetween, tierLabel, leaveHours } from './annual-leave.ts';

// ── 足月數 ────────────────────────────────────────

test('滿一個月是「到同一個日子」，不是 30 天', () => {
  assert.equal(monthsBetween('2026-01-15', '2026-02-14'), 0);
  assert.equal(monthsBetween('2026-01-15', '2026-02-15'), 1);
});

test('月底到職:1/31 到 2/28 還沒滿一個月', () => {
  // 2 月沒有 31 號，要等到 3/31
  assert.equal(monthsBetween('2026-01-31', '2026-02-28'), 0);
  assert.equal(monthsBetween('2026-01-31', '2026-03-31'), 2);
});

test('跨年', () => {
  assert.equal(monthsBetween('2025-08-17', '2026-08-17'), 12);
  assert.equal(monthsBetween('2025-08-17', '2026-08-16'), 11);
});

test('壞格式回 -1，不回 NaN', () => {
  assert.equal(monthsBetween('2026-8-17', '2026-08-17'), -1);
  assert.equal(monthsBetween('', '2026-08-17'), -1);
});

// ── 級距 ──────────────────────────────────────────

test('未滿 6 個月沒有特休', () => {
  assert.equal(annualLeaveDays('2026-05-01', '2026-08-17'), 0);
});

test('★ 滿 6 個月當天就有 7 天', () => {
  assert.equal(annualLeaveDays('2026-02-17', '2026-08-17'), 7);
  assert.equal(annualLeaveDays('2026-02-18', '2026-08-17'), 0);   // 差一天還沒滿
});

test('★ 滿 1 年 11 天', () => {
  assert.equal(annualLeaveDays('2025-08-17', '2026-08-17'), 11);
  assert.equal(annualLeaveDays('2025-08-18', '2026-08-17'), 7);
});

test('★ 滿 2 年 16 天', () => {
  assert.equal(annualLeaveDays('2024-08-17', '2026-08-17'), 16);
});

test('★ 滿 3 年 21 天', () => {
  assert.equal(annualLeaveDays('2023-08-17', '2026-08-17'), 21);
});

test('★ 3 年以上只增不減 —— 做十年還是 21 天，不會歸零', () => {
  // 如果有人把「3 年以上」寫成「3~5 年」再開新級距，就會出現滿 5 年反而沒有的洞
  assert.equal(annualLeaveDays('2016-08-17', '2026-08-17'), 21);
});

test('★ 沒填到職日回 null，不回 0', () => {
  // 0 是「他沒有特休」，null 是「算不出來」—— 混在一起的話沒填資料的人
  // 看起來像已經處理完了
  assert.equal(annualLeaveDays(null, '2026-08-17'), null);
  assert.equal(annualLeaveDays('', '2026-08-17'), null);
});

test('到職日在未來回 null', () => {
  assert.equal(annualLeaveDays('2027-01-01', '2026-08-17'), null);
});

// ── 說明文字 ──────────────────────────────────────

test('畫面上要寫出落在哪一段', () => {
  assert.equal(tierLabel('2025-08-17', '2026-08-17'), '1 ~ 2 年');
  assert.equal(tierLabel('2026-05-01', '2026-08-17'), '未滿 6 個月');
  assert.equal(tierLabel(null, '2026-08-17'), '未填到職日');
});

// ── 換算小時 ──────────────────────────────────────

test('天換小時用設定的每日工時，不寫死 8', () => {
  assert.equal(leaveHours(11, 8), 88);
  assert.equal(leaveHours(11, 7.5), 82.5);
});
