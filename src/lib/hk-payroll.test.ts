import test from 'node:test';
import assert from 'node:assert/strict';
import {
  crewSize, cleanUnits, linenJobs, linenSets, payroll, fmtUnits,
  type PayrollRow, dailyUnits } from './hk-payroll.ts';

const r = (p: Partial<PayrollRow> = {}): PayrollRow => ({
  work_date: '2026-08-14', property_id: 'A15', work_type: '退房清潔',
  staff_id: '庭玉', ...p,
});

/* ── 幾個人分一份工 ──────────────────────────── */

test('★ 同一天同一間同一種工作 = 同一份工', () => {
  assert.equal(crewSize([r({ staff_id: '庭玉' }), r({ staff_id: 'Una' })]).get('2026-08-14|A15|退房清潔'), 2);
});

test('★★ 退房與入住是兩份工,不算合掃', () => {
  // 前一組退、後一組進,同一天同一間會有兩筆 —— 那是兩次真的打掃,
  // 算成合掃的話兩筆各變 0.5,總量憑空少一半
  const c = crewSize([
    r({ work_type: '退房清潔' }), r({ work_type: '入住清潔' }),
  ]);
  assert.equal(c.get('2026-08-14|A15|退房清潔'), 1);
  assert.equal(c.get('2026-08-14|A15|入住清潔'), 1);
});

test('★★ 同一個人重複指派只算一個人', () => {
  // 不然他自己跟自己「合掃」,每筆變 0.5,總量憑空少一半
  assert.equal(crewSize([r(), r()]).get('2026-08-14|A15|退房清潔'), 1);
});

test('沒指派的不算任何人在做', () => {
  assert.equal(crewSize([r({ staff_id: null })]).size, 0);
});

/* ── 打掃量 ──────────────────────────────────── */

test('★★ 一個人掃算 1,兩人合掃各 0.5', () => {
  const solo = cleanUnits([r()]);
  assert.equal(solo.get('庭玉'), 1);

  const pair = cleanUnits([r({ staff_id: '庭玉' }), r({ staff_id: 'Una' })]);
  assert.equal(pair.get('庭玉'), 0.5);
  assert.equal(pair.get('Una'), 0.5);
});

test('★ 三個人合掃各三分之一 —— 不是寫死 0.5', () => {
  const u = cleanUnits([
    r({ staff_id: 'a' }), r({ staff_id: 'b' }), r({ staff_id: 'c' }),
  ]);
  assert.equal(u.get('a')!.toFixed(4), (1 / 3).toFixed(4));
});

test('★★ 不在這一層四捨五入', () => {
  // 每一筆都進位的話,一個月幾十筆會累積出好幾間的差,
  // 而那個差直接變成多發的薪水
  const u = cleanUnits([
    r({ staff_id: '庭玉' }), r({ staff_id: 'Una' }),
    r({ work_date: '2026-08-15', staff_id: '庭玉' }),
  ]);
  assert.equal(u.get('庭玉'), 1.5);
});

test('同一個人重複指派同一份工只算一次', () => {
  assert.equal(cleanUnits([r(), r()]).get('庭玉'), 1);
});

/* ── 布巾 ────────────────────────────────────── */

test('★★ 兩人合掃一間,布巾算 1 間不是 2', () => {
  // 房間只有一張床,不會因為兩個人去就變兩張。
  // 跟打掃量用同一個數字的話,布巾會多叫一倍
  const jobs = linenJobs([r({ staff_id: '庭玉' }), r({ staff_id: 'Una' })]);
  assert.equal(jobs.length, 1);
});

test('★ 退房與入住是兩份工,布巾算兩間', () => {
  const jobs = linenJobs([r({ work_type: '退房清潔' }), r({ work_type: '入住清潔' })]);
  assert.equal(jobs.length, 2);
});

test('沒有房源的工作不帶布巾', () => {
  assert.equal(linenJobs([r({ property_id: null, work_type: '其他工時' })]).length, 0);
});

const beds: Record<string, number | null> = { A15: 2, B7: 4, X: null };

test('★ 布巾組數 = 每一份工的床數加總', () => {
  const s = linenSets([
    r({ property_id: 'A15', staff_id: '庭玉' }),
    r({ property_id: 'A15', staff_id: 'Una' }),   // 合掃,還是算一間
    r({ property_id: 'B7' }),
  ], (id) => beds[id]);
  assert.deepEqual(s, { sets: 6, unknown: 0 });
});

test('★★ 床數沒填的要另外報,不能當成 0', () => {
  const s = linenSets([r({ property_id: 'A15' }), r({ property_id: 'X' })], (id) => beds[id]);
  assert.deepEqual(s, { sets: 2, unknown: 1 });
});

test('公區與整棟可以排除在布巾之外', () => {
  const s = linenSets(
    [r({ property_id: 'A15' }), r({ property_id: 'B7' })],
    (id) => beds[id], (id) => id !== 'B7');
  assert.deepEqual(s, { sets: 2, unknown: 0 });
});

/* ── 報酬 ────────────────────────────────────── */

const points: Record<string, number | null> = {
  A15: 1,        // 時兆
  正隆4B2: 3,
  開封4F: 4,
  開封2FF2: 2,
  未設: null,
};
const pointsOf = (id: string | null) => (id ? points[id] : null);

test('★★ 報酬 = 打掃量 × 房源點數', () => {
  // 開封4F 四層樓爬上爬下就是比 A15 累,誰去掃都一樣 ——
  // 難度是房子的性質,不是人的
  const p = payroll([
    r({ property_id: 'A15' }),        // 1 間 × 1 點
    r({ property_id: '開封4F' }),      // 1 間 × 4 點
  ], pointsOf);
  const l = p.get('庭玉')!;
  assert.equal(l.units, 2);
  assert.equal(l.points, 5);
});

test('★★ 合掃時報酬也要對半', () => {
  const p = payroll([
    r({ property_id: '開封4F', staff_id: '庭玉' }),
    r({ property_id: '開封4F', staff_id: 'Una' }),
  ], pointsOf);
  assert.equal(p.get('庭玉')!.points, 2);
  assert.equal(p.get('Una')!.points, 2);
  assert.equal(p.get('庭玉')!.units, 0.5);
});

test('★★ 房源沒設點數要報,不能當成 0', () => {
  // 當成 0 的話那個人那筆白做了,而他要自己去對帳才會發現
  const p = payroll([
    r({ property_id: 'A15' }), r({ property_id: '未設' }),
  ], pointsOf);
  const l = p.get('庭玉')!;
  assert.equal(l.units, 2, '工作量照算');
  assert.equal(l.points, 1, '只有算得出來的才進點數');
  assert.equal(l.unknownPoints, 1);
});

test('沒有房源的工作點數算不出來,但工作量還是要算', () => {
  const p = payroll([r({ property_id: null, work_type: '其他工時' })], pointsOf);
  assert.equal(p.get('庭玉')!.units, 1);
  assert.equal(p.get('庭玉')!.unknownPoints, 1);
});

test('沒指派的不進任何人的帳', () => {
  assert.equal(payroll([r({ staff_id: null })], pointsOf).size, 0);
});

/* ── 顯示 ────────────────────────────────────── */

test('整數不補小數點 —— 一整排「12.00」會被當成金額', () => {
  assert.equal(fmtUnits(3), '3');
  assert.equal(fmtUnits(3.5), '3.5');
});

// ── 每日打掃量 ────────────────────────────────────

test('★ 兩人合掃同一間，當天各算 0.5', () => {
  const d = dailyUnits([
    { work_date: '2026-07-01', property_id: 'p17B5', work_type: '退房清潔', staff_id: 'una' },
    { work_date: '2026-07-01', property_id: 'p17B5', work_type: '退房清潔', staff_id: 'ting' },
  ]);
  assert.equal(d.get('2026-07-01|una'), 0.5);
  assert.equal(d.get('2026-07-01|ting'), 0.5);
});

test('一個人自己掃就是 1', () => {
  const d = dailyUnits([
    { work_date: '2026-07-03', property_id: 'p14B1', work_type: '退房清潔', staff_id: 'una' },
  ]);
  assert.equal(d.get('2026-07-03|una'), 1);
});

test('退房與入住是兩份工，同一間同一天不算合掃', () => {
  const d = dailyUnits([
    { work_date: '2026-07-05', property_id: 'pA1', work_type: '退房清潔', staff_id: 'una' },
    { work_date: '2026-07-05', property_id: 'pA1', work_type: '入住清潔', staff_id: 'ting' },
  ]);
  assert.equal(d.get('2026-07-05|una'), 1);
  assert.equal(d.get('2026-07-05|ting'), 1);
});

test('★ 逐日加起來要等於 cleanUnits 的月合計 —— 兩處必須同一套規則', () => {
  const rows = [
    { work_date: '2026-07-01', property_id: 'p1', work_type: '退房清潔', staff_id: 'una' },
    { work_date: '2026-07-01', property_id: 'p1', work_type: '退房清潔', staff_id: 'ting' },
    { work_date: '2026-07-02', property_id: 'p2', work_type: '退房清潔', staff_id: 'una' },
  ];
  const daily = dailyUnits(rows);
  let unaSum = 0;
  for (const [k, v] of daily) if (k.endsWith('|una')) unaSum += v;
  assert.equal(unaSum, cleanUnits(rows).get('una'));
});
