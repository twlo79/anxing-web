import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  statusOf, STATUS_LABEL, forfeitedOf, needsForfeitExpense, isOutstanding,
  validateAdvance, validateRefund, statsOf, type Advance,
} from './advance.ts';

const A = (o: Partial<Advance> = {}): Advance => ({
  category: '押金', counterparty: '王大明', usage: '安幸辦公室租賃',
  amount: 150000, paid_on: '2026-03-01', ...o,
});

describe('statusOf —— null 與 0 是兩件事', () => {
  test('還沒出款', () => assert.equal(statusOf(A({ paid_on: null })), 'draft'));
  test('已付款、還沒收回', () => assert.equal(statusOf(A()), 'paid'));
  test('全額收回', () => {
    assert.equal(statusOf(A({ refunded_on: '2026-08-01', refunded_amount: 150000 })), 'refunded');
  });
  test('部分收回', () => {
    assert.equal(statusOf(A({ refunded_on: '2026-08-01', refunded_amount: 148000 })), 'partial');
  });

  /*
   * ★★★ 這一條是整支最重要的。`!refunded_amount` 判斷的話
   *   0 會被當成 null，於是一筆被全額沒收的押金永遠躺在
   *   「錢還在外面」的清單裡，等一個不會來的退款。
   */
  test('★★★ 收回 0 元（全額被扣）是「已收回」，不是「還沒收回」', () => {
    const a = A({ refunded_on: '2026-08-01', refunded_amount: 0 });
    assert.equal(statusOf(a), 'partial');
    assert.equal(isOutstanding(a), false);
    assert.equal(forfeitedOf(a), 150000);
  });

  test('只有日期沒有金額 → 還當成已付款（資料庫會擋，畫面不能爆）', () => {
    assert.equal(statusOf(A({ refunded_on: '2026-08-01' })), 'paid');
  });

  test('每個狀態都有中文標籤', () => {
    for (const s of ['draft', 'paid', 'refunded', 'partial'] as const) {
      assert.ok(STATUS_LABEL[s].length > 0, s);
    }
  });
});

describe('forfeitedOf —— 被扣多少', () => {
  test('還沒收回 → 0（不是 null）', () => assert.equal(forfeitedOf(A()), 0));
  test('全額收回 → 0', () => {
    assert.equal(forfeitedOf(A({ refunded_on: '2026-08-01', refunded_amount: 150000 })), 0);
  });
  test('被扣 2,000', () => {
    assert.equal(forfeitedOf(A({ refunded_on: '2026-08-01', refunded_amount: 148000 })), 2000);
  });

  /*
   * ★ 浮點數相減會漂：150000 - 148000.1 得到 1999.8999999999996，
   *   而那個數字會直接變成一筆支出的金額寫進資料庫。
   */
  test('★ 小數不會漂', () => {
    assert.equal(forfeitedOf(A({ amount: 150000, refunded_on: '2026-08-01', refunded_amount: 148000.1 })), 1999.9);
    assert.equal(forfeitedOf(A({ amount: 10000, refunded_on: '2026-08-01', refunded_amount: 3333.33 })), 6666.67);
  });
});

describe('needsForfeitExpense —— 冪等', () => {
  const partial = A({ refunded_on: '2026-08-01', refunded_amount: 148000 });

  test('被扣了、還沒產生 → 要產生', () => assert.equal(needsForfeitExpense(partial), true));

  /*
   * ★★★ 沒有這一條的話重複按「確認收回」就是重複支出，
   *   而總額看起來只是「多了一筆」，沒有人會回去比對。
   */
  test('★★★ 已經產生過 → 不再產生', () => {
    assert.equal(needsForfeitExpense({ ...partial, forfeit_expense_id: 'e-1' }), false);
  });

  test('全額收回 → 不產生', () => {
    assert.equal(needsForfeitExpense(A({ refunded_on: '2026-08-01', refunded_amount: 150000 })), false);
  });
  test('還沒收回 → 不產生', () => assert.equal(needsForfeitExpense(A()), false));
});

describe('validateAdvance —— 必填', () => {
  test('都填好了', () => assert.equal(validateAdvance(A()), null));
  test('類別亂填', () => assert.match(validateAdvance(A({ category: '訂金' as never })) ?? '', /押金或保證金/));
  test('沒填對象', () => assert.match(validateAdvance(A({ counterparty: '  ' })) ?? '', /對象/));

  // ★ 用途留空的話，三個月後只知道付給誰、不知道為什麼
  test('沒填用途', () => assert.match(validateAdvance(A({ usage: '' })) ?? '', /用途/));

  test('金額是 0', () => assert.match(validateAdvance(A({ amount: 0 })) ?? '', /大於 0/));
  test('金額是負數', () => assert.match(validateAdvance(A({ amount: -1 })) ?? '', /大於 0/));
  test('金額有三位小數', () => assert.match(validateAdvance(A({ amount: 100.005 })) ?? '', /小數點後兩位/));
});

describe('validateRefund —— 跟資料庫的約束同一組規則', () => {
  test('沒填收回 → 過', () => assert.equal(validateRefund(A()), null));
  test('正常全額收回', () => {
    assert.equal(validateRefund(A({ refunded_on: '2026-08-01', refunded_amount: 150000 })), null);
  });
  test('正常部分收回', () => {
    assert.equal(validateRefund(A({ refunded_on: '2026-08-01', refunded_amount: 148000 })), null);
  });
  test('★ 收回 0（全額被扣）是合法的', () => {
    assert.equal(validateRefund(A({ refunded_on: '2026-08-01', refunded_amount: 0 })), null);
  });

  /*
   * ★★ 只有其中一個的話，狀態落在「已退款」與「已付款」之間 ——
   *   而畫面上要據此決定顯示哪個標籤，兩邊都不對。
   */
  test('只有日期', () => assert.match(validateRefund(A({ refunded_on: '2026-08-01' })) ?? '', /收回金額/));
  test('只有金額', () => assert.match(validateRefund(A({ refunded_amount: 1000 })) ?? '', /收回日/));

  test('收回比付出去的多', () => {
    const m = validateRefund(A({ refunded_on: '2026-08-01', refunded_amount: 160000 })) ?? '';
    assert.match(m, /還多/);
    // ★ 訊息要講出「多的那部分要另外記收入」—— 不然使用者只會把金額改小
    assert.match(m, /收入/);
  });
  test('收回日早於出款日', () => {
    assert.match(validateRefund(A({ paid_on: '2026-03-01', refunded_on: '2026-02-01', refunded_amount: 1 })) ?? '', /早於/);
  });
  test('還沒出款就收回', () => {
    assert.match(validateRefund(A({ paid_on: null, refunded_on: '2026-02-01', refunded_amount: 1 })) ?? '', /還沒出款/);
  });
});

describe('statsOf —— 三張卡', () => {
  const rows: Advance[] = [
    A({ amount: 150000 }),                                                       // 在外面
    A({ amount: 80000, refunded_on: '2026-08-20', refunded_amount: 80000 }),     // 全額退
    A({ amount: 10000, refunded_on: '2026-07-01', refunded_amount: 8000 }),      // 被扣 2000
    A({ amount: 50000, paid_on: null }),                                         // 還沒出款
  ];
  const s = statsOf(rows);

  test('在外面的只算已付款未收回的', () => {
    assert.equal(s.paid.n, 1);
    assert.equal(s.paid.amt, 150000);
  });

  // ★ 還沒出款的錢還在我們帳上，不算暫付
  test('還沒出款的不算進任何一格', () => {
    assert.equal(s.paid.n + s.refunded.n, 3);
  });

  test('已退款算實際收回的金額', () => {
    assert.equal(s.refunded.n, 2);
    assert.equal(s.refunded.amt, 88000);
  });

  /*
   * ★★ 被扣單獨一格。混進「已退款」的話
   *   「我們今年被扣了多少押金」永遠沒有人查得到。
   */
  test('★★ 被扣單獨一格', () => {
    assert.equal(s.forfeited.n, 1);
    assert.equal(s.forfeited.amt, 2000);
  });

  test('空清單不會爆', () => {
    const e = statsOf([]);
    assert.equal(e.paid.amt, 0);
    assert.equal(e.forfeited.n, 0);
  });

  test('★ 合計不漂', () => {
    const f = statsOf([
      A({ amount: 0.1, refunded_on: '2026-08-01', refunded_amount: 0 }),
      A({ amount: 0.2, refunded_on: '2026-08-01', refunded_amount: 0 }),
    ]);
    assert.equal(f.forfeited.amt, 0.3);
  });
});
