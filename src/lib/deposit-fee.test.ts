import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  feesTotal, refundable, checkFee, defaultFeeDate,
  pickDeposit, approvalDrift, orderLockReason,
} from './deposit-fee.ts';

/**
 * 這裡每一條算式都直接決定**要退多少錢出去**。
 * 算錯不會有錯誤訊息 —— 只會少退或多退，而且對方不會來說。
 */

const dep = (over = {}) => ({ id: 'D1', amount: 10000, ...over });

describe('應退金額', () => {
  test('★★ 押金 10,000 扣 100 = 9,900', () => {
    assert.equal(refundable(dep(), [{ date: '2026-08-20', amount: 100 }]), 9900);
  });

  test('沒有加費就退全額', () => {
    assert.equal(refundable(dep(), []), 10000);
  });

  test('多筆加費要加總', () => {
    const fees = [
      { date: '2026-08-20', amount: 100 },
      { date: '2026-08-20', amount: 250 },
    ];
    assert.equal(feesTotal(fees), 350);
    assert.equal(refundable(dep(), fees), 9650);
  });

  test('★★ 超過押金要回負數，不要夾成 0', () => {
    /*
     * 夾成 0 的話畫面顯示「應退 0」,看起來像已經處理完,
     * 而實際上是加費填超過押金了。
     * 錯誤要浮出來,不要被算式吸收掉。
     */
    assert.equal(refundable(dep(), [{ date: '2026-08-20', amount: 12000 }]), -2000);
  });

  test('小數要四捨五入 —— 押金是整數的錢', () => {
    assert.equal(refundable(dep(), [{ date: '2026-08-20', amount: 100.4 }]), 9900);
  });
});

describe('存得進去嗎', () => {
  test('★★ 已退的押金不能再扣', () => {
    const r = checkFee(dep({ returned_on: '2026-08-20' }), [], { date: '2026-08-21', amount: 100 });
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, /2026-08-20/);   // 要講出是哪天退的
  });

  test('★★ 合計超過押金要擋，並講出兩個數字', () => {
    const r = checkFee(dep(), [{ id: 'a', date: '2026-08-20', amount: 9000 }],
      { date: '2026-08-20', amount: 2000 });
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, /11,000/);   // 合計
    assert.match((r as { error: string }).error, /10,000/);   // 押金
  });

  test('★ 編輯既有那列時不能把舊值算兩次', () => {
    // 9,000 那列改成 9,500 —— 沒排除自己的話會算成 18,500 而誤擋
    const fees = [{ id: 'a', date: '2026-08-20', amount: 9000 }];
    assert.equal(checkFee(dep(), fees, { id: 'a', date: '2026-08-20', amount: 9500 }).ok, true);
  });

  test('剛好等於押金可以（應退 0）', () => {
    assert.equal(checkFee(dep(), [], { date: '2026-08-20', amount: 10000 }).ok, true);
  });

  test('負數要擋 —— 扣除的方向系統處理', () => {
    assert.equal(checkFee(dep(), [], { date: '2026-08-20', amount: -100 }).ok, false);
  });

  test('沒填日期或金額要擋', () => {
    assert.equal(checkFee(dep(), [], { date: null, amount: 100 }).ok, false);
    assert.equal(checkFee(dep(), [], { date: '2026-08-20', amount: 0 }).ok, false);
  });
});

describe('費用日期的預設值', () => {
  test('★ 決定營收落在哪個月 —— 實際退款日優先', () => {
    assert.equal(
      defaultFeeDate(dep({ returned_on: '2026-08-20', planned_refund_on: '2026-08-15' }), '2026-08-22'),
      '2026-08-20');
  });

  test('還沒退就用預計匯款日', () => {
    assert.equal(defaultFeeDate(dep({ planned_refund_on: '2026-08-15' }), '2026-08-22'), '2026-08-15');
  });

  test('都沒有就用今天', () => {
    assert.equal(defaultFeeDate(dep(), '2026-08-22'), '2026-08-22');
  });
});

describe('找對應的押金', () => {
  const order = { id: 'O1', parent_order_id: null, contract_id: null };

  test('★★ 走 order_id，唯一解才給', () => {
    const r = pickDeposit([{ id: 'D1', amount: 10000, order_id: 'O1' }], order);
    assert.equal(r.kind, 'one');
  });

  test('★★ 加費子單要往上找母訂單', () => {
    // 押金掛在母訂單上,加費是子單 —— 不往上找的話永遠找不到
    const fee = { id: 'F1', parent_order_id: 'O1', contract_id: null };
    assert.equal(pickDeposit([{ id: 'D1', amount: 10000, order_id: 'O1' }], fee).kind, 'one');
  });

  test('契約的押金走 contract_id', () => {
    const o = { id: 'O9', parent_order_id: null, contract_id: 'C1' };
    assert.equal(pickDeposit([{ id: 'D2', amount: 5000, contract_id: 'C1' }], o).kind, 'one');
  });

  test('★★ 房號一樣但不是同一單 —— 不能中', () => {
    /*
     * 使用者指定「一定要確認是同單,用 unique ID 搜」。
     * 用房號比對的話,同一個房號跨房客、跨期都會中 ——
     * 而扣錯人的押金,畫面上完全看不出來:金額對、房號對,
     * 只有「是誰的錢」錯了。
     */
    const other = { id: 'D3', amount: 10000, order_id: 'O-OTHER', room: '13A5' };
    assert.equal(pickDeposit([other], { id: 'O1', room: '13A5' } as never).kind, 'none');
  });

  test('★★ 兩筆以上不猜', () => {
    const r = pickDeposit([
      { id: 'D1', amount: 10000, order_id: 'O1' },
      { id: 'D2', amount: 5000, order_id: 'O1' },
    ], order);
    assert.equal(r.kind, 'many');
    assert.equal((r as { n: number }).n, 2);
  });

  test('★ 已退的押金不算候選', () => {
    const r = pickDeposit(
      [{ id: 'D1', amount: 10000, order_id: 'O1', returned_on: '2026-08-20' }], order);
    assert.equal(r.kind, 'none');
  });

  test('一筆押金都沒有', () => {
    assert.equal(pickDeposit([], order).kind, 'none');
  });
});

describe('核可之後被改動', () => {
  test('★★ 核可 9,900 但現在應退 9,800 → 要講出來', () => {
    const d = dep({ approved_amount: 9900 });
    const msg = approvalDrift(d, [{ date: '2026-08-20', amount: 200 }]);
    assert.match(msg!, /9,900/);
    assert.match(msg!, /9,800/);
  });

  test('金額沒變就不吵', () => {
    const d = dep({ approved_amount: 9900 });
    assert.equal(approvalDrift(d, [{ date: '2026-08-20', amount: 100 }]), null);
  });

  test('★ 還沒送審就沒有比較基準', () => {
    assert.equal(approvalDrift(dep(), [{ date: '2026-08-20', amount: 100 }]), null);
  });
});

describe('訂單鎖定', () => {
  test('★★ 押金退了就鎖 —— 而且要講出原因', () => {
    const msg = orderLockReason({ returned_on: '2026-08-20' }, 'housekeeper');
    assert.match(msg!, /2026-08-20/);
    assert.match(msg!, /洽會計/);      // 要講怎麼辦,不只是「不能改」
  });

  test('★★ 會計與總管理員可以改', () => {
    // 完全鎖死的話,打錯一個字就只能請人下 SQL
    assert.equal(orderLockReason({ returned_on: '2026-08-20' }, 'accountant'), null);
    assert.equal(orderLockReason({ returned_on: '2026-08-20' }, 'super_admin'), null);
  });

  test('主管不能改 —— 他核的是金額,不是內容', () => {
    assert.notEqual(orderLockReason({ returned_on: '2026-08-20' }, 'manager'), null);
  });

  test('押金還沒退就不鎖', () => {
    assert.equal(orderLockReason({ returned_on: null }, 'housekeeper'), null);
    assert.equal(orderLockReason(null, 'housekeeper'), null);
  });
});
