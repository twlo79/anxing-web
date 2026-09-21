import test from 'node:test';
import assert from 'node:assert/strict';
import {
  dueDateOf, payDayOf, dueDayText, fmtDue, STEP_OF,
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

test('★★★ 沒填 pay_day → 幾號來自租期起日（2026-09-17 改）', () => {
  // 租期起 7/1 → 每月 1 號；預繳制所以第一期應繳日落在 6/1
  const payDay = payDayOf(START, null);
  assert.equal(payDay, 1);
  assert.equal(dueDateOf(START, 'monthly', 0, payDay), '2026-06-01');
  assert.equal(dueDateOf(START, 'monthly', 1, payDay), '2026-07-01');
});

test('★★ 租期起在月中 → 幾號就是那一天', () => {
  assert.equal(payDayOf('2026-07-16', null), 16);
  assert.equal(dueDateOf('2026-07-16', 'monthly', 0, payDayOf('2026-07-16', null)), '2026-06-16');
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

// ── payDayOf ───────────────────────────────────────

test('payDayOf:pay_day 有填就用它（另外談好的繳款日）', () => {
  assert.equal(payDayOf(START, 5), 5, '租期起是 1 號，但約定 5 號繳');
});

test('★★★ payDayOf:沒填 pay_day 就用租期起日的「日」', () => {
  assert.equal(payDayOf('2026-07-16', null), 16);
  assert.equal(payDayOf('2026-07-16', 0), 16, '0 不是有效的「幾號」');
});

test('★★ payDayOf:首繳日再也影響不了它 —— 這支根本收不到那個參數', () => {
  // 舊的寫法是 resolvePayDay(null, '2023-06-06') → 6。
  // 現在只看租期起日，那個 6 沒有任何路徑進得來。
  assert.equal(payDayOf('2026-07-01', null), 1);
});

test('payDayOf:沒有租期起日又沒有 pay_day → null，不要自己猜 1 號', () => {
  assert.equal(payDayOf(null, null), null);
  assert.equal(payDayOf('', null), null);
  assert.equal(payDayOf('壞掉的日期', null), null);
});

test('payDayOf:pay_day 超出 1–31 就當沒填，退回租期起日', () => {
  assert.equal(payDayOf('2026-07-16', 32), 16);
  assert.equal(payDayOf('2026-07-16', -3), 16);
  assert.equal(payDayOf(null, 32), null, '兩邊都不能用就是 null');
});

// ── dueDayText（畫面上那一行人話）────────────────────

test('月繳只說幾號', () => {
  const r = dueDayText('2026-11-01', 'monthly');
  assert.equal(r.text, '每月 1 號');
  assert.equal(r.months, '');
});

test('★★★ 季繳要說出是哪幾個月 —— 只寫「每季 1 號」不知道是哪一季', () => {
  const r = dueDayText('2026-11-01', 'quarterly');
  assert.equal(r.text, '每季 1 號');
  assert.equal(r.months, '也就是 11／2／5／8 月的 1 號');
});

test('半年繳兩個月份', () => {
  assert.equal(dueDayText('2026-11-01', 'halfyear').months, '也就是 11／5 月的 1 號');
});

test('★★ 年繳要寫幾月幾號 —— 一年只有一次，月份是最重要的資訊', () => {
  const r = dueDayText('2026-11-01', 'yearly');
  assert.equal(r.text, '每年 11 月 1 號');
  assert.equal(r.months, '');
});

test('★ pay_day 覆寫時人話也跟著換', () => {
  assert.equal(dueDayText('2026-11-01', 'monthly', 5).text, '每月 5 號');
  assert.equal(dueDayText('2026-11-01', 'quarterly', 5).months, '也就是 11／2／5／8 月的 5 號');
});

test('★★ 29 號以上要提醒會被夾到月底 —— 不然二月會被當成算錯', () => {
  assert.ok(dueDayText('2026-01-31', 'monthly').clamp.includes('31 號'));
  assert.ok(dueDayText('2026-01-30', 'monthly').clamp.includes('30 號'));
  assert.equal(dueDayText('2026-01-28', 'monthly').clamp, '', '28 號每個月都有');
});

test('★ 算不出來就回空字串，不要印半句話', () => {
  assert.deepEqual(dueDayText(null, 'monthly'), { text: '', months: '', clamp: '' });
  assert.deepEqual(dueDayText('壞掉', 'monthly'), { text: '', months: '', clamp: '' });
});

test('★ 月份會跨年繞回來:季繳 11 月起 → 11／2／5／8', () => {
  assert.equal(dueDayText('2026-11-05', 'quarterly').months, '也就是 11／2／5／8 月的 5 號');
  assert.equal(dueDayText('2026-01-05', 'quarterly').months, '也就是 1／4／7／10 月的 5 號');
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

/*
 * ★★ 2026-09-17:「首繳日」那三條檢查一起刪掉了。
 *   它們守的是一個已經不存在的欄位 —— 首繳日不再參與計算，
 *   表單上也不再出現。一個沒有人填得到的欄位不需要守衛，
 *   而留著一條永遠通過的測試會讓人以為那裡還有人在看。
 */

/*
 * ── 訂金階段的租期（migration_174 / 2026-08-25 修）────────
 *
 * 使用者勾了「只收訂金」按儲存，被 alert 擋下說「租期起沒有填成有效日期」。
 * 畫面上那兩格明明寫著「選填」。
 */
test('★ allowEmpty：兩欄都空時放行', () => {
  assert.deepEqual(checkContractDates('', '', { allowEmpty: true }), { ok: true });
  assert.deepEqual(checkContractDates(null, null, { allowEmpty: true }), { ok: true });
});

test('★★ allowEmpty 只放行「都空」—— 填一半照樣擋', () => {
  assert.equal(checkContractDates('2026-09-01', '', { allowEmpty: true }).ok, false);
  assert.equal(checkContractDates('', '2027-08-31', { allowEmpty: true }).ok, false);
});

test('allowEmpty 時租期填完整還是要檢查前後順序', () => {
  assert.equal(checkContractDates('2027-01-01', '2026-01-01', { allowEmpty: true }).ok, false);
  assert.deepEqual(checkContractDates('2026-09-01', '2027-08-31', { allowEmpty: true }), { ok: true });
});



test('沒傳 opts 時行為跟以前一模一樣（既有呼叫端不會鬆掉）', () => {
  /* ★ 這兩行原本寫成 `(…, null)` 與四個參數 —— 那個簽章不存在。
       `--experimental-strip-types` 把型別剝掉所以測試照跑,
       紅的只有 `tsc`,而沒有人看（2026-09-21 修）。 */
  assert.equal(checkContractDates('', '').ok, false);
  assert.equal(checkContractDates('', '', { allowEmpty: false }).ok, false);
});
