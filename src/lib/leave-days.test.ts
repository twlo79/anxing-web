import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  isWorkday, holidayMap, workHours, modeTimes, planDays, totals, segments, spreadWorkdays,
  leaveError, groupBatches, addDays, dow, DEFAULT_WS, spreadHours, movedStart, type DayPick,
} from './leave-days.ts';

/** 2026 年 9～10 月（照 migration_97） */
const H = holidayMap([
  { d: '2026-09-25', kind: 'holiday' }, { d: '2026-09-28', kind: 'holiday' },
  { d: '2026-10-09', kind: 'holiday' }, { d: '2026-10-10', kind: 'holiday' },
  { d: '2026-10-25', kind: 'holiday' }, { d: '2026-10-26', kind: 'holiday' },
]);

describe('isWorkday —— 跟 is_workday() 同一套', () => {
  test('平日上班', () => assert.equal(isWorkday('2026-09-24', H), true));
  test('週末不上', () => { assert.equal(isWorkday('2026-09-26', H), false); assert.equal(isWorkday('2026-09-27', H), false); });
  test('國定假日不上（中秋、教師節）', () => { assert.equal(isWorkday('2026-09-25', H), false); assert.equal(isWorkday('2026-09-28', H), false); });
  test('★ 補班日算上班，即使是週六', () => {
    const h2 = holidayMap([{ d: '2026-09-26', kind: 'makeup' }]);
    assert.equal(dow('2026-09-26'), 6);
    assert.equal(isWorkday('2026-09-26', h2), true);
  });
  test('沒有假日表也能算（只看週末）', () => assert.equal(isWorkday('2026-09-25', new Map()), true));
});

describe('workHours —— 扣午休，跟 leave_hours_between() 同一條', () => {
  test('整天 09:00～18:00 ＝ 8（不是 9）', () => assert.equal(workHours('09:00', '18:00'), 8));
  test('上午 09:00～12:30 ＝ 3.5', () => assert.equal(workHours('09:00', '12:30'), 3.5));
  test('下午 13:30～18:00 ＝ 4.5', () => assert.equal(workHours('13:30', '18:00'), 4.5));
  test('★ 跨午休 12:00～14:00 ＝ 1（扣掉 12:30～13:30）', () => assert.equal(workHours('12:00', '14:00'), 1));
  test('全部在午休裡 ＝ 0', () => assert.equal(workHours('12:30', '13:30'), 0));
  test('上班前／下班後不算', () => { assert.equal(workHours('07:00', '09:00'), 0); assert.equal(workHours('18:00', '20:00'), 0); assert.equal(workHours('08:00', '10:00'), 1); });
  test('結束早於開始 ＝ 0', () => assert.equal(workHours('15:00', '10:00'), 0));
  test('午休改 13:00～14:00 時上午變 4', () => {
    assert.equal(workHours('09:00', '13:00', { ...DEFAULT_WS, lunch_start: '13:00', lunch_end: '14:00' }), 4);
  });
  /*
   * ★★★ 這一條釘住那個 153 小時的 bug 不會回來：
   *   舊算法是「結束 − 開始」的牆上時鐘。這裡一天最多就是每日工時。
   */
  test('★★★ 一天最多 8，不可能算出 9 以上', () => {
    assert.equal(workHours('00:00', '23:59'), 8);
  });
});

describe('modeTimes / planDays', () => {
  test('四種樣子的起訖', () => {
    assert.deepEqual(modeTimes('full', DEFAULT_WS), { s: '09:00', e: '18:00' });
    assert.deepEqual(modeTimes('am', DEFAULT_WS), { s: '09:00', e: '12:30' });
    assert.deepEqual(modeTimes('pm', DEFAULT_WS), { s: '13:30', e: '18:00' });
    assert.deepEqual(modeTimes('custom', DEFAULT_WS, { mode: 'custom', start: '10:00', end: '15:00' }), { s: '10:00', e: '15:00' });
  });
  test('★ 上午半天 ＋ 下午半天 ＝ 整天', () => {
    const am = modeTimes('am', DEFAULT_WS), pm = modeTimes('pm', DEFAULT_WS);
    assert.equal(workHours(am.s, am.e) + workHours(pm.s, pm.e), workHours('09:00', '18:00'));
  });
  test('planDays 照日期排、每天帶時數', () => {
    const picks = new Map<string, DayPick>([
      ['2026-09-30', { mode: 'pm' }], ['2026-09-24', { mode: 'full' }], ['2026-09-29', { mode: 'full' }],
    ]);
    assert.deepEqual(planDays(picks).map((p) => [p.d, p.h]), [['2026-09-24', 8], ['2026-09-29', 8], ['2026-09-30', 4.5]]);
    assert.deepEqual(totals(planDays(picks)), { hours: 20.5, days: 2.56 });
  });
});

describe('segments —— 中間只隔假日算同一段', () => {
  test('9/24、9/29、9/30：中間是中秋＋週末＋教師節 → 1 段', () => {
    assert.deepEqual(segments(['2026-09-30', '2026-09-24', '2026-09-29'], H), [['2026-09-24', '2026-09-29', '2026-09-30']]);
  });
  test('9/24、9/30：中間有 9/29 是上班日 → 2 段', () => {
    assert.deepEqual(segments(['2026-09-24', '2026-09-30'], H), [['2026-09-24'], ['2026-09-30']]);
  });
  test('空的', () => assert.deepEqual(segments([], H), []));
});

describe('spreadWorkdays —— 順延不吃假', () => {
  test('從 9/24 鋪 3 天 → 9/24、9/29、9/30', () => {
    assert.deepEqual(spreadWorkdays('2026-09-24', 3, H), ['2026-09-24', '2026-09-29', '2026-09-30']);
  });
  test('起日本身是假日就往後找', () => assert.deepEqual(spreadWorkdays('2026-09-25', 1, H), ['2026-09-29']));
  test('0 天回空', () => assert.deepEqual(spreadWorkdays('2026-09-24', 0, H), []));
});

describe('leaveError —— 一次只回第一個', () => {
  const ok = planDays(new Map<string, DayPick>([['2026-09-24', { mode: 'full' }]]));
  test('沒問題回 null', () => assert.equal(leaveError(ok, H, { typeCode: 'annual', remain: 56 }), null));
  test('沒選假別', () => assert.match(leaveError(ok, H, { typeCode: '', remain: 56 })!, /假別/));
  test('沒選日子', () => assert.match(leaveError([], H, { typeCode: 'annual', remain: 56 })!, /月曆/));
  test('假日', () => {
    const p = planDays(new Map<string, DayPick>([['2026-09-25', { mode: 'full' }]]));
    assert.match(leaveError(p, H, { typeCode: 'annual', remain: 56 })!, /不是上班日/);
  });
  test('自訂時段沒有工作時數', () => {
    const p = planDays(new Map<string, DayPick>([['2026-09-24', { mode: 'custom', start: '12:30', end: '13:30' }]]));
    assert.match(leaveError(p, H, { typeCode: 'annual', remain: 56 })!, /沒有工作時數/);
  });
  test('額度不夠', () => assert.match(leaveError(ok, H, { typeCode: 'annual', remain: 4 })!, /不夠/));
  test('沒額度上限的假別（remain null）不擋', () => assert.equal(leaveError(ok, H, { typeCode: 'personal', remain: null }), null));
});

describe('groupBatches —— 同批收成一列', () => {
  const R = (o: Record<string, unknown>) => ({
    id: 'x', batch_id: null, type_code: 'annual', start_at: '2026-09-24T01:00:00Z', end_at: '2026-09-24T10:00:00Z',
    hours: 8, status: 'pending', ...o,
  });
  test('三列同 batch → 一列，時數加總、天數 3', () => {
    const g = groupBatches([
      R({ id: 'a', batch_id: 'B', start_at: '2026-09-29T01:00:00Z' }),
      R({ id: 'b', batch_id: 'B' }),
      R({ id: 'c', batch_id: 'B', start_at: '2026-09-30T05:30:00Z', hours: 4.5 }),
    ]);
    assert.equal(g.length, 1);
    assert.equal(g[0].days, 3); assert.equal(g[0].hours, 20.5);
    assert.deepEqual(g[0].rows.map((r) => r.id), ['b', 'a', 'c']);   // 同批內照日期
  });
  test('舊單沒 batch_id → 各自一列', () => {
    assert.equal(groupBatches([R({ id: 'a' }), R({ id: 'b' })]).length, 2);
  });
  test('新的在上面', () => {
    const g = groupBatches([R({ id: 'old', start_at: '2026-08-01T01:00:00Z' }), R({ id: 'new' })]);
    assert.equal(g[0].key, 'new');
  });
  test('空的不爆', () => assert.deepEqual(groupBatches([]), []));
});

describe('addDays 跨月跨年', () => {
  test('9/30 + 1 = 10/1', () => assert.equal(addDays('2026-09-30', 1), '2026-10-01'));
  test('12/31 + 1 = 隔年', () => assert.equal(addDays('2026-12-31', 1), '2027-01-01'));
});

/* ══════════════════════════════════════════════════════════
 * spreadHours —— 「起算點 ＋ 請多久」是改版後「以小時請」唯一的入口。
 *
 * ★★★ 這裡每一條都是「錯了不會報錯」：少扣半小時、多跨一天、
 *   假日沒跳過 —— 畫面上全都看起來正常，只有時數對不上，
 *   而那要等到資料庫回 HOURS_MISMATCH 才會被發現。
 * ══════════════════════════════════════════════════════════ */
describe('spreadHours —— 起算點 ＋ 時數 → 明細', () => {
  const tot = (p: readonly { h: number }[]) => Math.round(p.reduce((n, x) => n + x.h, 0) * 100) / 100;

  test('當天做得完：9/21 14:00 請 3 小時 → 14:00~17:00', () => {
    const p = spreadHours('2026-09-21', '14:00', 3, H);
    assert.equal(p.length, 1);
    assert.deepEqual([p[0].d, p[0].s, p[0].e, p[0].h], ['2026-09-21', '14:00', '17:00', 3]);
  });

  test('★ 跨午休要往後補：09:00 請 4 小時 → 14:00 收工，不是 13:00', () => {
    const p = spreadHours('2026-09-21', '09:00', 4, H);
    assert.equal(p[0].e, '14:00');
    assert.equal(tot(p), 4);
  });

  test('★ 當天不夠就溢到隔天：14:00 請 6 小時 → 4 ＋ 2', () => {
    const p = spreadHours('2026-09-21', '14:00', 6, H);
    assert.equal(p.length, 2);
    assert.deepEqual(p.map((x) => [x.d, x.h]), [['2026-09-21', 4], ['2026-09-22', 2]]);
    assert.equal(tot(p), 6);
  });

  test('★★ 中秋連假整段跳過：9/24 請 16 小時 → 9/24 ＋ 9/29', () => {
    const p = spreadHours('2026-09-24', '09:00', 16, H);
    assert.deepEqual(p.map((x) => x.d), ['2026-09-24', '2026-09-29']);
    assert.equal(tot(p), 16);
  });

  test('★★ 起算日是國定假日 → 挪到下一個上班日，而且講得出來', () => {
    const p = spreadHours('2026-09-25', '09:00', 2, H);
    assert.equal(p[0].d, '2026-09-29');
    assert.equal(movedStart('2026-09-25', p), '2026-09-29');
  });

  test('★★ 起算點卡在午休裡（12:45）→ 從 13:30 起算', () => {
    const p = spreadHours('2026-09-21', '12:45', 2, H);
    assert.deepEqual([p[0].s, p[0].e, p[0].h], ['13:30', '15:30', 2]);
  });

  test('★ 起算點早於上班時間 → 拉到 09:00，不會多給', () => {
    const p = spreadHours('2026-09-21', '07:00', 2, H);
    assert.deepEqual([p[0].s, p[0].e], ['09:00', '11:00']);
  });

  test('★ 起算點在下班後 → 整個挪到隔天', () => {
    const p = spreadHours('2026-09-21', '19:00', 2, H);
    assert.equal(p[0].d, '2026-09-22');
    assert.equal(movedStart('2026-09-21', p), '2026-09-22');
  });

  test('沒挪的時候 movedStart 回 null', () => {
    assert.equal(movedStart('2026-09-21', spreadHours('2026-09-21', '09:00', 2, H)), null);
  });

  test('半小時的粒度：請 0.5 小時', () => {
    const p = spreadHours('2026-09-21', '09:00', 0.5, H);
    assert.deepEqual([p[0].e, p[0].h], ['09:30', 0.5]);
  });

  test('時數 0 或負數回空陣列（不是丟例外）', () => {
    assert.deepEqual(spreadHours('2026-09-21', '09:00', 0, H), []);
    assert.deepEqual(spreadHours('2026-09-21', '09:00', -3, H), []);
  });

  test('日期不是 YYYY-MM-DD 回空陣列', () => {
    assert.deepEqual(spreadHours('2026/09/21' as never, '09:00', 2, H), []);
  });

  test('★ 每一列的時數都跟 workHours() 對得起來（資料庫會拿這個比）', () => {
    for (const hrs of [1, 3.5, 4, 7.5, 8, 12, 20]) {
      const p = spreadHours('2026-09-21', '10:00', hrs, H);
      assert.equal(tot(p), hrs, `請 ${hrs} 小時`);
      for (const x of p) assert.equal(x.h, workHours(x.s, x.e, DEFAULT_WS), `${x.d} ${x.s}~${x.e}`);
    }
  });
});
