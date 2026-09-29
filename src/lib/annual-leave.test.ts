import test from 'node:test';
import assert from 'node:assert/strict';
import { annualLeaveDays, monthsBetween, tierLabel, leaveHours, tiersFrom, STATUTORY_TIERS } from './annual-leave.ts';

// ── 足月數 ────────────────────────────────────────
test('滿一個月是「到同一個日子」，不是 30 天', () => {
  assert.equal(monthsBetween('2026-01-15', '2026-02-14'), 0);
  assert.equal(monthsBetween('2026-01-15', '2026-02-15'), 1);
});
test('月底到職:1/31 到 2/28 還沒滿一個月', () => {
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

// ── 法定級距 ──────────────────────────────────────
const AS = '2026-12-31';
test('未滿 6 個月 0 天（確定沒有，不是算不出來）', () => {
  assert.equal(annualLeaveDays('2026-07-02', AS), 0);
});
test('勞基法 38 條每一級', () => {
  assert.equal(annualLeaveDays('2026-06-30', AS), 3);    // 滿 6 個月
  assert.equal(annualLeaveDays('2025-12-31', AS), 7);    // 滿 1 年
  assert.equal(annualLeaveDays('2024-12-31', AS), 10);   // 滿 2 年
  assert.equal(annualLeaveDays('2023-12-31', AS), 14);   // 滿 3 年
  assert.equal(annualLeaveDays('2021-12-31', AS), 15);   // 滿 5 年
  assert.equal(annualLeaveDays('2017-06-01', AS), 15);   // 9 年半：還在 5～10 那級
});
test('差一天就差一級（邊界用足月）', () => {
  assert.equal(annualLeaveDays('2026-07-01', AS), 0);    // 12/31 剛好差一天滿 6 個月？ 7/1 → 12/31 是 5 個月 30 天
  assert.equal(annualLeaveDays('2026-06-30', AS), 3);
  assert.equal(annualLeaveDays('2026-01-01', AS), 3);    // 11 個月 30 天，未滿 1 年
  assert.equal(annualLeaveDays('2025-12-31', AS), 7);
});
test('10 年以上每滿一年加 1，上限 30', () => {
  assert.equal(annualLeaveDays('2016-12-31', AS), 16);   // 滿 10 年
  assert.equal(annualLeaveDays('2015-12-31', AS), 17);   // 滿 11 年
  assert.equal(annualLeaveDays('2002-12-31', AS), 30);   // 滿 24 年 → 15+15 = 30
  assert.equal(annualLeaveDays('1990-01-01', AS), 30);   // 再久也是 30
});
test('到職日沒填 → null；還沒到職 → null', () => {
  assert.equal(annualLeaveDays(null, AS), null);
  assert.equal(annualLeaveDays('', AS), null);
  assert.equal(annualLeaveDays('2027-03-01', AS), null);
});
test('級距表可以從資料庫傳進來（公司若加碼改表就好）', () => {
  const custom = [{ fromMonths: 6, days: 5 }, { fromMonths: 12, days: 12 }];
  assert.equal(annualLeaveDays('2026-01-01', AS, custom), 5);
  assert.equal(annualLeaveDays('2025-01-01', AS, custom), 12);
});
test('tiersFrom：資料庫列亂序、壞值 → 排好、剔除；空的退回法定', () => {
  const t = tiersFrom([{ threshold_months: 6, days: 3 }, { threshold_months: 12, days: 7 }, { threshold_months: 0, days: 99 }, { threshold_months: 24, days: Number.NaN }]);
  assert.deepEqual(t, [{ fromMonths: 12, days: 7 }, { fromMonths: 6, days: 3 }]);
  assert.deepEqual(tiersFrom([]), [...STATUTORY_TIERS]);
  assert.deepEqual(tiersFrom(null), [...STATUTORY_TIERS]);
});
test('級距文字', () => {
  assert.equal(tierLabel(null, AS), '未填到職日');
  assert.equal(tierLabel('2026-09-01', AS), '未滿 6 個月');
  assert.equal(tierLabel('2026-03-01', AS), '6 個月～1 年');
  assert.equal(tierLabel('2023-06-01', AS), '3～5 年');
  assert.equal(tierLabel('2014-06-01', AS), '滿 12 年');
});
test('天 → 小時用設定的工時', () => {
  assert.equal(leaveHours(7, 8), 56);
  assert.equal(leaveHours(3, 7.5), 22.5);
});
