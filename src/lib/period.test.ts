import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ymOf, ymShow, ymMonth, monthsAgo, todayStr, fmtDate, fmtDateShort, fmtAt, fmtRange } from './period.ts';

/**
 * 期間與日期格式的測試。
 *
 * 跑法：npm test
 *
 * 這支存在的原因很具體：財務儀表板上線當天營收顯示 0，
 * 實際上那個月有 124 筆認列、八百多萬。查詢把 ym 當成 'YYYY-MM' 比，
 * 但那一欄存的是 'YYYYMM'，而且**不會報錯**，只會安靜地回空集合。
 *
 * 底下第一組測試就是釘住那件事的。
 */

describe('認列月份格式（YYYYMM，不是 YYYY-MM）', () => {
  test('日期換算成認列月份', () => {
    assert.equal(ymOf('2026-08-15'), '202608');
    assert.equal(ymOf('2026-08-01'), '202608');
    assert.equal(ymOf('2026-12-31'), '202612');
    assert.equal(ymOf('2027-01-01'), '202701');
  });

  test('絕對不能回傳帶連字號的格式', () => {
    // 這是那次事故的核心。'2026-08' 拿去跟資料庫的 '202608' 比，
    // gte 會成立、lte 不會成立，整個區間被排除，畫面顯示營收 0。
    assert.ok(!ymOf('2026-08-15').includes('-'), 'ym 不能有連字號');
    assert.equal(ymOf('2026-08-15').length, 6);
  });

  test('字串比較的方向要正確 —— 這是當初出錯的地方', () => {
    const from = ymOf('2026-08-01');
    const to = ymOf('2026-08-31');
    const stored = '202608';
    assert.ok(stored >= from && stored <= to, '同月份的認列必須落在區間內');

    // 反面示範：舊的寫法會讓同一筆資料同時「大於起」又「不小於迄」
    const badFrom = '2026-08', badTo = '2026-08';
    assert.ok(stored >= badFrom, '這行成立');
    assert.ok(!(stored <= badTo), '這行不成立 —— 所以整個區間撈不到東西');
  });

  test('跨年區間', () => {
    const from = ymOf('2025-11-01');
    const to = ymOf('2026-02-28');
    ['202511', '202512', '202601', '202602'].forEach((m) => {
      assert.ok(m >= from && m <= to, `${m} 應該落在區間內`);
    });
    ['202510', '202603'].forEach((m) => {
      assert.ok(!(m >= from && m <= to), `${m} 不該落在區間內`);
    });
  });

  test('顯示格式只給畫面用', () => {
    assert.equal(ymShow('202608'), '2026-08');
    assert.equal(ymMonth('202608'), '08');
  });
});

describe('往前推月份', () => {
  test('推 0 個月是本月月初', () => {
    assert.equal(monthsAgo(0, new Date(2026, 7, 15)), '2026-08-01');
  });

  test('跨年往回推', () => {
    assert.equal(monthsAgo(11, new Date(2026, 7, 5)), '2025-09-01');
    assert.equal(monthsAgo(1, new Date(2026, 0, 20)), '2025-12-01');
  });

  test('月底不會溢位到下個月', () => {
    // 3/31 直接減一個月,JS 會算成 2/31 然後溢位到 3/3。
    // 先 setDate(1) 再減月份才不會中。
    assert.equal(monthsAgo(1, new Date(2026, 2, 31)), '2026-02-01');
    assert.equal(monthsAgo(1, new Date(2026, 4, 31)), '2026-04-01');
  });

  test('用本地時區,不是 UTC', () => {
    // toISOString() 是 UTC。台灣 +8,凌晨 0~8 點會回傳前一天,
    // 「本月」的起日就會少一天。這裡用本地日期。
    const earlyMorning = new Date(2026, 7, 1, 3, 0, 0);
    assert.equal(todayStr(earlyMorning), '2026-08-01');
    assert.equal(monthsAgo(0, earlyMorning), '2026-08-01');
  });
});

describe('顯示格式', () => {
  test('日期一律用斜線 —— 全站統一 YYYY/MM/DD', () => {
    // 資料庫存 ISO 的 2026-08-15，畫面顯示 2026/08/15。
    // 兩種寫法分得出「這是顯示值」還是「這是查得動的值」。
    assert.equal(fmtDate('2026-08-15'), '2026/08/15');
    assert.equal(fmtDate('2026-08-15T10:30:00Z'), '2026/08/15');
    assert.equal(fmtDateShort('2026-08-15'), '08/15');
  });

  test('時間戳', () => {
    assert.equal(fmtAt('2026-08-15T10:30:00+00:00'), '08/15 10:30');
  });

  test('日期區間', () => {
    assert.equal(fmtRange('2026-08-01', '2026-08-31'), '2026/08/01 ~ 2026/08/31');
    assert.equal(fmtRange('2026-08-01', null), '2026/08/01 起');
    assert.equal(fmtRange(null, '2026-08-31'), '至 2026/08/31');
    assert.equal(fmtRange(null, null), '全部期間');
  });

  test('空值一律顯示破折號,不要露出 null', () => {
    [null, undefined, ''].forEach((v) => {
      assert.equal(fmtDate(v), '—');
      assert.equal(fmtDateShort(v), '—');
      assert.equal(fmtAt(v), '—');
    });
  });
});
