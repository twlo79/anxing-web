import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  crewSize, cleanUnits, linenJobs, linenSets, payroll, byEstate, fmtUnits,
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

/* ══════════════════════════════════════════════════════════
 * 一筆等於好幾間（migration_198）
 *
 * 2026-09-01 使用者:「可以 key 房源我自己打 + 間數 | 打掃點數
 *                     舉例 無房間 0.5 | 3.5點；無房間 0 | 2點」
 * ══════════════════════════════════════════════════════════ */
describe('units_override ／ points_override', () => {
  const R = (o: Partial<PayrollRow> = {}): PayrollRow => ({
    work_date: '2026-08-14', property_id: 'p1', work_type: '清潔', staff_id: 's1', ...o,
  });
  const pts = (id: string | null) => (id === 'p1' ? 2 : null);

  test('沒填就照原本算 1 間', () => {
    assert.equal(payroll([R()], pts).get('s1')!.units, 1);
  });

  test('填 4 → 算 4 間', () => {
    assert.equal(payroll([R({ units_override: 4 })], pts).get('s1')!.units, 4);
  });

  /*
   * ★★★ `|| 1` 會把 0 變成 1。而「這一筆不算間數、只記點數」
   *   是使用者明確講的一種輸入。
   */
  test('★★★ 填 0 就是 0 間，不會變成 1', () => {
    const l = payroll([R({ property_id: null, units_override: 0, points_override: 2 })], pts).get('s1')!;
    assert.equal(l.units, 0);
    assert.equal(l.points, 2);
  });

  test('★ 使用者的例子：無房間 0.5 間 ／ 3.5 點', () => {
    const l = payroll([R({ property_id: null, units_override: 0.5, points_override: 3.5 })], pts).get('s1')!;
    assert.equal(l.units, 0.5);
    assert.equal(l.points, 3.5);
    // ★ 手填了點數就不算「未計」—— 那正是這個欄位要消滅的東西
    assert.equal(l.unknownPoints, 0);
  });

  /*
   * ★★ 合掃要除以人數，而且是在 override **之後**除。
   *   順序顛倒的話合掃的量會翻倍，而總數看起來只是「多一點」。
   */
  test('★★ 4 間兩個人做 → 各 2 間', () => {
    const rows = [R({ units_override: 4 }), R({ units_override: 4, staff_id: 's2' })];
    const out = payroll(rows, pts);
    assert.equal(out.get('s1')!.units, 2);
    assert.equal(out.get('s2')!.units, 2);
  });

  /*
   * ★★★ 手填的點數是**這一列的總點數** —— 除人數，但不再乘間數。
   *   乘下去的話「4 間 8 點」會變成 32 點。
   */
  test('★★★ 手填點數不再乘間數', () => {
    const l = payroll([R({ units_override: 4, points_override: 8 })], pts).get('s1')!;
    assert.equal(l.units, 4);
    assert.equal(l.points, 8);
  });

  test('★★ 手填點數兩個人做 → 各一半', () => {
    const rows = [R({ points_override: 8 }), R({ points_override: 8, staff_id: 's2' })];
    assert.equal(payroll(rows, pts).get('s1')!.points, 4);
  });

  test('只填間數、沒填點數 → 照房源算', () => {
    const l = payroll([R({ units_override: 3 })], pts).get('s1')!;
    assert.equal(l.points, 6);      // 3 間 × 2 點
    assert.equal(l.unknownPoints, 0);
  });

  test('沒房源又沒填點數 → 進未計', () => {
    const l = payroll([R({ property_id: null, units_override: 2 })], pts).get('s1')!;
    assert.equal(l.units, 2);
    assert.equal(l.unknownPoints, 1);
  });
});

/*
 * ★★★ 2026-09-02 使用者:「可以看出各物業 的清潔間數 跟點數」。
 *
 *   排班統計頁上「Una 27 間、庭玉 30 間」與「各物業合計 57 間」
 *   會同時出現在同一個畫面。對不起來的話兩個數字都失去意義 ——
 *   所以下面第一條測的就是那個恆等式。
 */
describe('byEstate —— 各物業的間數與點數', () => {
  const P = (o: Partial<PayrollRow> = {}): PayrollRow => ({
    work_date: '2026-08-03', property_id: 'p1', work_type: '清潔', staff_id: 's1', ...o,
  });
  const est: Record<string, string> = { p1: '時兆', p2: '時兆', p3: '正隆' };
  const pts: Record<string, number> = { p1: 3, p2: 3, p3: 4 };
  const pointsOf = (id: string | null) => (id ? pts[id] : null) ?? null;
  const estateOf = (id: string | null) => (id ? est[id] : null) ?? null;

  test('★★★ 各物業的總和 = 每人合計的總和', () => {
    const rows = [
      P(), P({ property_id: 'p2' }), P({ property_id: 'p3', staff_id: 's2' }),
      P({ property_id: 'p3', staff_id: 's1' }),                    // 與 s2 合掃
      P({ property_id: null, points_override: 8, staff_id: 's2' }),
    ];
    const byE = byEstate(rows, pointsOf, estateOf);
    const byS = [...payroll(rows, pointsOf).values()];
    const sum = (a: { units: number; points: number }[], k: 'units' | 'points') =>
      Math.round(a.reduce((t, x) => t + x[k], 0) * 100) / 100;
    assert.equal(sum(byE, 'units'), sum(byS, 'units'));
    assert.equal(sum(byE, 'points'), sum(byS, 'points'));
  });

  test('同一個物業的兩間會合起來', () => {
    const out = byEstate([P(), P({ property_id: 'p2' })], pointsOf, estateOf);
    assert.equal(out.length, 1);
    assert.deepEqual([out[0].estate, out[0].units, out[0].points], ['時兆', 2, 6]);
  });

  test('合掃的除以人數 —— 兩人掃一間各 0.5,物業還是算 1 間', () => {
    const out = byEstate([P(), P({ staff_id: 's2' })], pointsOf, estateOf);
    assert.equal(out[0].units, 1);
    assert.equal(out[0].points, 3);
  });

  test('間數 override：一筆等於四間', () => {
    const out = byEstate([P({ property_id: 'p3', units_override: 4 })], pointsOf, estateOf);
    assert.deepEqual([out[0].estate, out[0].units, out[0].points], ['正隆', 4, 16]);
  });

  /*
   * ★★ 手填的點數是這一列的總點數,不再乘間數（跟 payroll 同一條規則）。
   *   乘下去的話「4 間 8 點」會變成 32 點。
   */
  test('★★ 點數 override 不乘間數', () => {
    const out = byEstate([P({ units_override: 4, points_override: 8 })], pointsOf, estateOf);
    assert.equal(out[0].points, 8);
    assert.equal(out[0].units, 4);
  });

  /*
   * ★★★ 沒有物業的那些**不能藏起來**。藏了的話各物業加起來會少一截,
   *   而少的那一截沒有任何地方交代得出來。
   */
  test('★★★ 查不到物業的歸成一條 estate: null', () => {
    const out = byEstate([P({ property_id: null, points_override: 8 })], pointsOf, estateOf);
    assert.equal(out.length, 1);
    assert.equal(out[0].estate, null);
    assert.equal(out[0].points, 8);
  });

  test('★★ 無房源那條一律排最後,不管點數多高', () => {
    const out = byEstate([
      P({ property_id: null, points_override: 999 }),
      P({ property_id: 'p3', staff_id: 's2' }),
    ], pointsOf, estateOf);
    assert.deepEqual(out.map((x) => x.estate), ['正隆', null]);
  });

  test('其餘照點數由多到少', () => {
    const out = byEstate([
      P(), P({ property_id: 'p3', staff_id: 's2', units_override: 5 }),
    ], pointsOf, estateOf);
    assert.deepEqual(out.map((x) => x.estate), ['正隆', '時兆']);
  });

  test('房源查不到點數 → 進 unknownPoints,不當成 0', () => {
    const out = byEstate([P({ property_id: 'p9' })], pointsOf, () => '南京');
    assert.equal(out[0].unknownPoints, 1);
    assert.equal(out[0].points, 0);
  });

  test('沒指派的人不算', () => {
    assert.deepEqual(byEstate([P({ staff_id: null })], pointsOf, estateOf), []);
  });

  test('空清單不會爆', () => assert.deepEqual(byEstate([], pointsOf, estateOf), []));
});
