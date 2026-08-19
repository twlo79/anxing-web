import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  remainingDep, depPayStatus, checkDepPayment, methodSummary, sumPayments, reconcile,
  DEP_STATUS_LABEL, type PayableDeposit,
} from './deposit-payment.ts';

/**
 * 押金收款的判斷。
 *
 * 這裡算錯**不會報錯**，只會產生一個看起來很正常的數字：
 *
 *   · 部分收款被當成已收 → 那筆押金直接通過移轉與退款的前置檢查
 *   · 尚欠算成負數      → 畫面出現「還差 -500」
 *   · 多筆時挑一個方式顯示 → 一半的錢看起來走錯了管道
 */

const d = (o: Partial<PayableDeposit> = {}): PayableDeposit => ({
  amount: 2800, received_amount: 0, received_on: null, returned_on: null, ...o,
});

describe('尚欠', () => {
  test('一般情況', () => {
    assert.equal(remainingDep(d({ received_amount: 1000 })), 1800);
  });

  test('★ 收滿或超收回 0，不是負數', () => {
    // 負數會讓畫面出現「還差 -500」
    assert.equal(remainingDep(d({ received_amount: 2800 })), 0);
    assert.equal(remainingDep(d({ received_amount: 3000 })), 0);
  });

  test('沒有應收也不會壞', () => {
    assert.equal(remainingDep(d({ amount: null })), 0);
    assert.equal(remainingDep(d({ amount: 0 })), 0);
  });
});

describe('狀態', () => {
  test('一毛沒收 = 尚未收', () => {
    assert.equal(depPayStatus(d()), 'unpaid');
  });

  test('★★ 收了一部分 = 部分收款，不是已收', () => {
    /*
     * 這是整支的重點。判成 paid 的話，一筆只收了 600 的押金
     * 會直接通過移轉與退款的前置檢查 —— 而那些檢查看的是 received_on。
     */
    assert.equal(depPayStatus(d({ received_amount: 600 })), 'partial');
    assert.equal(depPayStatus(d({ received_amount: 2799 })), 'partial');
  });

  test('收滿或超收 = 暫收中', () => {
    assert.equal(depPayStatus(d({ received_amount: 2800 })), 'paid');
    assert.equal(depPayStatus(d({ received_amount: 3000 })), 'paid');
  });

  test('★ 退掉的優先 —— 錢已經不在我們手上了', () => {
    assert.equal(depPayStatus(d({ received_amount: 2800, returned_on: '2026-08-05' })), 'returned');
    // 連只收一半又退掉的（資料怪，但畫面不能顯示成「部分收款」）
    assert.equal(depPayStatus(d({ received_amount: 600, returned_on: '2026-08-05' })), 'returned');
  });

  test('★ 應收 0 當已收 —— 免押金的不該永遠掛在待收清單上', () => {
    assert.equal(depPayStatus(d({ amount: 0 })), 'paid');
    assert.equal(depPayStatus(d({ amount: null })), 'paid');
  });

  test('小數不影響判斷 —— 四捨五入到整數再比', () => {
    // 差 0.4 元不該讓一筆押金永遠收不完
    assert.equal(depPayStatus(d({ amount: 2800, received_amount: 2799.6 })), 'paid');
  });

  test('每個狀態都有中文標籤', () => {
    for (const s of ['unpaid', 'partial', 'paid', 'returned'] as const) {
      assert.ok(DEP_STATUS_LABEL[s].length > 0, `${s} 沒有標籤`);
    }
  });
});

describe('新增收款前的檢查', () => {
  test('沒填金額擋下來', () => {
    const r = checkDepPayment(0, 2800, 2800);
    assert.equal(r.ok, false);
  });

  test('★★ 負數擋死 —— 要沖銷就刪那一筆', () => {
    /*
     * 允許負數的話，明細會變成一堆正負相消的列,
     * 而「這筆押金到底收了多少」得靠人心算。
     */
    const r = checkDepPayment(-100, 2800, 2800);
    assert.equal(r.ok, false);
    assert.match((r as any).error, /負數/);
  });

  test('正常金額直接過，不囉唆', () => {
    const r = checkDepPayment(1000, 2800, 2800);
    assert.equal(r.ok, true);
    assert.equal((r as any).confirm, undefined);
  });

  test('★ 超收不擋，只問一聲，而且要講差多少', () => {
    /*
     * 擋死的話使用者只能去改押金金額 —— 而那是契約條件的一部分,
     * 改了就把來源弄壞了。
     */
    const r = checkDepPayment(3000, 2800, 2800);
    assert.equal(r.ok, true);
    assert.match((r as any).confirm, /200/);
  });

  test('應收 0 的不問超收 —— 那沒有「超」可言', () => {
    const r = checkDepPayment(500, 0, 0);
    assert.equal(r.ok, true);
    assert.equal((r as any).confirm, undefined);
  });
});

describe('收款方式的顯示', () => {
  const L = (m: string) => ({ cash: '現金', transfer: '匯款', internal: '押金移轉' } as any)[m] ?? m;
  const A = (a: string) => ({ '48088': '元大 48088' } as any)[a] ?? a;

  test('一筆就顯示那一筆', () => {
    assert.equal(methodSummary([{ method: 'transfer', account: '48088' }], L, A), '匯款・元大 48088');
    assert.equal(methodSummary([{ method: 'cash', account: null }], L, A), '現金');
  });

  test('★★ 多筆回「多筆」，不挑其中一個', () => {
    /*
     * 一筆現金＋一筆匯款,挑哪一個都會讓另一半的錢看起來走錯管道 ——
     * 而那正是跟銀行對帳時會被相信的欄位。
     */
    const s = methodSummary(
      [{ method: 'cash', account: null }, { method: 'transfer', account: '48088' }], L, A);
    assert.match(s, /多筆/);
    assert.doesNotMatch(s, /現金|匯款/);
  });

  test('沒有收款回破折號，不要空白', () => {
    assert.equal(methodSummary([], L, A), '—');
    assert.equal(methodSummary([{ method: null, account: null }], L, A), '—');
  });
});

describe('明細與合計對帳', () => {
  const p = (amount: number) => ({ amount });

  test('對得上回 null', () => {
    assert.equal(reconcile([p(600), p(400)], 1000), null);
  });

  test('★★ 對不上要講得出差多少', () => {
    /*
     * 合計是觸發器維護的、明細是前端載回來的,本來就該一樣。
     * 不一樣代表其中一邊有問題,而**兩個數字各自看都很正常**。
     */
    const m = reconcile([p(600), p(400)], 2800);
    assert.ok(m);
    assert.match(m!, /1,000/);
    assert.match(m!, /2,800/);
    assert.match(m!, /1,800/);   // 差額
  });

  test('小數的差不算差', () => {
    assert.equal(reconcile([p(999.6)], 1000), null);
  });

  test('合計', () => {
    assert.equal(sumPayments([p(600), p(400)]), 1000);
    assert.equal(sumPayments([]), 0);
  });
});
