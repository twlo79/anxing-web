import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { depLines, depPaidLines, depOwedLines } from './deposit-lines.ts';

/*
 * ══════════════════════════════════════════════════════════
 * 「已收」那張卡要算實收，不是應收（2026-09-15 使用者指定）
 *
 *   19B3 碩美　應收 350,000　訂金轉入 175,000　尚欠 175,000
 *
 * 原本整筆 350,000 被算進「押金・已收 NT$17,613,395」，
 * 而那張卡的標題寫著「錢在我們手上」——
 * 其中 175,000 還在房客口袋。
 *
 * ★ 使用者：「已收，部分收就算部分；部分押金的一樣歸類在已收。」
 *   → **歸類不動**（還是在已收那一格、筆數照算），只有金額改成實收。
 * ══════════════════════════════════════════════════════════
 */

const twd = (amount: number, o: Record<string, unknown> = {}) =>
  ({ currency: 'TWD', amount, lines: null, ...o } as any);

describe('★★★ 實收金額（depPaidLines）', () => {
  test('★★★ 19B3 那筆：應收 350,000、實收 175,000', () => {
    const d = twd(350000, { received_amount: 175000, received_on: '2026-09-15' });
    assert.deepEqual(depPaidLines(d), [{ cur: 'TWD', amt: 175000 }]);
    assert.deepEqual(depOwedLines(d), [{ cur: 'TWD', amt: 175000 }]);
  });

  test('★ 收滿的照舊 —— 88 筆不受影響', () => {
    const d = twd(350000, { received_amount: 350000, received_on: '2026-09-15' });
    assert.deepEqual(depPaidLines(d), [{ cur: 'TWD', amt: 350000 }]);
    assert.deepEqual(depOwedLines(d), [], '收滿就沒有尚欠');
  });

  test('★★ 超收不讓「已收」膨脹 —— 上限是應收', () => {
    const d = twd(350000, { received_amount: 400000, received_on: '2026-09-15' });
    assert.deepEqual(depPaidLines(d), [{ cur: 'TWD', amt: 350000 }]);
    assert.deepEqual(depOwedLines(d), []);
  });

  test('★ 一毛沒收 → 實收是空的', () => {
    assert.deepEqual(depPaidLines(twd(350000, { received_amount: 0, received_on: null })), []);
    assert.deepEqual(depOwedLines(twd(350000, { received_amount: 0, received_on: null })),
      [{ cur: 'TWD', amt: 350000 }]);
  });

  /*
   * ★★★ `received_amount` 是 null 的舊資料。
   *   2026-09-15 查過現在一筆都沒有，但匯入或補資料可能再造出來 ——
   *   那時候當成 0 會讓「已收」整批歸零，那比原本的 bug 嚴重得多。
   */
  test('★★★ received_amount 是 null → 退回「有收款日就是收滿」', () => {
    assert.deepEqual(depPaidLines(twd(350000, { received_amount: null, received_on: '2025-03-01' })),
      [{ cur: 'TWD', amt: 350000 }]);
    assert.deepEqual(depPaidLines(twd(350000, { received_amount: null, received_on: null })), []);
  });

  /*
   * ★★ 外幣沒有「收了一部分」的資料 —— `received_amount` 是一個數字、沒有幣別。
   *   按比例拆是**發明數字**，而發明出來的數字會進報表。
   */
  test('★★ 外幣：有收款日就當作收到，沒有就當作沒收', () => {
    const d = {
      currency: 'TWD', amount: 0,
      lines: [{ cur: 'TWD', amt: 100000 }, { cur: 'USD', amt: 700 }],
      received_amount: 50000, received_on: '2026-09-15',
    } as any;
    assert.deepEqual(depPaidLines(d), [{ cur: 'TWD', amt: 50000 }, { cur: 'USD', amt: 700 }]);
    assert.deepEqual(depOwedLines(d), [{ cur: 'TWD', amt: 50000 }]);
  });

  test('★ 外幣沒收款日 → 兩種幣別都是 0', () => {
    const d = {
      currency: 'TWD', amount: 0,
      lines: [{ cur: 'TWD', amt: 100000 }, { cur: 'USD', amt: 700 }],
      received_amount: 0, received_on: null,
    } as any;
    assert.deepEqual(depPaidLines(d), []);
    assert.deepEqual(depOwedLines(d), [{ cur: 'TWD', amt: 100000 }, { cur: 'USD', amt: 700 }]);
  });

  test('★ 應收本身沒變 —— depLines 一個字都沒動', () => {
    const d = twd(350000, { received_amount: 175000, received_on: '2026-09-15' });
    assert.deepEqual(depLines(d), [{ cur: 'TWD', amt: 350000 }]);
  });
});
