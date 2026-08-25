import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  exitTaken, earnestStatus, exitBlockedReason, convertPlan,
  forfeitOrder, earnestOnlyMissing, monthlyRentToSave,
} from './earnest.ts';

const E = (p: Record<string, unknown> = {}) => ({ kind: 'earnest' as const, amount: 10000, ...p });

describe('earnestStatus', () => {
  test('★ 五種狀態', () => {
    assert.equal(earnestStatus(E()), '未付訂金');
    assert.equal(earnestStatus(E({ received_on: '2026-08-01' })), '已收訂金');
    assert.equal(earnestStatus(E({ received_on: '2026-08-01', returned_on: '2026-08-10' })), '已退訂金');
    assert.equal(earnestStatus(E({ received_on: '2026-08-01', forfeited_on: '2026-08-10' })), '已沒收');
    assert.equal(earnestStatus(E({ received_on: '2026-08-01', converted_to_deposit_id: 'd1' })), '已退｜轉押');
  });

  test('★★ 先看出路再看收款 —— 反過來的話「已收」會蓋掉「已沒收」', () => {
    // 沒收過的訂金 received_on 一定有值（要先收到才能沒收）
    const d = E({ received_on: '2026-08-01', forfeited_on: '2026-08-10' });
    assert.equal(earnestStatus(d), '已沒收');
  });

  test('退款跑到一半', () => {
    assert.equal(earnestStatus(E({ received_on: '2026-08-01', refund_status: 'pending' })), '退款審核中');
    assert.equal(earnestStatus(E({ received_on: '2026-08-01', refund_status: 'approved' })), '退款審核中');
  });

  test('★ 排匯款完成（returned_on 有值）就是已退，不是審核中', () => {
    const d = E({ received_on: '2026-08-01', refund_status: 'approved', returned_on: '2026-08-12' });
    assert.equal(earnestStatus(d), '已退訂金');
  });
});

describe('exitTaken', () => {
  test('三種出路各自認得出來', () => {
    assert.equal(exitTaken(E({ returned_on: '2026-08-10' })), 'refund');
    assert.equal(exitTaken(E({ forfeited_on: '2026-08-10' })), 'forfeit');
    assert.equal(exitTaken(E({ converted_to_deposit_id: 'd1' })), 'convert');
    assert.equal(exitTaken(E()), null);
  });
});

describe('exitBlockedReason', () => {
  const paid = E({ received_on: '2026-08-01' });

  test('★ 已收訂金 —— 三條路都走得了', () => {
    for (const w of ['refund', 'forfeit', 'convert'] as const) {
      assert.equal(exitBlockedReason(paid, w), null, w);
    }
  });

  test('★★ 還沒收到錢 —— 三條都不行', () => {
    for (const w of ['refund', 'forfeit', 'convert'] as const) {
      const r = exitBlockedReason(E(), w);
      assert.ok(r?.includes('還沒收到'), w);
    }
  });

  test('★★ 走過一條就不能再走另一條', () => {
    const refunded = E({ received_on: '2026-08-01', returned_on: '2026-08-10' });
    // 已退了還要沒收 → 錢還給他了卻認列成收入，營收憑空多一筆
    assert.ok(exitBlockedReason(refunded, 'forfeit')?.includes('已經退款了'));
    assert.ok(exitBlockedReason(refunded, 'convert')?.includes('已經退款了'));

    const forfeited = E({ received_on: '2026-08-01', forfeited_on: '2026-08-10' });
    // 已沒收了還要退款 → 收入認列過了又匯錢出去，兩邊都錯
    assert.ok(exitBlockedReason(forfeited, 'refund')?.includes('已經沒收了'));

    const converted = E({ received_on: '2026-08-01', converted_to_deposit_id: 'd1' });
    assert.ok(exitBlockedReason(converted, 'refund')?.includes('已經轉押金了'));
  });

  test('★ 同一條走第二次 —— 講「已經…過了」不是「不能」', () => {
    const forfeited = E({ received_on: '2026-08-01', forfeited_on: '2026-08-10' });
    assert.equal(exitBlockedReason(forfeited, 'forfeit'), '已經沒收過了。');
  });

  test('★★ 退款審核中，另外兩條要擋住', () => {
    // 不擋的話會出現「送審中又被沒收」—— 請款審核頁多一張核不掉的單
    const pending = E({ received_on: '2026-08-01', refund_status: 'pending' });
    assert.ok(exitBlockedReason(pending, 'forfeit')?.includes('審核中'));
    assert.ok(exitBlockedReason(pending, 'convert')?.includes('審核中'));
    // 退款本身不擋（那是同一條路的後續步驟）
    assert.equal(exitBlockedReason(pending, 'refund'), null);
  });

  test('★ 押金那一列不能走訂金的路', () => {
    const dep = E({ kind: 'deposit', received_on: '2026-08-01' });
    assert.ok(exitBlockedReason(dep, 'forfeit')?.includes('押金'));
  });
});

describe('convertPlan', () => {
  test('★★ 訂金 10,000 → 押金 30,000：已收一部分，還差 20,000', () => {
    const p = convertPlan(10000, 30000);
    assert.equal(p.transfer, 10000);
    assert.equal(p.remaining, 20000);
    assert.equal(p.settled, false);
    assert.equal(p.excess, 0);
  });

  test('★ 金額剛好 —— 押金收齊', () => {
    const p = convertPlan(30000, 30000);
    assert.equal(p.remaining, 0);
    assert.equal(p.settled, true);
  });

  test('★★ 押金已經先收過一筆 —— 要算進去', () => {
    // 不算的話「還差多少」會算多,然後有人去跟房客多收一次
    const p = convertPlan(10000, 30000, 15000);
    assert.equal(p.remaining, 5000);
    assert.equal(p.settled, false);
  });

  test('★ 訂金比押金多 —— 記在 excess，不自動退', () => {
    const p = convertPlan(50000, 30000);
    assert.equal(p.remaining, 0);
    assert.equal(p.settled, true);
    assert.equal(p.excess, 20000);
  });

  test('押金是 0 或沒填 —— settled 不能是 true', () => {
    // dep = 0 時 covered >= dep 恆成立,不特別擋的話會說「收齊了」
    assert.equal(convertPlan(10000, 0).settled, false);
    assert.equal(convertPlan(10000, null).settled, false);
  });

  test('負數與空值不會算出負的', () => {
    const p = convertPlan(null, null);
    assert.equal(p.transfer, 0);
    assert.equal(p.remaining, 0);
    assert.equal(p.excess, 0);
  });
});

describe('forfeitOrder', () => {
  const dep = { id: 'e1', amount: 10000, estate_id: 'est1', property_id: 'p1',
                room: 'B08', guest_name: 'Lilian' };

  test('★★ 科目是「其他」不是「違約金」', () => {
    // fee-types.ts 檔頭:取消相關的收入本來就歸在「其他」
    // （Airbnb 取消收入 73 筆、約 150 萬都是這樣處理的）
    const o = forfeitOrder(dep, '2026-08-24');
    assert.equal(o.fee_type, '其他');
    assert.equal(o.item_name, '取消入住');
  });

  test('★★ 起訖同一天 —— 一次性收入沒有住宿天數', () => {
    // 填成一段期間的話,營收認列會把它拆到好幾個月
    const o = forfeitOrder(dep, '2026-08-24');
    assert.equal(o.checkin, '2026-08-24');
    assert.equal(o.checkout, '2026-08-24');
  });

  test('★ deposit_id 要指回訂金 —— 「這筆收入從哪來」查得到', () => {
    assert.equal(forfeitOrder(dep, '2026-08-24').deposit_id, 'e1');
  });

  test('★ 備註要講出來源 —— 報表的「其他」混著好幾種收入', () => {
    assert.match(forfeitOrder(dep, '2026-08-24').note, /沒收訂金/);
  });

  test('金額與房源從訂金帶', () => {
    const o = forfeitOrder(dep, '2026-08-24');
    assert.equal(o.amount, 10000);
    assert.equal(o.property_raw, 'B08');
    assert.equal(o.guest_name, 'Lilian');
  });
});

describe('earnestOnlyMissing', () => {
  test('★★ 回缺哪一個，不是 boolean', () => {
    // 只說「請填完必填欄位」的話,使用者得自己一格一格找
    assert.deepEqual(earnestOnlyMissing({}), ['租期起', '租期迄', '每月租金']);
    assert.deepEqual(
      earnestOnlyMissing({ start_date: '2026-09-01', amount_per_period: 30000 }),
      ['租期迄']);
  });

  test('全部填好 → 空陣列', () => {
    assert.deepEqual(earnestOnlyMissing({
      start_date: '2026-09-01', end_date: '2027-08-31', amount_per_period: 30000,
    }), []);
  });

  test('★★ 租金 0 算沒填 —— 月租 0 元的契約不存在', () => {
    assert.deepEqual(
      earnestOnlyMissing({ start_date: 'a', end_date: 'b', amount_per_period: 0 }),
      ['每月租金']);
  });

  test('空白字串算沒填', () => {
    assert.ok(earnestOnlyMissing({ start_date: '  ', end_date: 'b', amount_per_period: 1 })
      .includes('租期起'));
  });
});

describe('monthlyRentToSave', () => {
  test('★★ 訂金階段存 null 不是 0', () => {
    // 「0 元租金」跟「還沒填」不是同一件事,而三個月後看資料的人只看得到那個 0
    assert.equal(monthlyRentToSave(null, 1), null);
    assert.equal(monthlyRentToSave(0, 1), null);
    assert.equal(monthlyRentToSave(undefined, 1), null);
  });

  test('一般契約照期數換算', () => {
    assert.equal(monthlyRentToSave(30000, 1), 30000);   // 月繳
    assert.equal(monthlyRentToSave(90000, 3), 30000);   // 季繳
  });

  test('step 是 0 或負數 —— 回 null，不要除以零', () => {
    assert.equal(monthlyRentToSave(30000, 0), null);
  });
});
