import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ledgerOf, lineOrder, type RepayLine } from './advance-detail.ts';
import { remainingOf } from './advance.ts';

/** 愛皮 115/7-8月管理服務費：安幸 9/07 出 7,350，9/15 還 6,000 */
const A = { amount: 7350, paid_on: '2026-09-07', paid_account: '安幸-台新', counterparty: '愛皮' };
const L = (o: Partial<RepayLine> = {}): RepayLine => ({
  id: 'l1', amount: 6000, repayment_id: 'r1', repaid_on: '2026-09-15',
  out_account: '愛皮-現金', in_account: '安幸-台新', created_at: '1', siblings: 1, ...o,
});

describe('ledgerOf —— 哪一天付多少、哪一天還多少', () => {
  test('★★★ 第一列是安幸出款，帳戶是 paid_account', () => {
    const { rows } = ledgerOf(A, []);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, 'out');
    assert.equal(rows[0].date, '2026-09-07');
    assert.equal(rows[0].amount, 7350);
    assert.equal(rows[0].from, '安幸-台新');
    /* 出款之後還欠全額 */
    assert.equal(rows[0].rest, 7350);
  });

  test('★★★ 還款那一列的方向是「對方 → 安幸」', () => {
    const { rows } = ledgerOf(A, [L()]);
    assert.equal(rows[1].kind, 'in');
    assert.equal(rows[1].from, '愛皮-現金');   // 錢從對方出去
    assert.equal(rows[1].to, '安幸-台新');     // 進到安幸
  });

  test('★★★ 「之後還欠」一路減下來', () => {
    const { rows, owe } = ledgerOf(A, [L()]);
    assert.deepEqual(rows.map((r) => [r.kind, r.amount, r.rest]), [
      ['out', 7350, 7350],
      ['in', 6000, 1350],
    ]);
    assert.equal(owe, 1350);
  });

  test('★★ 分三次還 → 每一列的剩餘各自往下掉', () => {
    const { rows, owe } = ledgerOf(A, [
      L({ id: 'l1', amount: 3000, repaid_on: '2026-09-15' }),
      L({ id: 'l2', amount: 3000, repaid_on: '2026-09-20' }),
      L({ id: 'l3', amount: 1350, repaid_on: '2026-09-30' }),
    ]);
    assert.deepEqual(rows.map((r) => r.rest), [7350, 4350, 1350, 0]);
    assert.equal(owe, 0);
  });

  /*
   * ★★★ 這一條釘住「畫面的最後一列」與「清單的剩餘欄」是同一個數字。
   *   兩邊各算一次的話，它們對不起來時沒有任何地方會叫。
   */
  test('★★★ 最後一列的剩餘 === 清單上的 remainingOf()', () => {
    const { rows } = ledgerOf(A, [L()]);
    const adv = { ...A, refunded_amount: 6000 } as never;
    assert.equal(rows[rows.length - 1].rest, remainingOf(adv));
  });

  test('★★★ 結清而且沒收足 → 多一列「被扣」，收在 0', () => {
    const { rows, owe, forfeited } = ledgerOf(
      { ...A, refunded_on: '2026-10-05' }, [L()]);
    assert.equal(rows.length, 3);
    assert.equal(rows[2].kind, 'settle');
    assert.equal(rows[2].amount, 1350);
    assert.equal(rows[2].rest, 0);
    assert.equal(owe, 0);
    assert.equal(forfeited, 1350);
    /* 結清的列在清單上剩餘也是 0 —— 兩邊一致 */
    assert.equal(remainingOf({ ...A, refunded_on: '2026-10-05', refunded_amount: 6000 } as never), 0);
  });

  test('★ 結清而且剛好收滿 → 不多那一列', () => {
    const { rows, forfeited } = ledgerOf(
      { ...A, refunded_on: '2026-10-05' }, [L({ amount: 7350 })]);
    assert.equal(rows.length, 2);
    assert.equal(forfeited, 0);
  });

  test('★ 還沒出款 → 一列都不畫', () => {
    assert.deepEqual(ledgerOf({ ...A, paid_on: null }, [L()]).rows, []);
  });

  test('★ 沒有還款紀錄 → 只有出款那一列', () => {
    const { rows, owe } = ledgerOf(A, []);
    assert.equal(rows.length, 1);
    assert.equal(owe, 7350);
  });

  test('★ 收到分：浮點數不會漂', () => {
    const { owe } = ledgerOf({ ...A, amount: 7350 }, [L({ amount: 6000.1 })]);
    assert.equal(owe, 1349.9);
  });

  test('★ 還多了也不畫負的欠款', () => {
    const { owe, rows } = ledgerOf(A, [L({ amount: 9999 })]);
    assert.equal(owe, 0);
    assert.equal(rows[1].rest, 0);
  });
});

describe('lineOrder —— 三個鍵，跑幾次都一樣', () => {
  const a = L({ id: 'a', repaid_on: '2026-09-15', created_at: '1' });
  const b = L({ id: 'b', repaid_on: '2026-09-15', created_at: '2' });
  const c = L({ id: 'c', repaid_on: '2026-09-20', created_at: '3' });

  test('照還款日排', () => {
    assert.deepEqual(lineOrder([c, a, b]).map((x) => x.id), ['a', 'b', 'c']);
  });

  test('★★ 同一天照建立時間 —— 只排日期的話順序會飄', () => {
    assert.deepEqual(lineOrder([b, a]).map((x) => x.id), ['a', 'b']);
    assert.deepEqual(lineOrder([a, b]).map((x) => x.id), ['a', 'b']);
  });

  test('★ 建立時間也一樣時照 id，結果唯一', () => {
    const x = L({ id: 'z', created_at: '1' }), y = L({ id: 'y', created_at: '1' });
    assert.deepEqual(lineOrder([x, y]).map((r) => r.id), ['y', 'z']);
    assert.deepEqual(lineOrder([y, x]).map((r) => r.id), ['y', 'z']);
  });

  test('不會改到傳進來的陣列', () => {
    const arr = [c, a, b];
    lineOrder(arr);
    assert.deepEqual(arr.map((x) => x.id), ['c', 'a', 'b']);
  });
});
