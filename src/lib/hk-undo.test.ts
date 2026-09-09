import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  planUndo, keyOfOrder,
  type UndoExpense, type UndoOrder,
} from './hk-undo.ts';

/**
 * 撤銷「產生收支」的那一批。
 *
 * 【這支釘什麼 —— 四種都會讓帳變單邊】
 *   ① 撈到不屬於這個月的 → 刪掉別人的支出
 *   ② 漏掉收入只刪支出   → 安幸留著收入、物業沒有成本
 *   ③ 被動過的沒被標出來 → 使用者不知道自己刪掉了什麼
 *   ④ 前綴解析錯         → 收入配不到支出，整批只刪一半
 */

const K1 = '2026-08-01|p1|清潔';
const K2 = '2026-08-02|p2|清潔';
const KL = '202608|e1';
const KEYS = new Set([K1, K2, KL]);

const E = (o: Partial<UndoExpense> = {}): UndoExpense => ({
  id: 'e-' + (o.hk_job_key ?? o.hk_labor_key ?? 'x'),
  hk_job_key: K1, hk_labor_key: null,
  item_name: '房務清潔 14B3', amount: 9000, spent_on: '2026-08-01', ...o,
});
const O = (o: Partial<UndoOrder> = {}): UndoOrder => ({
  id: 'o-1', order_key: 'HKREV|' + K1,
  item_name: '房務清潔 14B3', amount: 9000, checkin: '2026-08-01', ...o,
});

describe('★★★ 撤銷這批', () => {
  test('★★★ 支出與收入一起收進來 —— 只刪一半會讓帳變單邊', () => {
    const p = planUndo({ expenses: [E()], orders: [O()], keys: KEYS });
    assert.equal(p.expCount, 1);
    assert.equal(p.incCount, 1);
    assert.equal(p.expAmount, 9000);
    assert.equal(p.incAmount, 9000);
  });

  test('★★★ 不在這個月 key 清單裡的一律不碰', () => {
    /*
     * 撈太多的話會刪掉別的月份、或別人手動建的支出 ——
     * 而那幾筆的 hk_job_key 長得跟這批一模一樣。
     */
    const p = planUndo({
      expenses: [E({ id: 'other', hk_job_key: '2026-07-01|p9|清潔' })],
      orders: [O({ id: 'o-other', order_key: 'HKREV|2026-07-01|p9|清潔' })],
      keys: KEYS,
    });
    assert.equal(p.rows.length, 0);
  });

  test('★★ 人事費走 hk_labor_key，也要撈得到', () => {
    const p = planUndo({
      expenses: [E({ id: 'lab', hk_job_key: null, hk_labor_key: KL, item_name: '房務人事費', amount: 200000 })],
      orders: [O({ id: 'lo', order_key: 'HKLABREV|' + KL, item_name: '人事費 正隆', amount: 200000 })],
      keys: KEYS,
    });
    assert.equal(p.expCount, 1);
    assert.equal(p.incCount, 1);
  });

  test('★★★ 前綴解析：HKREV 與 HKLABREV 都要回原本的鍵', () => {
    assert.equal(keyOfOrder('HKREV|' + K1), K1);
    assert.equal(keyOfOrder('HKLABREV|' + KL), KL);
    // 不是這兩種前綴的訂單完全不碰 —— 那是別人的一次性收入
    assert.equal(keyOfOrder('CFEE_abc_123'), null);
    assert.equal(keyOfOrder(''), null);
  });

  test('★★ 一般訂單不會被撈進來', () => {
    const p = planUndo({
      expenses: [], orders: [O({ id: 'normal', order_key: 'CFEE_abc_123' })], keys: KEYS,
    });
    assert.equal(p.rows.length, 0);
  });

  test('★★★ 設了遞延的要標出來（但照樣刪）', () => {
    const p = planUndo({
      expenses: [E({ deferred: true })], orders: [], keys: KEYS,
    });
    assert.equal(p.expCount, 1);                      // 還是會刪
    assert.equal(p.touched.length, 1);
    assert.equal(p.touched[0].touched, '設了遞延認列');
  });

  test('★★ 子單也算被動過 —— 刪母單會連子單一起沒', () => {
    const p = planUndo({
      expenses: [E({ parent_expense_id: 'parent-1' })], orders: [], keys: KEYS,
    });
    assert.equal(p.touched[0].touched, '設了遞延認列');
  });

  test('★★★ 項目名稱被改過要標出來', () => {
    const p = planUndo({
      expenses: [E({ item_name: '房務清潔 14B3（重掃）' })], orders: [], keys: KEYS,
      expectedName: (k) => (k === K1 ? '房務清潔 14B3' : undefined),
    });
    assert.equal(p.touched[0].touched, '項目名稱被改過');
  });

  test('★★ 名稱一樣就不要亮黃燈', () => {
    const p = planUndo({
      expenses: [E()], orders: [], keys: KEYS,
      expectedName: () => '房務清潔 14B3',
    });
    assert.equal(p.touched.length, 0);
  });

  test('★★★ 算不出現在該叫什麼名字的時候，不要說「被改過」', () => {
    /*
     * expectedName 回 undefined = 這個鍵現在算不出來（單價被刪了之類）。
     * 那時候說「被改過」的話每一筆都會亮黃燈，而黃燈一多就沒有人看了。
     */
    const p = planUndo({
      expenses: [E()], orders: [], keys: KEYS, expectedName: () => undefined,
    });
    assert.equal(p.touched.length, 0);
  });

  test('★★ 已收款的收入要標出來', () => {
    const p = planUndo({ expenses: [], orders: [O({ paid: true })], keys: KEYS });
    assert.equal(p.incCount, 1);
    assert.equal(p.touched[0].touched, '這筆收入已經收款');
  });

  test('★ 遞延排在改名之前 —— 同時成立時要講嚴重的那個', () => {
    const p = planUndo({
      expenses: [E({ deferred: true, item_name: '改過了' })], orders: [], keys: KEYS,
      expectedName: () => '房務清潔 14B3',
    });
    assert.equal(p.touched[0].touched, '設了遞延認列');
  });

  test('空輸入不炸', () => {
    const p = planUndo({ expenses: [], orders: [], keys: new Set() });
    assert.deepEqual(p.rows, []);
    assert.equal(p.expCount + p.incCount, 0);
  });
});
