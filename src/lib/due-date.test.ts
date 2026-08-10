import test from 'node:test';
import assert from 'node:assert/strict';
import {
  dueDateOf, resolvePayDay, checkFirstDue, fmtDue, STEP_OF,
  periodRange, fmtPeriodRange, rentMonthCount, checkContractDates,
} from './due-date.ts';

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

// ── 期別區間：月份不夠，要寫到日 ─────────────────────

test('★ 6/13 起租的年繳：第 1 期是 2026/6/13 ~ 2027/6/12', () => {
  assert.deepEqual(periodRange('2026-06-13', 'yearly', 0), ['2026-06-13', '2027-06-12']);
});

test('第 2 期接著第 1 期，中間不能有空隙也不能重疊', () => {
  const p0 = periodRange('2026-06-13', 'yearly', 0)!;
  const p1 = periodRange('2026-06-13', 'yearly', 1)!;
  const next = new Date(p0[1] + 'T00:00:00Z');
  next.setUTCDate(next.getUTCDate() + 1);
  assert.equal(p1[0], next.toISOString().slice(0, 10), '第 2 期要從第 1 期迄日的隔天開始');
});

test('月繳：6/13 起租,第 1 期 6/13~7/12', () => {
  assert.deepEqual(periodRange('2026-06-13', 'monthly', 0), ['2026-06-13', '2026-07-12']);
});

test('季繳：6/13 起租,第 1 期 6/13~9/12', () => {
  assert.deepEqual(periodRange('2026-06-13', 'quarterly', 0), ['2026-06-13', '2026-09-12']);
});

test('半年繳：6/13 起租,第 1 期 6/13~12/12', () => {
  assert.deepEqual(periodRange('2026-06-13', 'halfyear', 0), ['2026-06-13', '2026-12-12']);
});

test('1 號起租：第 1 期 6/1~6/30,不是 6/1~7/1', () => {
  assert.deepEqual(periodRange('2026-06-01', 'monthly', 0), ['2026-06-01', '2026-06-30']);
});

test('★ 31 號起租要夾到月底,不能溢位到下個月', () => {
  // 1/31 起租的月繳,第 2 期起日不能是 2/31（JS 會溢位成 3/3）
  assert.deepEqual(periodRange('2026-01-31', 'monthly', 1), ['2026-02-28', '2026-03-30']);
});

test('閏年 2 月夾到 29 號', () => {
  assert.deepEqual(periodRange('2028-01-31', 'monthly', 1)![0], '2028-02-29');
});

test('跨年：12/13 起租的年繳', () => {
  assert.deepEqual(periodRange('2026-12-13', 'yearly', 0), ['2026-12-13', '2027-12-12']);
});

test('沒有起租日就回 null —— 呼叫端要顯示空白,不要自己猜', () => {
  assert.equal(periodRange(null, 'yearly', 0), null);
  assert.equal(periodRange('', 'yearly', 0), null);
});

test('顯示字串不補零,跟畫面其他地方一致', () => {
  assert.equal(fmtPeriodRange(periodRange('2026-06-13', 'yearly', 0)), '2026/6/13 ~ 2027/6/12');
  assert.equal(fmtPeriodRange(null), '');
});

// ── 租期總月數：不能數日曆月 ───────────────────────

test('★ 6/23 ~ 9/23 季繳 = 3 個月一期（碰到 4 個日曆月）', () => {
  assert.equal(rentMonthCount('2026-06-23', '2026-09-23'), 3);
});

test('★ 6/6 ~ 隔年 6/5 = 12 個月（碰到 13 個日曆月）', () => {
  assert.equal(rentMonthCount('2026-06-06', '2027-06-05'), 12);
});

test('★ 9/11 ~ 隔年 9/10 = 12 個月', () => {
  assert.equal(rentMonthCount('2025-09-11', '2026-09-10'), 12);
});

test('1 號起租、月底到期 = 12 個月（原本就正確,不能改壞）', () => {
  assert.equal(rentMonthCount('2026-06-01', '2027-05-31'), 12);
});

test('1 號起租、隔年 1 號到期 = 12 個月', () => {
  assert.equal(rentMonthCount('2026-06-01', '2027-06-01'), 12);
});

test('半年約 6/15 ~ 12/15 = 6 個月', () => {
  assert.equal(rentMonthCount('2026-06-15', '2026-12-15'), 6);
});

test('月繳一個月 6/23 ~ 7/23 = 1 個月', () => {
  assert.equal(rentMonthCount('2026-06-23', '2026-07-23'), 1);
});

test('每一期的區間要剛好蓋滿整份租期,不多不少', () => {
  // 6/23~9/23 季繳:只有 1 期,而那一期是 6/23~9/22
  const n = rentMonthCount('2026-06-23', '2026-09-23');
  assert.equal(n, 3);
  const periods = Math.ceil(n / STEP_OF.quarterly);
  assert.equal(periods, 1, '季繳 3 個月 = 1 期,不該切成 2 期');
  assert.deepEqual(periodRange('2026-06-23', 'quarterly', 0), ['2026-06-23', '2026-09-22']);
});

test('缺日期回 0 —— 呼叫端要顯示空白,不要自己猜', () => {
  assert.equal(rentMonthCount(null, '2026-09-23'), 0);
  assert.equal(rentMonthCount('2026-06-23', null), 0);
});

// ── 契約日期檢查：4/31 那種存不進去的情況 ───────────

test('★ 租期迄打成不存在的日期（日期框清空）→ 要講出可能打錯,不是只說「沒填」', () => {
  const r = checkContractDates('2026-05-01', '');
  assert.equal(r.ok, false);
  const e = (r as { error: string }).error;
  assert.match(e, /租期迄/);
  assert.match(e, /4\/31/, '要舉例,使用者才知道去檢查哪裡');
});

test('租期起沒填也要擋', () => {
  assert.equal(checkContractDates('', '2027-04-30').ok, false);
});

test('租期迄早於或等於租期起 → 擋,並把兩個日期都印出來', () => {
  const r = checkContractDates('2027-05-01', '2026-04-30');
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /2026-04-30/);
  assert.match((r as { error: string }).error, /2027-05-01/);
  assert.equal(checkContractDates('2026-05-01', '2026-05-01').ok, false, '同一天不是有效租期');
});

test('正常租期 → 過', () => {
  assert.deepEqual(checkContractDates('2026-05-01', '2027-04-30'), { ok: true });
});

test('首繳日早於租期起是正常的（預繳制）', () => {
  assert.deepEqual(checkContractDates('2026-05-01', '2027-04-30', '2026-04-15'), { ok: true });
});

test('★ 首繳日早了一年以上 → 多半是年份打錯', () => {
  const r = checkContractDates('2026-05-01', '2027-04-30', '2025-04-15');
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /年份/);
});

test('首繳日空白不擋 —— 那是選填', () => {
  assert.deepEqual(checkContractDates('2026-05-01', '2027-04-30', null), { ok: true });
});
