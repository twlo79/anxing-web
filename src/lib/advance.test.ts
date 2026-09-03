import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  statusOf, STATUS_LABEL, forfeitedOf, needsForfeitExpense, isOutstanding,
  validateAdvance, validateRefund, statsOf, defaultRefundAccount, refundAccountWarning, type Advance,
  CATEGORIES, purposeFromSelect, purposeToSelect, purposeLabel,
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
  // ★ 2026-09-02 類別多了「其他」,訊息從「要選押金或保證金」改成「要選類別」
  test('類別亂填', () => assert.match(validateAdvance(A({ category: '訂金' as never })) ?? '', /要選類別/));
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
  /*
   * ★★ 2026-09-02 起,短收時**必須選會計科目**（使用者:「可選會計科目」）。
   *   所以下面兩條要帶 forfeit_account_code —— 契約變了,不是測試壞了。
   *   沒帶的情形另外有測（「短收的差額要選會計科目」那一組）。
   */
  test('正常部分收回', () => {
    assert.equal(validateRefund(A({
      refunded_on: '2026-08-01', refunded_amount: 148000, forfeit_account_code: 'guarantee',
    })), null);
  });
  test('★ 收回 0（全額被扣）是合法的', () => {
    assert.equal(validateRefund(A({
      refunded_on: '2026-08-01', refunded_amount: 0, forfeit_account_code: 'guarantee',
    })), null);
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

/*
 * ★★★ 2026-09-02 使用者三個新條件：
 *   「類別有其他」「暫支要回到原支出帳戶」「短收可選會計科目」
 */
describe('類別加「其他」', () => {
  test('三種都過', () => {
    for (const c of ['押金', '保證金', '其他'] as const) {
      assert.equal(validateAdvance({
        category: c, counterparty: '宇田', usage: '裝潢保證金', amount: 200000,
      }), null);
    }
  });
  test('沒選或亂填的擋掉', () => {
    assert.equal(validateAdvance({
      category: '' as never, counterparty: '宇田', usage: 'x', amount: 1,
    }), '要選類別');
  });
});

describe('收回要回到原出款帳戶', () => {
  const A = (o: Partial<Advance> = {}): Advance => ({
    category: '保證金', counterparty: '宇田', usage: '裝潢保證金',
    amount: 200000, paid_on: '2026-08-20', paid_account: '4145', ...o,
  });

  test('預設帶原出款帳戶', () => {
    assert.equal(defaultRefundAccount(A()), '4145');
  });

  /*
   * ★ 回 null 是「系統不知道」,不是「沒有帳戶」——
   *   手動建的暫付與舊單都沒有出款帳戶,那時要讓人自己選。
   */
  test('★ 沒有出款帳戶時回 null,不要瞎猜', () => {
    assert.equal(defaultRefundAccount(A({ paid_account: null })), null);
    assert.equal(defaultRefundAccount(A({ paid_account: '  ' })), null);
  });

  test('一樣就不提醒', () => {
    assert.equal(refundAccountWarning(A({ refund_account: '4145' })), null);
  });
  test('不一樣要提醒,而且講出原本是哪個', () => {
    assert.equal(refundAccountWarning(A({ refund_account: '08311' })),
      '跟出款帳戶不同（原本是 4145）');
  });
  test('還沒填收款帳戶時不提醒 —— 那是還沒做完,不是做錯', () => {
    assert.equal(refundAccountWarning(A()), null);
  });

  /*
   * ★★ 提醒**不會**擋住存檔。錢確實可能回到別的帳戶,
   *   硬鎖住的話那筆錢就記不進系統。
   */
  test('★★ 帳戶不同照樣存得了', () => {
    assert.equal(validateRefund(A({
      refund_account: '08311', refunded_on: '2026-09-02', refunded_amount: 200000,
    })), null);
  });
});

describe('短收的差額要選會計科目', () => {
  const A = (o: Partial<Advance> = {}): Advance => ({
    category: '保證金', counterparty: '宇田', usage: '裝潢保證金',
    amount: 200000, paid_on: '2026-08-20',
    refunded_on: '2026-09-02', refunded_amount: 198000, ...o,
  });

  test('★★★ 短收但沒選科目 → 擋下來,而且講出金額', () => {
    assert.equal(validateRefund(A()), '沒收回的 2000 要記成支出 —— 請選會計科目');
  });
  test('選了就過', () => {
    assert.equal(validateRefund(A({ forfeit_account_code: 'guarantee' })), null);
  });
  test('全額收回不需要科目', () => {
    assert.equal(validateRefund(A({ refunded_amount: 200000 })), null);
  });

  /*
   * ★ 全額被扣（收回 0）也是短收 —— 而且是最該記科目的那一種。
   *   用 `!refunded_amount` 判斷的話這一筆會漏掉。
   */
  test('★ 收回 0（全額被扣）也要選科目', () => {
    assert.equal(validateRefund(A({ refunded_amount: 0 })),
      '沒收回的 200000 要記成支出 —— 請選會計科目');
  });

  /*
   * ★★ 已經產生過支出的不再要求。那筆支出早就存在、科目在它自己身上,
   *   再擋一次的話使用者只是開來看一眼就存不了。
   */
  test('★★ 已經產生過支出的不再要求科目', () => {
    assert.equal(validateRefund(A({ forfeit_expense_id: 'e1' })), null);
  });

  test('空白字串不算選了', () => {
    assert.equal(validateRefund(A({ forfeit_account_code: '   ' })),
      '沒收回的 2000 要記成支出 —— 請選會計科目');
  });
});

describe('用途:物業 or 安幸辦公室（migration_212，2026-09-03）', () => {
  const nameOf = (id: string) => ({ e1: '正隆', e2: '時兆' } as Record<string, string>)[id];

  test('類別多了零用金', () => {
    assert.ok((CATEGORIES as readonly string[]).includes('零用金'));
    // ★ 舊的三種不能掉 —— 掉了的話既有資料的類別會變成非法值
    for (const c of ['押金', '保證金', '其他']) {
      assert.ok((CATEGORIES as readonly string[]).includes(c), c + ' 不見了');
    }
  });

  test('選物業:兩個欄位一起算', () => {
    assert.deepEqual(purposeFromSelect('e1'), { purpose_type: 'estate', estate_id: 'e1' });
  });

  /*
   * ★★★ 選辦公室時 estate_id **一定要清成 null**。
   *   留著舊值的話就是一列自相矛盾的資料（office 卻掛著物業），
   *   畫面顯示其中一個、報表讀另一個，兩邊都不會叫。
   */
  test('★★★ 選辦公室會把物業清掉', () => {
    assert.deepEqual(purposeFromSelect('office'), { purpose_type: 'office', estate_id: null });
  });

  test('選「—」就是都沒填', () => {
    assert.deepEqual(purposeFromSelect(''), { purpose_type: 'estate', estate_id: null });
  });

  test('顯示:辦公室、物業、沒填', () => {
    assert.equal(purposeLabel('office', null, nameOf), '安幸辦公室');
    assert.equal(purposeLabel('estate', 'e1', nameOf), '正隆');
    assert.equal(purposeLabel('estate', null, nameOf), '—');
    assert.equal(purposeLabel(null, null, nameOf), '—');
  });

  // ★ 物業被刪掉之後 estate_id 還在但查不到名字 —— 要回「—」不是空字串
  test('查不到名字的物業回「—」', () => {
    assert.equal(purposeLabel('estate', '不存在的id', nameOf), '—');
  });

  test('存進去再讀出來，下拉會選回同一個', () => {
    for (const v of ['e1', 'office', '']) {
      const p = purposeFromSelect(v);
      assert.equal(purposeToSelect(p.purpose_type, p.estate_id), v, v + ' 來回要一致');
    }
  });
});
