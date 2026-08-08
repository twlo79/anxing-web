import test from 'node:test';
import assert from 'node:assert/strict';
import { dueDateOf, resolvePayDay, checkFirstDue, fmtDue, STEP_OF } from './due-date.ts';

// 使用者給的情境：契約 2026/7/1 ~ 2027/6/30、13 號繳、預繳制
const START = '2026-07-01';

test('月繳：每期都是「該期第一個月的前一個月」13 號', () => {
  const got = [0, 1, 2, 3].map((i) => dueDateOf(START, 'monthly', i, 13));
  assert.deepEqual(got, ['2026-06-13', '2026-07-13', '2026-08-13', '2026-09-13']);
});

test('季繳：期別 07-09 / 10-12 / 01-03 / 04-06', () => {
  const got = [0, 1, 2, 3].map((i) => dueDateOf(START, 'quarterly', i, 13));
  assert.deepEqual(got, ['2026-06-13', '2026-09-13', '2026-12-13', '2027-03-13']);
});

test('半年繳：期別 07-12 / 01-06', () => {
  const got = [0, 1].map((i) => dueDateOf(START, 'halfyear', i, 13));
  assert.deepEqual(got, ['2026-06-13', '2026-12-13']);
});

test('年繳：只有一期,應繳日一樣是 6/13', () => {
  assert.equal(dueDateOf(START, 'yearly', 0, 13), '2026-06-13');
});

test('使用者的三個例子:首繳日填什麼都不影響應繳日', () => {
  // 5/13、6/13、7/13 三種填法,第一期應繳日都該是 6/13
  for (const fp of ['2026-05-13', '2026-06-13', '2026-07-13']) {
    const payDay = resolvePayDay(null, fp);
    assert.equal(dueDateOf(START, 'monthly', 0, payDay), '2026-06-13', `首繳日 ${fp} 算錯`);
  }
});

test('首繳日年份打錯三年也不影響 —— 舊算法就是這樣整排偏掉的', () => {
  const payDay = resolvePayDay(null, '2023-06-06');
  assert.equal(dueDateOf(START, 'monthly', 0, payDay), '2026-06-06');
  assert.equal(dueDateOf(START, 'monthly', 1, payDay), '2026-07-06');
});

test('跨年:1 月起租的第一期應繳日落在前一年 12 月', () => {
  assert.equal(dueDateOf('2027-01-01', 'monthly', 0, 13), '2026-12-13');
});

test('31 號繳遇到 2 月要夾到當月最後一天,不能溢位到 3 月', () => {
  // 3 月的前一個月是 2 月;2027 不是閏年 → 28 日
  assert.equal(dueDateOf('2027-03-01', 'monthly', 0, 31), '2027-02-28');
  // 閏年
  assert.equal(dueDateOf('2028-03-01', 'monthly', 0, 31), '2028-02-29');
});

test('31 號繳遇到 30 天的月份夾到 30', () => {
  // 5 月的前一個月是 4 月 = 30 天
  assert.equal(dueDateOf('2026-05-01', 'monthly', 0, 31), '2026-04-30');
});

test('租期起在月中,仍以「該月」為期別,不看幾號', () => {
  assert.equal(dueDateOf('2026-07-16', 'monthly', 0, 13), '2026-06-13');
});

test('資料不齊時回 null,不要自己編一個日期出來', () => {
  assert.equal(dueDateOf(null, 'monthly', 0, 13), null);
  assert.equal(dueDateOf(START, 'monthly', 0, null), null);
  assert.equal(dueDateOf('壞掉的日期', 'monthly', 0, 13), null);
});

// ── resolvePayDay ──────────────────────────────────

test('resolvePayDay:pay_day 優先於首繳日', () => {
  assert.equal(resolvePayDay(5, '2026-06-13'), 5);
});

test('resolvePayDay:沒有 pay_day 就取首繳日的日數', () => {
  assert.equal(resolvePayDay(null, '2026-06-13'), 13);
  assert.equal(resolvePayDay(0, '2026-06-13'), 13);      // 0 不是有效的「幾號」
});

test('resolvePayDay:兩個都沒有回 null —— 不要自己猜 1 號', () => {
  assert.equal(resolvePayDay(null, null), null);
  assert.equal(resolvePayDay(null, ''), null);
});

test('resolvePayDay:超出 1–31 一律不採信', () => {
  assert.equal(resolvePayDay(32, null), null);
  assert.equal(resolvePayDay(-3, null), null);
});

// ── checkFirstDue ──────────────────────────────────

test('checkFirstDue:首繳日剛好等於算出來的第一期應繳日 → 不提示', () => {
  const r = checkFirstDue(START, 'monthly', 13, '2026-06-13');
  assert.equal(r.firstDue, '2026-06-13');
  assert.equal(r.mismatch, false);
});

test('checkFirstDue:對不上就要提示 —— 不說的話使用者以為 5/13 生效了', () => {
  const r = checkFirstDue(START, 'monthly', 13, '2026-05-13');
  assert.equal(r.firstDue, '2026-06-13');
  assert.equal(r.mismatch, true);
});

test('checkFirstDue:沒填首繳日就沒有對不上的問題', () => {
  assert.equal(checkFirstDue(START, 'monthly', 13, null).mismatch, false);
});

test('STEP_OF 四種繳別齊全', () => {
  assert.deepEqual(STEP_OF, { monthly: 1, quarterly: 3, halfyear: 6, yearly: 12 });
});

test('fmtDue:不補零,且年份不能被切掉', () => {
  assert.equal(fmtDue('2026-06-13'), '2026/6/13');
  assert.equal(fmtDue('2026-12-31'), '2026/12/31');
  assert.equal(fmtDue('2026-01-05'), '2026/1/5');
  assert.equal(fmtDue(null), '');
});
