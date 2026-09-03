import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  cleaningCosts, laborCosts, lastDayOf, costTotal,
  type LaborCost, cleanItemName, LABOR_ITEM_NAME,
} from './hk-cost.ts';
import { estateLog, type PayrollRow, type LogEntry } from './hk-payroll.ts';

const J = (o: Partial<LogEntry> = {}): LogEntry => ({
  work_date: '2026-08-03', work_type: '清潔', property_id: 'p1',
  label: 'A01', staffIds: ['s1'], units: 1, points: 1, unknownPoints: 0, ...o,
});

const price: Record<string, number> = { p1: 730, p2: 9000, p3: 0 };
const priceOf = (id: string) => price[id] ?? null;

describe('cleaningCosts —— 一份工一筆', () => {
  test('間數 × 單價', () => {
    const { rows } = cleaningCosts([J()], priceOf);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].amount, 730);
  });

  /*
   * ★★★ 這是整支最重要的一條（2026-09-02 使用者確認「一份（房間只被清一次）」）。
   *
   *   `estateLog` 已經把合掃的兩筆合成一列、units 加回 1，
   *   所以這裡拿到的就是一份工 —— 正隆一間合掃是 9,000 不是 18,000。
   */
  test('★★★ 合掃只付一份 —— 從原始資料一路算過來', () => {
    const P = (o: Partial<PayrollRow> = {}): PayrollRow => ({
      work_date: '2026-08-03', property_id: 'p2', work_type: '清潔',
      staff_id: 's1', label: '4B1', ...o,
    });
    const log = estateLog([P(), P({ staff_id: 's2' })],   // 兩個人合掃同一間
      () => 1, () => '正隆');
    const jobs = [...log.values()].flat();
    const { rows } = cleaningCosts(jobs, priceOf);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].units, 1);
    assert.equal(rows[0].amount, 9000);        // ★ 不是 18000
  });

  /*
   * ★★ 「一筆等於好幾間」要乘進去（migration_198 的 units_override）。
   *   正隆整棟一次 4 間 = 4 × 9,000。
   */
  test('★★ units_override 要乘', () => {
    const { rows } = cleaningCosts([J({ property_id: 'p2', units: 4 })], priceOf);
    assert.equal(rows[0].amount, 36000);
  });

  test('合掃 ＋ override：4 間兩人做，還是 4 份', () => {
    const P = (o: Partial<PayrollRow> = {}): PayrollRow => ({
      work_date: '2026-08-03', property_id: 'p2', work_type: '清潔',
      staff_id: 's1', units_override: 4, ...o,
    });
    const log = estateLog([P(), P({ staff_id: 's2' })], () => 1, () => '正隆');
    const { rows } = cleaningCosts([...log.values()].flat(), priceOf);
    assert.equal(rows[0].units, 4);
    assert.equal(rows[0].amount, 36000);
  });

  /*
   * ★★★ 算不出錢的**不能當成 0** —— 支出頁看到一筆 $0
   *   只會被當成「還沒填」，而帳實際上少了一截。
   */
  test('★★★ 沒有房源 → 進 unpriced，不產生支出', () => {
    const { rows, unpriced } = cleaningCosts(
      [J({ property_id: null, label: '' })], priceOf);
    assert.equal(rows.length, 0);
    assert.equal(unpriced.length, 1);
    assert.equal(unpriced[0].reason, '沒有房源');
    assert.equal(unpriced[0].label, '（沒填房源）');
  });

  test('★★★ 沒設單價 → 進 unpriced', () => {
    const { rows, unpriced } = cleaningCosts([J({ property_id: 'p9' })], priceOf);
    assert.equal(rows.length, 0);
    assert.equal(unpriced[0].reason, '沒設單價');
  });

  // ★ 單價 0 是「免費」不是「沒設」—— 但記一筆 $0 只是雜訊，所以不產生
  test('單價 0 不產生，也不算 unpriced', () => {
    const { rows, unpriced } = cleaningCosts([J({ property_id: 'p3' })], priceOf);
    assert.equal(rows.length, 0);
    assert.equal(unpriced.length, 0);
  });

  test('★★ 冪等鍵 = 日期|房源|工作類型', () => {
    const { rows } = cleaningCosts([J()], priceOf);
    assert.equal(rows[0].key, '2026-08-03|p1|清潔');
  });

  test('同一天同一間不同工作類型 → 兩筆、鍵不同', () => {
    const { rows } = cleaningCosts([J(), J({ work_type: '加強清潔' })], priceOf);
    assert.equal(rows.length, 2);
    assert.notEqual(rows[0].key, rows[1].key);
  });

  test('0.5 間會四捨五入到元', () => {
    const { rows } = cleaningCosts([J({ units: 0.5 })], priceOf);
    assert.equal(rows[0].amount, 365);
  });

  test('空清單不會爆', () => {
    assert.deepEqual(cleaningCosts([], priceOf), { rows: [], unpriced: [] });
  });
});

describe('lastDayOf —— 人事費放月底最後一天', () => {
  test('大小月', () => {
    assert.equal(lastDayOf('202608'), '2026-08-31');
    assert.equal(lastDayOf('202609'), '2026-09-30');
  });
  // ★ 閏年不自己判斷 —— new Date(y, m, 0) 會處理
  test('二月與閏年', () => {
    assert.equal(lastDayOf('202602'), '2026-02-28');
    assert.equal(lastDayOf('202402'), '2024-02-29');
  });
  test('十二月不會跨年出錯', () => assert.equal(lastDayOf('202612'), '2026-12-31'));
  test('亂七八糟的回空字串,不要回一個看起來像日期的東西', () => {
    assert.equal(lastDayOf(''), '');
    assert.equal(lastDayOf('2026'), '');
    assert.equal(lastDayOf('202613'), '');
    assert.equal(lastDayOf('2026-08'), '');
  });
});

describe('laborCosts —— 一個月一個對象一筆', () => {
  const C = (o: Partial<LaborCost> = {}): LaborCost => ({
    id: 'c1', estate_id: 'e1', property_id: null, monthly_amount: 200000, ...o,
  });

  test('物業層級', () => {
    const out = laborCosts([C()], '202608');
    assert.equal(out.length, 1);
    assert.deepEqual([out[0].spent_on, out[0].amount, out[0].key],
      ['2026-08-31', 200000, '202608|e1']);
  });

  test('房源層級', () => {
    const out = laborCosts([C({ estate_id: null, property_id: 'p1', monthly_amount: 12000 })], '202608');
    assert.equal(out[0].key, '202608|p1');
    assert.equal(out[0].property_id, 'p1');
    assert.equal(out[0].estate_id, null);
  });

  /*
   * ★ 停用的不再產生，但既有支出不刪 —— 錢付了就是付了。
   *   （刪除的那半在資料庫的 comment 裡寫著，不是這支的責任。）
   */
  test('★ 停用的不產生', () => {
    assert.deepEqual(laborCosts([C({ active: false })], '202608'), []);
  });

  test('金額 0 或負數不產生', () => {
    assert.deepEqual(laborCosts([C({ monthly_amount: 0 })], '202608'), []);
    assert.deepEqual(laborCosts([C({ monthly_amount: -1 })], '202608'), []);
  });

  test('兩個對象都空的壞資料跳過,不要爆', () => {
    assert.deepEqual(laborCosts([C({ estate_id: null, property_id: null })], '202608'), []);
  });

  test('月份不合法就什麼都不產生', () => {
    assert.deepEqual(laborCosts([C()], '2026'), []);
  });

  test('六筆種子合計 248,000', () => {
    const rows = laborCosts([
      C({ id: '1', estate_id: null, property_id: 'p1', monthly_amount: 4000 }),
      C({ id: '2', estate_id: null, property_id: 'p2', monthly_amount: 12000 }),
      C({ id: '3', estate_id: null, property_id: 'p3', monthly_amount: 8000 }),
      C({ id: '4', estate_id: null, property_id: 'p4', monthly_amount: 12000 }),
      C({ id: '5', estate_id: null, property_id: 'p5', monthly_amount: 12000 }),
      C({ id: '6', monthly_amount: 200000 }),
    ], '202608');
    assert.equal(rows.length, 6);
    assert.equal(costTotal(rows), 248000);
  });
});

describe('cleanItemName —— 畫面與寫入用同一支（2026-09-03）', () => {
  test('一間就不印倍數', () => {
    assert.equal(cleanItemName('1485', 1), '房務清潔 1485');
  });
  test('多間才印', () => {
    assert.equal(cleanItemName('正隆整棟', 4), '房務清潔 正隆整棟 ×4');
  });
  // ★ 合掃是 0.5 —— 不能被四捨五入成 0 或 1
  test('合掃的 0.5 印得出來', () => {
    assert.equal(cleanItemName('1485', 0.5), '房務清潔 1485 ×0.5');
  });
  // ★ 0.30000000000000004 這種浮點尾巴不可以跑到畫面上
  test('浮點尾巴要收乾淨', () => {
    assert.equal(cleanItemName('A', 0.1 + 0.2), '房務清潔 A ×0.3');
  });
  test('label 空的時候不留下尾巴空白', () => {
    assert.equal(cleanItemName('', 1), '房務清潔');
  });
  test('人事費沒有括號', () => {
    assert.equal(LABOR_ITEM_NAME, '房務人事費');
  });
});
