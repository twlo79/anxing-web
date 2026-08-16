import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  yearRange, monthRange, lastDayOf, prevPeriod, lastYearPeriod,
  yoySameAsPrev, growth, partialMonth, sameMonthRange,
} from './compare.ts';

/**
 * 儀表板期間與比較的測試。跑法:npm test
 *
 * 期間算錯不會報錯,只會給一個看起來合理但錯誤的成長率 ——
 * 那比壞掉更危險,因為沒有人會去懷疑它。
 */

describe('期間產生', () => {
  test('整年', () => {
    assert.deepEqual(yearRange(2026), ['2026-01-01', '2026-12-31']);
  });

  test('整月 —— 月底天數要正確', () => {
    assert.deepEqual(monthRange(2026, 8), ['2026-08-01', '2026-08-31']);
    assert.deepEqual(monthRange(2026, 2), ['2026-02-01', '2026-02-28']);
    assert.deepEqual(monthRange(2024, 2), ['2024-02-01', '2024-02-29'], '閏年');
    assert.deepEqual(monthRange(2026, 4), ['2026-04-01', '2026-04-30']);
  });

  test('月底不能寫死 31 —— 四月只有 30 天', () => {
    assert.equal(lastDayOf(2026, 4), '2026-04-30');
    assert.equal(lastDayOf(2026, 12), '2026-12-31');
  });
});

describe('環比(上一期)', () => {
  test('月 → 上個月', () => {
    assert.deepEqual(prevPeriod('month', '2026-08-01', '2026-08-31'), ['2026-07-01', '2026-07-31']);
  });

  test('一月的上一期要退到去年十二月', () => {
    assert.deepEqual(prevPeriod('month', '2026-01-01', '2026-01-31'), ['2025-12-01', '2025-12-31']);
  });

  test('年 → 上一年', () => {
    assert.deepEqual(prevPeriod('year', '2026-01-01', '2026-12-31'), ['2025-01-01', '2025-12-31']);
  });

  test('自訂區間用天數往前推,長度要一樣', () => {
    // 7 天 → 前面緊鄰的 7 天。用月數推會產生長度不同的兩段,成長率就沒意義。
    assert.deepEqual(prevPeriod('custom', '2026-08-08', '2026-08-14'), ['2026-08-01', '2026-08-07']);
  });
});

describe('同比(去年同期)', () => {
  test('月 → 去年同月', () => {
    assert.deepEqual(lastYearPeriod('month', '2026-08-01', '2026-08-31'), ['2025-08-01', '2025-08-31']);
  });

  test('二月同比:今年 28 天、去年也要是該年的實際天數', () => {
    assert.deepEqual(lastYearPeriod('month', '2025-02-01', '2025-02-28'), ['2024-02-01', '2024-02-29'],
      '2024 是閏年');
  });

  test('年模式下環比與同比是同一段', () => {
    assert.deepEqual(
      lastYearPeriod('year', '2026-01-01', '2026-12-31'),
      prevPeriod('year', '2026-01-01', '2026-12-31'));
    assert.ok(yoySameAsPrev('year'));
    assert.ok(!yoySameAsPrev('month'));
  });

  test('自訂區間整段平移一年', () => {
    assert.deepEqual(lastYearPeriod('custom', '2026-03-15', '2026-06-20'), ['2025-03-15', '2025-06-20']);
  });
});

describe('成長率', () => {
  test('一般情況', () => {
    assert.equal(growth(110, 100), 10);
    assert.equal(growth(90, 100), -10);
  });

  test('比較期是 0 要回 null,不能是 Infinity', () => {
    // 除以零在畫面上會變成「▲ Infinity%」
    assert.equal(growth(500, 0), null);
    assert.equal(growth(0, 0), null);
  });

  test('比較期是負數(折讓)時用絕對值當分母,方向才不會反過來', () => {
    assert.equal(growth(-50, -100), 50, '虧損從 100 減到 50 是改善,不是 -50%');
  });
});

describe('未走完的月份', () => {
  const aug6 = new Date(2026, 7, 6);   // 2026-08-06

  test('期間含本月時要標出來', () => {
    assert.deepEqual(partialMonth('2026-08-31', aug6), { passed: 6, total: 31 });
  });

  test('期間在本月之前就沒事', () => {
    assert.equal(partialMonth('2026-07-31', aug6), null);
  });

  test('今天剛好是月底就算走完', () => {
    assert.equal(partialMonth('2026-08-31', new Date(2026, 7, 31)), null);
  });
});

/* ── 比較期的重複查詢（2026-08-15 實測） ────────── */

test('★★ 近 12 個月：環比與同比換算成月份是同一段', () => {
  // 這就是儀表板把同一支查詢跑兩次的原因 ——
  // 日期差幾天，但 revenue_recognitions 是按 ym 存的，看不出差別
  const cur: [string, string] = ['2025-09-01', '2026-08-16'];
  const prev = prevPeriod('custom', cur[0], cur[1]);
  const yoy = lastYearPeriod('custom', cur[0], cur[1]);
  assert.equal(sameMonthRange(prev, yoy), true);
});

test('★ 短區間就不是同一段,不能省', () => {
  const cur: [string, string] = ['2026-08-01', '2026-08-16'];
  const prev = prevPeriod('custom', cur[0], cur[1]);   // 7 月中~7 月底
  const yoy = lastYearPeriod('custom', cur[0], cur[1]); // 去年 8 月
  assert.equal(sameMonthRange(prev, yoy), false);
});

test('月模式的環比與同比不同月', () => {
  assert.equal(sameMonthRange(prevPeriod('month', '2026-08-01', '2026-08-31'),
    lastYearPeriod('month', '2026-08-01', '2026-08-31')), false);
});

test('★ 年模式兩者本來就相同', () => {
  assert.equal(sameMonthRange(prevPeriod('year', '2026-01-01', '2026-12-31'),
    lastYearPeriod('year', '2026-01-01', '2026-12-31')), true);
});
