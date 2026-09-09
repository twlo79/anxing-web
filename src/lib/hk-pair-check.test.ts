import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { pairCheck } from './hk-pair-check.ts';
import {
  cleaningIncome, laborIncome, CODE_CLEAN, CODE_LABOR_REV, LABOR_BILL_TO_OFFICE,
  type HkEntry,
} from './hk-entries.ts';

/**
 * 產生前的模擬檢查。
 *
 * ============================================================
 * 【這支在防什麼】
 *
 * 成對分錄唯一會安靜壞掉的地方是**只產生一半** ——
 * 金額都對，只是少了一邊，而任何報表的總額看起來都不會怪。
 *
 * ★★★ 底下的正常案例**用真的 `cleaningIncome()` / `laborIncome()` 產生收入**，
 *   不是手寫一個假的陣列。手寫的話這支測的是「我寫的假資料配不配得起來」，
 *   而不是「產生器產出的東西配不配得起來」。
 */

const OFFICE = 'office-prop';
const ESTATES = ['正隆', '時兆', '復興'];

const CLEAN = [
  { key: '2026-08-01|p1|清潔', work_date: '2026-08-01', amount: 9000, label: '14B3', property_id: 'p1' },
  { key: '2026-08-02|p2|清潔', work_date: '2026-08-02', amount: 730, label: 'A09', property_id: 'p2' },
];
const LABOR = [
  { key: '202608|e1', spent_on: '2026-08-31', estate_id: 'e1', amount: 200000 },
  { key: '202608|e2', spent_on: '2026-08-31', estate_id: 'e2', amount: 14000 },
];
const PAIR = new Set(['e1']);                       // e1 = 正隆
const estName = (id: string) => ({ e1: '正隆', e2: '時兆' }[id] ?? '');
const payerOf = (pid: string | null) => ({ p1: '時兆', p2: '開封' }[pid ?? ''] ?? '');

/** 真正的產生器產出的收入 —— 正常情況下的那一批。 */
const realIncome = (): HkEntry[] => [
  ...cleaningIncome(CLEAN, OFFICE, payerOf),
  ...laborIncome(LABOR, PAIR, OFFICE, estName),
];

const run = (o: Partial<Parameters<typeof pairCheck>[0]> = {}) => pairCheck({
  clean: CLEAN, labor: LABOR, income: realIncome(),
  pairEstates: PAIR, allEstateNames: ESTATES, officeId: OFFICE, ...o,
});

describe('★★★ 產生前的模擬檢查', () => {
  test('★★★ 產生器產出的東西本來就該配得起來', () => {
    const r = run();
    assert.equal(r.ok, true, r.issues.map((i) => i.text).join(' / '));
    assert.equal(r.cleanExpect, 2);
    assert.equal(r.cleanActual, 2);
    assert.equal(r.laborExpect, 1);   // 只有正隆成對
    assert.equal(r.laborActual, 1);
    assert.equal(r.expectAmount, 9000 + 730 + 200000);
    assert.equal(r.actualAmount, r.expectAmount);
  });

  test('★★★ 少一筆清潔費收入 → 錯，而且要說出缺的是哪一筆', () => {
    /*
     * 這是最危險的那種:物業付了 730，安幸帳上沒有那筆收入。
     * 兩張表的總額看起來都很正常。
     */
    const inc = realIncome().filter((r) => !r.key.endsWith('|p2|清潔'));
    const r = run({ income: inc });
    assert.equal(r.ok, false);
    const msg = r.issues.filter((i) => i.level === 'error').map((i) => i.text).join('\n');
    assert.match(msg, /清潔費 2 筆，收入只有 1 筆/);
    assert.match(msg, /2026-08-02 A09/);   // 講出是哪一筆，不是只講數字
  });

  test('★★★ 筆數對但金額被改過 → 錯', () => {
    const inc = realIncome().map((r) =>
      (r.account_code === CODE_CLEAN && r.amount === 730) ? { ...r, amount: 700 } : r);
    const r = run({ income: inc });
    assert.equal(r.ok, false);
    assert.match(r.issues.map((i) => i.text).join('\n'), /金額不一樣/);
  });

  test('★★★ 寫死的物業名字對不到 → 錯（改名的那條坑）', () => {
    /*
     * `LABOR_BILL_TO_OFFICE` 是寫死的名字。物業一改名，
     * `pairEstates` 就是空的 → 人事費一筆都不產生收入，
     * 而「筆數配得起來」還是會通過（兩邊都是 0）。
     *
     * ★★★ 少的是一筆 20 萬，畫面上完全看不出來 ——
     *   所以這一條要單獨檢查名字對不對得到，不能只比筆數。
     */
    const r = run({
      allEstateNames: ['正隆企業', '時兆', '復興'],   // 正隆被改名了
      pairEstates: new Set<string>(),                 // 於是配對集合是空的
      income: cleaningIncome(CLEAN, OFFICE, payerOf), // 人事費收入一筆都沒有
    });
    assert.equal(r.ok, false);
    const msg = r.issues.filter((i) => i.level === 'error').map((i) => i.text).join('\n');
    assert.match(msg, /找不到物業「正隆」/);
    assert.match(msg, /LABOR_BILL_TO_OFFICE/);   // 要講怎麼修
  });

  test('★★ 名字都對得到就不該報這一條', () => {
    assert.equal(run().issues.some((i) => i.text.includes('找不到物業')), false);
  });

  test('★★ 找不到安幸辦公室 → 錯', () => {
    const r = run({ officeId: null });
    assert.equal(r.ok, false);
    assert.match(r.issues.map((i) => i.text).join('\n'), /收入沒有地方可以掛/);
  });

  test('★ 沒有任何收入要寫時，找不到辦公室也不用叫', () => {
    // 這個月一份工都沒有 —— 那不是錯，是沒事做
    const r = pairCheck({
      clean: [], labor: [], income: [],
      pairEstates: PAIR, allEstateNames: ESTATES, officeId: null,
    });
    assert.equal(r.issues.some((i) => i.text.includes('沒有地方可以掛')), false);
  });

  test('★★ 金額 0 的清潔費不產生收入 —— 是提醒不是錯', () => {
    /*
     * 人明確填 0 是「這一間這次不用錢」。
     * 不講的話「支出 3 筆、收入 2 筆」看起來就是壞掉。
     */
    const clean = [...CLEAN,
      { key: '2026-08-03|p3|清潔', work_date: '2026-08-03', amount: 0, label: 'B01', property_id: 'p3' }];
    const r = run({ clean, income: [...cleaningIncome(clean, OFFICE, payerOf), ...laborIncome(LABOR, PAIR, OFFICE, estName)] });
    assert.equal(r.ok, true);
    const warn = r.issues.filter((i) => i.level === 'warn').map((i) => i.text).join('\n');
    assert.match(warn, /1 筆清潔費金額是 0/);
  });

  test('★★ 非成對物業的人事費 —— 是提醒不是錯', () => {
    const r = run();
    const warn = r.issues.filter((i) => i.level === 'warn').map((i) => i.text).join('\n');
    assert.match(warn, /只有支出、沒有安幸收入/);
    assert.match(warn, new RegExp(LABOR_BILL_TO_OFFICE[0]));
  });

  test('★ 收入多出來（有收入沒支出）也要抓到', () => {
    const extra: HkEntry = {
      key: 'HKREV|幽靈', side: 'income', on: '2026-08-09', item_name: '房務清潔 X',
      amount: 500, account_code: CODE_CLEAN, property_id: OFFICE, office: true,
    };
    const r = run({ income: [...realIncome(), extra] });
    assert.equal(r.ok, false);
  });

  test('空輸入不炸', () => {
    const r = pairCheck({
      clean: [], labor: [], income: [],
      pairEstates: new Set(), allEstateNames: ESTATES, officeId: OFFICE,
    });
    assert.equal(r.ok, true);
    assert.equal(r.expectCount, 0);
    assert.equal(r.actualCount, 0);
  });

  test('★ CODE_LABOR_REV 的收入才算人事費 —— 不要用金額大小猜', () => {
    const r = run();
    assert.equal(realIncome().filter((x) => x.account_code === CODE_LABOR_REV).length, 1);
    assert.equal(r.laborActual, 1);
  });
});
