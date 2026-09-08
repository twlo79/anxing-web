import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  cleaningIncome, laborIncome, hourlyExpense, sideTotal,
  CODE_CLEAN, CODE_SALARY, CODE_LABOR_REV,
} from './hk-entries.ts';

/**
 * 房務的成對分錄。
 *
 * ============================================================
 * 【這支在防什麼 —— 四種都是安靜的錯】
 *
 *   ① 收入的 key 沒加前綴 → 跟支出的 key 長得一樣，兩張表對不出誰是誰
 *   ② 收入金額自己重算   → 跟支出漂掉，差幾百塊而兩邊看起來都正常
 *   ③ 劉姐工資記在房源   → 物業付過清潔費了，同一份工被記兩次成本
 *   ④ 人事費全部成對     → 安幸憑空多出幾筆本來不是它收的錢
 */

const OFFICE = 'office-prop';

describe('★★★ 清潔那一對：安幸收入 ＋ 物業支出，同額反向', () => {
  const cost = [
    { key: '2026-08-01|p1|清潔', work_date: '2026-08-01', amount: 9000, label: '14B3', property_id: 'p1' },
    { key: '2026-08-02|p2|清潔', work_date: '2026-08-02', amount: 730, label: 'A09', property_id: 'p2' },
  ];
  const payerOf = (id: string | null) => ({ p1: '時兆', p2: '開封' }[id ?? ''] ?? '');

  test('★★★ 收入金額直接取支出的，不重算', () => {
    /*
     * 重算的話兩邊遲早會漂,而漂掉的症狀是「收入跟支出對不起來」——
     * 金額都很正常,只是差幾百塊,沒有人查得出來。
     */
    const inc = cleaningIncome(cost, OFFICE, payerOf);
    assert.deepEqual(inc.map((r) => r.amount), [9000, 730]);
    assert.equal(sideTotal(inc, 'income'), 9730);
  });

  test('★★★ key 要有 HKREV 前綴 —— 不然跟支出的 key 一模一樣', () => {
    const inc = cleaningIncome(cost, OFFICE, payerOf);
    assert.equal(inc[0].key, 'HKREV|2026-08-01|p1|清潔');
    assert.notEqual(inc[0].key, cost[0].key);
  });

  test('★★ 收入一律掛安幸辦公室，不是房源', () => {
    const inc = cleaningIncome(cost, OFFICE, payerOf);
    assert.ok(inc.every((r) => r.property_id === OFFICE && r.office));
  });

  test('科目是房務清潔（migration_228 改成 both 才選得到）', () => {
    assert.ok(cleaningIncome(cost, OFFICE, payerOf).every((r) => r.account_code === CODE_CLEAN));
  });

  test('★ 金額 0 的不產生收入 —— 支出那邊也不會有', () => {
    const inc = cleaningIncome(
      [{ key: 'k', work_date: '2026-08-01', amount: 0, label: 'x', property_id: 'p1' }],
      OFFICE, payerOf);
    assert.equal(inc.length, 0);
  });

  test('項目名稱帶房號，日期就是打掃日', () => {
    const inc = cleaningIncome(cost, OFFICE, payerOf);
    assert.equal(inc[0].item_name, '房務清潔 14B3');
    assert.equal(inc[0].on, '2026-08-01');
  });
});

describe('★★★ 人事費：只有指定的那個物業成對', () => {
  const lab = [
    { key: '202608|zl', spent_on: '2026-08-31', estate_id: 'zl', amount: 200000 },
    { key: '202608|e2', spent_on: '2026-08-31', estate_id: 'e2', amount: 12000 },
    { key: '202608|e3', spent_on: '2026-08-31', estate_id: 'e3', amount: 4000 },
  ];
  const nameOf = (id: string) => ({ zl: '正隆', e2: '時兆', e3: '開封' }[id] ?? '');

  test('★★★ 只有正隆產生收入，其餘五筆維持現狀', () => {
    // 全部成對的話，安幸的收入會憑空多出那幾筆 —— 而那本來不是安幸收的錢
    const inc = laborIncome(lab, new Set(['zl']), OFFICE, nameOf);
    assert.equal(inc.length, 1);
    assert.equal(inc[0].amount, 200000);
    assert.match(inc[0].item_name, /正隆/);
  });

  test('科目是人事費（收入），不是薪資勞務', () => {
    const inc = laborIncome(lab, new Set(['zl']), OFFICE, nameOf);
    assert.equal(inc[0].account_code, CODE_LABOR_REV);
    assert.notEqual(inc[0].account_code, CODE_SALARY);
  });

  test('key 有自己的前綴，跟清潔收入分得開', () => {
    const inc = laborIncome(lab, new Set(['zl']), OFFICE, nameOf);
    assert.match(inc[0].key, /^HKLABREV\|/);
  });

  test('沒有指定任何物業就一筆收入都不產生', () => {
    assert.equal(laborIncome(lab, new Set(), OFFICE, nameOf).length, 0);
  });
});

describe('★★★ 劉姐的工資記在安幸辦公室，不是房源', () => {
  const hr = [
    { key: 'HR|2026-08-01|liu|p1', spent_on: '2026-08-01', staff_name: '劉姐',
      hours: 5, rate: 500, amount: 1250, share: 2 },
    { key: 'HR|2026-08-30|liu|p2', spent_on: '2026-08-30', staff_name: '劉姐',
      hours: 4, rate: 500, amount: 2000, share: 1 },
  ];
  const rooms = [
    { key: 'HR|2026-08-01|liu|p1', property_id: 'p1' },
    { key: 'HR|2026-08-30|liu|p2', property_id: 'p2' },
  ];
  const roomName = (id: string) => ({ p1: '14B3', p2: '14B5' }[id] ?? '');

  test('★★★ 掛安幸辦公室 —— 記在房源上等於同一份工付兩次成本', () => {
    /*
     * 物業已經付過那間房的清潔費了。工資再記到房源上,
     * 那間房的成本就變成「清潔費 ＋ 劉姐工資」,而她的工資是安幸的成本。
     */
    const out = hourlyExpense(hr, roomName, rooms, OFFICE);
    assert.ok(out.every((r) => r.property_id === OFFICE && r.office));
  });

  test('★★ 科目是薪資勞務，不是房務清潔', () => {
    const out = hourlyExpense(hr, roomName, rooms, OFFICE);
    assert.ok(out.every((r) => r.account_code === CODE_SALARY));
  });

  test('★ 房號留在項目名稱裡 —— 金額歸安幸，但查得到花在哪幾間', () => {
    const out = hourlyExpense(hr, roomName, rooms, OFFICE);
    assert.equal(out[0].item_name, '劉姐 2.5 小時 × $500・14B3');
    assert.equal(out[1].item_name, '劉姐 4 小時 × $500・14B5');
  });

  test('★★ 攤過的要印攤後的時數，不是當天的總時數', () => {
    // 印 5 小時而金額只有 1,250 的話，看的人會以為時薪被算錯了
    const out = hourlyExpense(hr, roomName, rooms, OFFICE);
    assert.match(out[0].item_name, /2\.5 小時/);
    // ★ 用「劉姐 5 小時」整段比,不能只比「5 小時」——
    //   後者會 match 到「2.5 小時」裡的那個 5（第一版就是這樣自己騙自己）
    assert.equal(out[0].item_name.includes('劉姐 5 小時'), false);
  });

  test('key 沿用 hourlyRows 的，不重新編', () => {
    const out = hourlyExpense(hr, roomName, rooms, OFFICE);
    assert.equal(out[0].key, 'HR|2026-08-01|liu|p1');
  });
});

describe('★ 收入與支出分開加', () => {
  test('加在一起是沒有意義的數字', () => {
    const rows = [
      ...cleaningIncome(
        [{ key: 'k1', work_date: '2026-08-01', amount: 9000, label: 'a', property_id: 'p1' }],
        OFFICE, () => '時兆'),
      ...hourlyExpense(
        [{ key: 'HR|x', spent_on: '2026-08-01', staff_name: '劉姐',
           hours: 4, rate: 500, amount: 2000, share: 1 }],
        () => '', [], OFFICE),
    ];
    assert.equal(sideTotal(rows, 'income'), 9000);
    assert.equal(sideTotal(rows, 'expense'), 2000);
  });
});

describe('★★★ 人事費開收入的物業是寫死的名字', () => {
  test('★★★ 就是「正隆」', async () => {
    /*
     * 使用者選「程式裡認正隆這個名字」（2026-09-07）。
     * 物業一改名這條就失效,而失效的症狀是**安幸少了一筆 20 萬收入** ——
     * 不會報錯,只是那個月的收入少一截。
     *
     * 這條測試的用途:哪天真的改名了,測試先壞掉,
     * 而不是等會計月結對不上才發現。
     */
    const { LABOR_BILL_TO_OFFICE } = await import('./hk-entries.ts');
    assert.deepEqual([...LABOR_BILL_TO_OFFICE], ['正隆']);
  });
});

describe('★★ 兩個新名目要進一次性收入的清單', () => {
  test('★★★ 在 ONEOFF_ONLY，不在 FEE_TYPES', async () => {
    // 放進 FEE_TYPES 的話會出現在「每月自動產生」的選單上，
    // 而一個每月自動長出來的房務清潔在會計上講不通
    const { FEE_TYPES, ONEOFF_ONLY_FEE_TYPES, ONEOFF_FEE_TYPES } =
      await import('./fee-types.ts');
    for (const t of ['房務清潔', '人事費']) {
      assert.ok((ONEOFF_ONLY_FEE_TYPES as readonly string[]).includes(t), `ONEOFF_ONLY 少了 ${t}`);
      assert.ok((ONEOFF_FEE_TYPES as readonly string[]).includes(t), `ONEOFF 少了 ${t}`);
      assert.equal((FEE_TYPES as readonly string[]).includes(t), false, `${t} 不該在 FEE_TYPES`);
    }
  });
});

describe('★★ 收入要看得出是向誰收的', () => {
  test('★★ 房客欄放物業名稱 —— 不然營收頁一整排長一樣', () => {
    /*
     * 收入列的房源都是「安幸辦公室」。不寫付款方的話,
     * 只看得到「房務清潔 A09」,看不出這 730 是向時兆還是向開封收的。
     */
    const inc = cleaningIncome(
      [{ key: 'k', work_date: '2026-08-02', amount: 730, label: 'A09', property_id: 'p2' }],
      OFFICE, (id) => (id === 'p2' ? '開封' : ''));
    assert.equal(inc[0].payer, '開封');
  });

  test('人事費收入也要帶物業名稱', () => {
    const inc = laborIncome(
      [{ key: '202608|zl', spent_on: '2026-08-31', estate_id: 'zl', amount: 200000 }],
      new Set(['zl']), OFFICE, () => '正隆');
    assert.equal(inc[0].payer, '正隆');
  });
});
