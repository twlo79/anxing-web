import test from 'node:test';
import assert from 'node:assert/strict';
import { leaseMonths, feeMonthly } from './lease.ts';

/*
 * 固定加費的期別必須夾在租期內。
 * 這幾條釘住的都是「存得進去但一期都不會產生」的情況 ——
 * 那種錯畫面上完全沒有線索：設定在那裡，費用單就是不存在。
 */

test('租期 2026/10/1 ~ 2028/9/30 → 24 個月', () => {
  const m = leaseMonths('2026-10-01', '2028-09-30');
  assert.equal(m.length, 24);
  assert.equal(m[0], '202610');
  assert.equal(m[23], '202809');
});

test('★ 迄日是隔月 1 號時不能多長一個月', () => {
  // 很多契約把「住到 9/30」寫成迄日 10/01。
  // 直接取 end_date 的月份會多出 2028/10，而那一期永遠收不到錢。
  const m = leaseMonths('2026-10-01', '2028-10-01');
  assert.equal(m[m.length - 1], '202809');
  assert.equal(m.length, 24);
});

test('月中起租：起日那個月算第一個月', () => {
  const m = leaseMonths('2026-06-23', '2026-09-23');
  assert.deepEqual(m, ['202606', '202607', '202608', '202609']);
});

test('同一個月內的短約 → 一個月', () => {
  assert.deepEqual(leaseMonths('2026-03-05', '2026-03-28'), ['202603']);
});

test('★ 沒有租期就回空陣列,不要猜', () => {
  // 猜一個預設值的話,使用者會選到一個跟契約無關的月份而不自知
  assert.deepEqual(leaseMonths(null, '2026-09-30'), []);
  assert.deepEqual(leaseMonths('2026-10-01', null), []);
  assert.deepEqual(leaseMonths('', ''), []);
});

test('★ 迄日早於起日 → 空陣列,不是負數迴圈', () => {
  assert.deepEqual(leaseMonths('2027-01-01', '2026-01-01'), []);
});

test('跨年正確', () => {
  const m = leaseMonths('2026-11-01', '2027-02-28');
  assert.deepEqual(m, ['202611', '202612', '202701', '202702']);
});

test('壞掉的日期不會讓瀏覽器卡住', () => {
  assert.deepEqual(leaseMonths('not-a-date', '2026-09-30'), []);
});

// ── 每月加費合計 ───────────────────────────────────

const rc = (amount: number, active = true) => ({
  id: String(amount), contract_id: 'c', fee_type: 'mgmtfee', item_name: null,
  amount, start_ym: '202610', end_ym: null, active, note: null,
});

test('★ 暫停的不計入合計', () => {
  assert.equal(feeMonthly([rc(3000), rc(2000, false)]), 3000);
});

test('沒有加費就是 0', () => {
  assert.equal(feeMonthly([]), 0);
});

// ── 期別跟著繳別 ───────────────────────────────────

import { leasePeriods, cadenceStep, periodOf } from './lease.ts';

test('一期幾個月', () => {
  assert.equal(cadenceStep('monthly'), 1);
  assert.equal(cadenceStep('quarterly'), 3);
  assert.equal(cadenceStep('halfyear'), 6);
  assert.equal(cadenceStep('yearly'), 12);
  assert.equal(cadenceStep('沒看過的值'), 1, '不認得的繳別當成月繳,不要回 0 造成無窮迴圈');
});

test('★ 年繳兩年 → 兩期，不是二十四期', () => {
  // 這就是 migration_106 修的那個 bug：以前一律每月一張,
  // 年繳契約設管理費 3,000 會變成一年收 36,000
  const ps = leasePeriods('2026-10-01', '2028-09-30', 'yearly');
  assert.equal(ps.length, 2);
  assert.equal(ps[0].ym, '202610');
  assert.equal(ps[1].ym, '202710');
  assert.match(ps[0].label, /2026\/10 ~ 2027\/09/);
});

test('★ 期別錨在起租月，不是 1 月', () => {
  const ps = leasePeriods('2026-06-01', '2027-05-31', 'yearly');
  assert.equal(ps[0].ym, '202606');
  assert.match(ps[0].label, /2026\/06 ~ 2027\/05/);
});

test('季繳一年 → 四期', () => {
  const ps = leasePeriods('2026-01-01', '2026-12-31', 'quarterly');
  assert.deepEqual(ps.map((p) => p.ym), ['202601', '202604', '202607', '202610']);
});

test('★ 最後一期不滿也要列出來', () => {
  // 租期 14 個月的年繳約：第二期只有 2 個月。
  // 少列的話那兩個月的加費永遠產不出來,而且沒有任何提示。
  const ps = leasePeriods('2026-01-01', '2027-02-28', 'yearly');
  assert.equal(ps.length, 2);
  assert.equal(ps[1].ym, '202701');
  assert.match(ps[1].label, /2027\/01 ~ 2027\/02/);
});

test('月繳的標籤不加波折號', () => {
  const ps = leasePeriods('2026-01-01', '2026-03-31', 'monthly');
  assert.equal(ps.length, 3);
  assert.equal(ps[0].label, '第 1 期 2026/01');
});

test('★ 舊資料落在期中時要對到「包含它的那一期」', () => {
  // 改版前使用者選得到任何一個月。用相等比對的話那些設定會整個消失,
  // 而且是「儲存成功但一期都不見了」那種沒有線索的消失。
  const ps = leasePeriods('2026-10-01', '2028-09-30', 'yearly');
  assert.equal(periodOf(ps, '202703')?.ym, '202610');
  assert.equal(periodOf(ps, '202710')?.ym, '202710');
  assert.equal(periodOf(ps, '202509'), null, '比第一期還早 → 沒有對應的期');
});

test('沒有租期就沒有期別', () => {
  assert.deepEqual(leasePeriods(null, null, 'yearly'), []);
});
