import test from 'node:test';
import assert from 'node:assert/strict';
import {
  breakHours, actualHours, dueHours, fmtHM, fmtLate, hoursGap,
} from './attendance-hours.ts';

/* ── 休息時間 ────────────────────────────────── */

test('★★ 休息從設定推導,不寫死', () => {
  // 09:00–18:00 共 9 小時,每日工時 8 → 休息 1
  assert.equal(breakHours('09:00', '18:00', 8), 1);
});

test('★ 改成 08:00–17:00 也對', () => {
  assert.equal(breakHours('08:00', '17:00', 8), 1);
});

test('★ 六小時班沒有休息', () => {
  assert.equal(breakHours('09:00', '15:00', 6), 0);
});

test('★★ 設定矛盾時休息當 0,不能是負的', () => {
  // 每日工時比在公司的時間還長 —— 那是設定要修的問題,
  // 不該讓實到變成比在公司還久
  assert.equal(breakHours('09:00', '15:00', 8), 0);
});

test('跨夜班：22:00–06:00 是 8 小時', () => {
  assert.equal(breakHours('22:00', '06:00', 8), 0);
});

test('設定缺一半就當沒有休息', () => {
  assert.equal(breakHours(null, '18:00', 8), 0);
  assert.equal(breakHours('09:00', undefined, 8), 0);
});

/* ── 實到 ────────────────────────────────────── */

const IN = '2026-08-16T09:00:00+08:00';
const OUT = '2026-08-16T18:00:00+08:00';

test('★★ 準時上下班,扣掉休息剛好是 8', () => {
  assert.equal(actualHours(IN, OUT, 1), 8);
});

test('★★ 沒打下班卡回 null,不是 0', () => {
  // 0 的意思是「那天做了 0 小時」,null 是「算不出來」——
  // 混在一起的話,忘記打下班的人會被當成整天沒做事
  assert.equal(actualHours(IN, null, 1), null);
  assert.equal(actualHours(null, OUT, 1), null);
});

test('★ 下班比上班早（資料壞了）回 null', () => {
  assert.equal(actualHours(OUT, IN, 1), null);
});

test('★ 待不到休息時間的話是 0,不是負的', () => {
  const out = '2026-08-16T09:30:00+08:00';
  assert.equal(actualHours(IN, out, 1), 0);
});

test('遲到一小時 → 實到 7', () => {
  assert.equal(actualHours('2026-08-16T10:00:00+08:00', OUT, 1), 7);
});

/* ── 應到 ────────────────────────────────────── */

test('★ 應到 = 每日工時 − 請假', () => {
  assert.equal(dueHours(8, 0, true), 8);
  assert.equal(dueHours(8, 4, true), 4);
});

test('★★ 請假比工時長也不會變負的', () => {
  assert.equal(dueHours(8, 12, true), 0);
});

test('★★ 例假日應到是 0', () => {
  // 不然一個月會憑空多出十幾天的應到時數
  assert.equal(dueHours(8, 0, false), 0);
});

/* ── 顯示 ────────────────────────────────────── */

test('★★ 小時數寫成「幾小時幾分」', () => {
  assert.equal(fmtHM(7.75), '7 小時 45 分');
  assert.equal(fmtHM(8), '8 小時');
});

test('★ 不足一小時只寫分 —— 「0 小時 45 分」那個 0 沒有資訊', () => {
  assert.equal(fmtHM(0.75), '45 分');
});

test('0 就是 0 分,不是破折號', () => {
  assert.equal(fmtHM(0), '0 分');
});

test('★★ 算不出來回破折號 —— 跟 0 是兩件事', () => {
  assert.equal(fmtHM(null), '—');
  assert.equal(fmtHM(undefined), '—');
  assert.equal(fmtHM(NaN), '—');
});

test('負數（多做了）帶減號', () => {
  assert.equal(fmtHM(-1.5), '−1 小時 30 分');
});

/* ── 遲到 ────────────────────────────────────── */

test('★ 未滿一小時寫分', () => {
  assert.equal(fmtLate(45), '45 分');
});

test('★★ 超過一小時要換算 —— 「135 分」要停下來算才知道是兩小時多', () => {
  assert.equal(fmtLate(135), '超過 2 小時 15 分');
});

test('剛好整點不寫 0 分', () => {
  assert.equal(fmtLate(120), '超過 2 小時');
  assert.equal(fmtLate(60), '超過 1 小時');
});

test('沒遲到就是空字串,不要顯示「0 分」', () => {
  assert.equal(fmtLate(0), '');
  assert.equal(fmtLate(null), '');
  assert.equal(fmtLate(undefined), '');
});

/* ── 差額 ────────────────────────────────────── */

test('★ 應到 8 實到 7 → 少 1 小時', () => {
  assert.equal(hoursGap(8, 7), 1);
});

test('多做的是負數', () => {
  assert.equal(hoursGap(8, 9.5), -1.5);
});

test('★★ 沒打下班卡時差額算不出來,不能當成「少做 8 小時」', () => {
  assert.equal(hoursGap(8, null), null);
});
