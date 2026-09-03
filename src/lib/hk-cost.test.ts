import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  cleaningCosts, laborCosts, lastDayOf, costTotal,
  type LaborCost, cleanItemName, LABOR_ITEM_NAME,
} from './hk-cost.ts';
import { estateLog, type PayrollRow, type LogEntry } from './hk-payroll.ts';
import { indexSplits, type SplitLine } from './work-split.ts';

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

  /*
   * ══════════ 拆帳:一份工記到好幾間 ══════════
   * （2026-09-03 使用者:「我想要在表單上呈現一項 然後支出拆成多間」）
   */
  const S = (o: Partial<SplitLine> = {}): SplitLine => ({
    id: 'x1', work_date: '2026-08-14', job_code: '正隆多間',
    work_type: '清潔', property_id: 'p2', amount: 1500, ...o,
  });
  /** 08-14 庭玉的「正隆多間」:三間各 1,500 */
  const zhenglong = () => indexSplits([
    S({ id: 'a', property_id: 'r1', property_label: '4B3' }),
    S({ id: 'b', property_id: 'r2', property_label: '13A5' }),
    S({ id: 'c', property_id: 'r3', property_label: '14B1' }),
  ]);
  const multiJob = (o: Partial<LogEntry> = {}) => J({
    work_date: '2026-08-14', property_id: null, label: '正隆多間',
    units: 0.5, ...o,
  });

  /*
   * ★★★ 拆帳的整個重點:「正隆多間」不在房源主檔，沒有 property_id、
   *   查不到任何單價。沒有拆帳的話它會整筆掉進 unpriced 而帳少 4,500。
   */
  test('★★★ 沒有房源也算得出錢 —— 拆帳三筆各 1,500', () => {
    const { rows, unpriced } = cleaningCosts([multiJob()], priceOf, zhenglong());
    assert.equal(rows.length, 3);
    assert.equal(unpriced.length, 0, '拆過的不該再進「算不出錢」');
    assert.equal(costTotal(rows), 4500);
    assert.deepEqual(rows.map((r) => r.property_id), ['r1', 'r2', 'r3']);
  });

  /*
   * ★★★ 冪等鍵不能是「日期|房源|類型」—— 同一天同一間如果另有
   *   一份正常工單就會撞成同一個鍵，而 hk_job_key 有唯一索引:
   *   第二筆被安靜地跳過，帳少一筆而畫面上完全正常。
   */
  test('★★★ 拆帳的鍵是 split:<id>，不會跟一般工單撞', () => {
    const { rows } = cleaningCosts([multiJob()], priceOf, zhenglong());
    assert.deepEqual(rows.map((r) => r.key), ['split:a', 'split:b', 'split:c']);
    // 同一天同一間 r1 另有一份正常工單 —— 兩個鍵必須不同
    const solo = cleaningCosts(
      [J({ work_date: '2026-08-14', property_id: 'r1' })], () => 9000);
    assert.equal(solo.rows.length, 1);
    assert.notEqual(solo.rows[0].key, 'split:a');
  });

  /*
   * ★★ 拆的是錢不是工作量。母列還是 0.5 間 ——
   *   拆帳列的 units 寫 0 並標 fixedAmount，畫面才不會印
   *   「0.5 × $0」這種算不出 1,500 的算式。
   */
  test('★★ 拆帳列不帶間數與單價，標成人工指定', () => {
    const { rows } = cleaningCosts([multiJob()], priceOf, zhenglong());
    for (const r of rows) {
      assert.equal(r.units, 0);
      assert.equal(r.price, 0);
      assert.equal(r.fixedAmount, true);
      assert.equal(r.splitOf, '正隆多間', '要認得回是從哪一份工拆的');
    }
    assert.equal(cleanItemName(rows[0].label, rows[0].units, rows[0].fixedAmount),
      '房務清潔 4B3', '不印 ×N');
  });

  // ★ 有單價的房源被拆時，也不走公式 —— 人填的金額說了算
  test('★ 拆過就不查單價，即使那一份工本來算得出錢', () => {
    const { rows } = cleaningCosts(
      [J({ work_date: '2026-08-14', property_id: 'p2', label: '正隆多間' })],
      priceOf, zhenglong());
    assert.equal(rows.length, 3);
    assert.equal(costTotal(rows), 4500, '不是 9,000');
  });

  /*
   * ★ 人明確填 0 是「這一間這次不用錢」。略過的話那一間
   *   會從清單上消失，而合計看起來還是對的。
   */
  test('★ 拆帳列的 0 照樣產生 —— 跟「算出來剛好是 0」不同', () => {
    const m = indexSplits([S({ id: 'a', property_id: 'r1', amount: 0 })]);
    const { rows } = cleaningCosts([multiJob()], priceOf, m);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].amount, 0);
  });

  test('沒拆的工單完全不受影響', () => {
    const { rows } = cleaningCosts([J()], priceOf, zhenglong());
    assert.equal(rows.length, 1);
    assert.equal(rows[0].key, '2026-08-03|p1|清潔');
    assert.equal(rows[0].amount, 730);
  });

  test('不傳第三個參數時行為跟以前一樣', () => {
    const { rows, unpriced } = cleaningCosts([multiJob()], priceOf);
    assert.equal(rows.length, 0);
    assert.equal(unpriced[0].reason, '沒有房源');
  });

  /*
   * ★★ 合掃是兩列 hk_work_item、一份工。拆帳綁在「工」上，
   *   所以合掃的那份工拆完還是三筆，不是六筆。
   */
  test('★★ 合掃的那份工拆完還是三筆，不是六筆', () => {
    const P = (o: Partial<PayrollRow> = {}): PayrollRow => ({
      work_date: '2026-08-14', property_id: null, label: '正隆多間',
      work_type: '清潔', staff_id: 's1', units_override: 0.5, ...o,
    });
    const log = estateLog([P(), P({ staff_id: 's2' })], () => 1, () => '正隆');
    const { rows } = cleaningCosts([...log.values()].flat(), priceOf, zhenglong());
    assert.equal(rows.length, 3);
    assert.equal(costTotal(rows), 4500);
  });

  // ★ unpriced 要帶 work_type，畫面才組得出鍵去開拆帳
  test('★ 算不出錢的那些帶得出工作類型', () => {
    const { unpriced } = cleaningCosts([multiJob()], priceOf);
    assert.equal(unpriced[0].work_type, '清潔');
  });

  /*
   * ★★★ 顯示字與存回去的字**不能是同一支**。
   *
   *   沒填房源時 `label` 顯示成「（沒填房源）」。畫面若拿那四個字
   *   去存 `job_code`，`splitJobKey` 就對不上（它用的是原始的空字串）——
   *   症狀是「拆完存好了，但支出完全沒變」，沒有任何錯誤訊息。
   *   跟 2026-09-02 那次 `'2026-08-20'.startsWith('202608')` 同一種病。
   */
  test('★★★ job_code 是原始字樣，label 才是顯示用的', () => {
    const { unpriced } = cleaningCosts([J({ property_id: null, label: '' })], priceOf);
    assert.equal(unpriced[0].label, '（沒填房源）', '顯示用');
    assert.equal(unpriced[0].job_code, '', '存回去用 —— 空的就是空的');
  });

  test('★★★ 拆帳列的 splitOf 也是原始字樣，不是顯示字', () => {
    const m = indexSplits([{
      id: 'a', work_date: '2026-08-14', job_code: '', work_type: '清潔',
      property_id: 'r1', amount: 1500,
    }]);
    const { rows } = cleaningCosts(
      [J({ work_date: '2026-08-14', property_id: null, label: '' })], priceOf, m);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].splitOf, '');
    assert.equal(rows[0].fromSplit, true, '★ 用 fromSplit 判斷，不要判斷 splitOf 是不是空字串');
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

describe('amount_override —— 直接指定金額（migration_215，2026-09-03）', () => {
  const J = (o: any = {}) => ({
    work_date: '2026-08-14', work_type: '清潔', property_id: 'p1',
    label: '4B3', staffIds: ['s1'], units: 0.17, points: 0, unknownPoints: 0, ...o,
  });
  const price = () => 9000;

  /*
   * ★★★ 這是這個欄位存在的理由:9000/6 = 1,500，
   *   而 1/6 用兩位小數的間數表達不出來（0.17 × 9000 = 1,530）。
   */
  test('★★★ 有覆寫就用覆寫，不用間數 × 單價', () => {
    const { rows } = cleaningCosts([J({ amountOverride: 1500 })], price);
    assert.equal(rows[0].amount, 1500, '不是 0.17 × 9000 = 1530');
    assert.equal(rows[0].fixedAmount, true);
  });

  test('沒覆寫就照公式', () => {
    const { rows } = cleaningCosts([J()], price);
    assert.equal(rows[0].amount, 1530);
    assert.equal(rows[0].fixedAmount, false);
  });

  // ★ null 與 undefined 都是「沒覆寫」，0 才是「這份工不用錢」
  test('★ 覆寫成 0 是真的 0，不是「沒覆寫」', () => {
    assert.equal(cleaningCosts([J({ amountOverride: null })], price).rows[0].amount, 1530);
    assert.equal(cleaningCosts([J({ amountOverride: undefined })], price).rows[0].amount, 1530);
    // 金額 0 的不產生支出（既有規則），所以這裡會被濾掉
    assert.equal(cleaningCosts([J({ amountOverride: 0 })], price).rows.length, 0);
  });

  /*
   * ★★ 沒設單價的房源，只要有覆寫金額就該算得出來 ——
   *   「這份工要付多少」是人講的，不需要單價。
   */
  test('★★ 沒設單價但有覆寫 → 還是算得出來', () => {
    const { rows, unpriced } = cleaningCosts([J({ amountOverride: 1500 })], () => null);
    assert.equal(unpriced.length, 0, '不該被列進算不出錢');
    assert.equal(rows[0]?.amount, 1500);
  });

  test('★★★ 項目名稱不印 ×N —— 印了會跟金額對不起來', () => {
    assert.equal(cleanItemName('4B3', 0.17, true), '房務清潔 4B3');
    assert.equal(cleanItemName('4B3', 0.17, false), '房務清潔 4B3 ×0.17');
  });
});
