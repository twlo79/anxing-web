import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  splitEvenly, hourlyRows, hourlyItemName,
} from './hk-hourly.ts';

/**
 * 時薪人員（劉姐）的支出。
 *
 * ============================================================
 * 【這支在防什麼 —— 四種都是安靜的錯】
 *
 *   ① 排除的 key 跟清潔費對不上 → 那幾間付兩次，帳面完全正常
 *   ② 合掃時把清潔費打折     → 庭玉（按間計酬）的錢默默少掉
 *   ③ 攤分湊不回總數         → 每個月跟薪資表差幾塊，查不出來源
 *   ④ 沒房源／沒時薪安靜跳過  → 那個人整個月從支出裡消失
 */

const LIU = 'liu';          // 時薪
const TING = 'ting';        // 間數
const HOURLY = new Set([LIU]);

describe('★★★ splitEvenly —— 攤分要湊得回總數', () => {
  test('★★★ 除不盡時加起來仍然等於原數', () => {
    // 2500 / 3 = 833.33…。三個都 833 的話少一塊,而那一塊每個月都不一樣
    const p = splitEvenly(2500, 3);
    assert.deepEqual(p, [834, 833, 833]);
    assert.equal(p.reduce((a, b) => a + b, 0), 2500);
  });

  test('除得盡就平均', () => {
    assert.deepEqual(splitEvenly(2500, 2), [1250, 1250]);
  });

  test('一份就是全部', () => {
    assert.deepEqual(splitEvenly(2250, 1), [2250]);
  });

  test('隨便試都要湊得回去', () => {
    for (const total of [100, 2500, 2250, 4500, 7]) {
      for (const n of [1, 2, 3, 4, 7]) {
        assert.equal(splitEvenly(total, n).reduce((a, b) => a + b, 0), total,
          `${total} / ${n}`);
      }
    }
  });
});

describe('★★ hourlyRows —— 時數 × 時薪，攤到房源', () => {
  const staff = [{ id: LIU, name: '劉姐', hourly_rate: 500 }];

  test('★★ 使用者 08-01 那天：5 小時、兩間 → 各 1,250', () => {
    const { rows } = hourlyRows(
      [{ work_date: '2026-08-01', staff_id: LIU, hours: 5 }],
      [
        { work_date: '2026-08-01', property_id: '14B3', work_type: '退房', staffIds: ['ting', LIU] },
        { work_date: '2026-08-01', property_id: '18B5', work_type: '退房', staffIds: [LIU] },
      ],
      staff);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => r.amount), [1250, 1250]);
    assert.equal(rows.reduce((a, r) => a + r.amount, 0), 2500);
    // ★ 合掃的那間也要攤到 —— 她的工時不因為有人一起做而變少
    assert.ok(rows.some((r) => r.property_id === '14B3'));
  });

  test('只有一間就不攤', () => {
    const { rows } = hourlyRows(
      [{ work_date: '2026-08-30', staff_id: LIU, hours: 4 }],
      [{ work_date: '2026-08-30', property_id: '14B5', work_type: '退房', staffIds: [LIU] }],
      staff);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].amount, 2000);
    assert.equal(rows[0].share, 1);
  });

  test('★★ 同一間同一天做兩種工作只算一間 —— 不然那間房拿雙倍', () => {
    const { rows } = hourlyRows(
      [{ work_date: '2026-08-05', staff_id: LIU, hours: 4 }],
      [
        { work_date: '2026-08-05', property_id: 'p1', work_type: '退房', staffIds: [LIU] },
        { work_date: '2026-08-05', property_id: 'p1', work_type: '入住', staffIds: [LIU] },
      ],
      staff);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].amount, 2000);
  });

  test('★★★ key 用 HR| 前綴 —— 跟清潔費共用同一個唯一索引', () => {
    const { rows } = hourlyRows(
      [{ work_date: '2026-08-30', staff_id: LIU, hours: 4 }],
      [{ work_date: '2026-08-30', property_id: '14B5', work_type: '退房', staffIds: [LIU] }],
      staff);
    assert.equal(rows[0].key, 'HR|2026-08-30|liu|14B5');
    // 清潔費那一個是 `2026-08-30|14B5|退房` —— 兩者不可以撞
    assert.notEqual(rows[0].key, '2026-08-30|14B5|退房');
  });

  test('沒上班（時數空白或 0）不產生', () => {
    const { rows, skipped } = hourlyRows(
      [{ work_date: '2026-08-26', staff_id: LIU, hours: null },
       { work_date: '2026-08-27', staff_id: LIU, hours: 0 }],
      [], staff);
    assert.equal(rows.length, 0);
    assert.equal(skipped.length, 0);   // 沒上班不是問題,不要報
  });
});

describe('★★★ 算不出來的要列出來，不可以安靜跳過', () => {
  test('★★★ 有時數、沒房源 → 進 skipped（08-29 那筆就是）', () => {
    /*
     * 不猜一間填進去 —— 那筆錢會掛在別的物業頭上,而沒有人會發現。
     * 列出來讓人回排班表補一筆工作。
     */
    const { rows, skipped } = hourlyRows(
      [{ work_date: '2026-08-29', staff_id: LIU, hours: 4.5 }],
      [{ work_date: '2026-08-29', property_id: 'A02', work_type: '退房', staffIds: ['ting'] }],
      [{ id: LIU, name: '劉姐', hourly_rate: 500 }]);
    assert.equal(rows.length, 0);
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0].reason, '沒有房源');
    assert.equal(skipped[0].work_date, '2026-08-29');
    assert.equal(skipped[0].hours, 4.5);
  });

  test('★★★ 沒設時薪 → 進 skipped，不是當成 0', () => {
    // 當成 0 安靜跳過的話,那個人整個月從支出裡消失
    const { rows, skipped } = hourlyRows(
      [{ work_date: '2026-08-01', staff_id: LIU, hours: 5 }],
      [{ work_date: '2026-08-01', property_id: 'p1', work_type: '退房', staffIds: [LIU] }],
      [{ id: LIU, name: '劉姐', hourly_rate: null }]);
    assert.equal(rows.length, 0);
    assert.equal(skipped[0].reason, '沒設時薪');
  });
});

describe('項目名稱要寫出算式', () => {
  test('★ 攤過的要看得到「÷ N 間」', () => {
    const { rows } = hourlyRows(
      [{ work_date: '2026-08-01', staff_id: LIU, hours: 5 }],
      [{ work_date: '2026-08-01', property_id: 'a', work_type: '退房', staffIds: [LIU] },
       { work_date: '2026-08-01', property_id: 'b', work_type: '退房', staffIds: [LIU] }],
      [{ id: LIU, name: '劉姐', hourly_rate: 500 }]);
    assert.equal(hourlyItemName(rows[0]), '劉姐 5 小時 × $500 ÷ 2 間');
  });

  test('沒攤的就不寫除號', () => {
    const { rows } = hourlyRows(
      [{ work_date: '2026-08-30', staff_id: LIU, hours: 4 }],
      [{ work_date: '2026-08-30', property_id: 'a', work_type: '退房', staffIds: [LIU] }],
      [{ id: LIU, name: '劉姐', hourly_rate: 500 }]);
    assert.equal(hourlyItemName(rows[0]), '劉姐 4 小時 × $500');
  });
});
