import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  canBeSource, canBeTarget, canTransfer, transferCandidates, transferTargets, transferChip,
  roleCanTransfer, depName, isTransfer, type TransferDep,
} from './deposit-transfer.ts';

/**
 * 押金移房的判斷。
 *
 * 這裡每一條規則放行錯了都**不會報錯**，只會產生一個看起來很正常的數字：
 *
 *   · 目的已收過還讓它收 → 同一筆押金收兩次，押金總額憑空多一筆
 *   · 金額不同還放行     → B 顯示收了 40,000，實際只有 30,000
 *   · 來源已退還讓它移   → 已經退給房客的錢又被移到別房
 *
 * 所以每一條擋下都要有測試釘住。
 */

const A = (o: Partial<TransferDep> = {}): TransferDep => ({
  id: 'A', room: 'A101', guest_name: '林小姐', currency: 'TWD', amount: 30_000,
  received_on: '2026-05-01', returned_on: null, orphaned: false,
  order_id: 'oA', contract_id: null, transfer_to_id: null, transfer_from_id: null, ...o,
});
const B = (o: Partial<TransferDep> = {}): TransferDep => ({
  id: 'B', room: 'B202', guest_name: '林小姐', currency: 'TWD', amount: 30_000,
  received_on: null, returned_on: null, orphaned: false,
  order_id: 'oB', contract_id: null, transfer_to_id: null, transfer_from_id: null, ...o,
});

describe('誰能移', () => {
  test('★★ 只有會計與總管理員 —— 經理不在內', () => {
    // 這一份要跟 RPC 裡的 current_role_of() 檢查一致。
    // 對不上的症狀是「按鈕看得到卻按不動」,而錯誤訊息只會說權限不足。
    assert.equal(roleCanTransfer('accountant'), true);
    assert.equal(roleCanTransfer('super_admin'), true);
    assert.equal(roleCanTransfer('manager'), false);
    assert.equal(roleCanTransfer('housekeeper'), false);
    assert.equal(roleCanTransfer(null), false);
  });
});

describe('可以當來源嗎', () => {
  test('暫收中的可以', () => {
    assert.equal(canBeSource(A()).ok, true);
  });

  test('★★ 還沒收到錢的不能移 —— 沒有錢可以移', () => {
    const v = canBeSource(A({ received_on: null }));
    assert.equal(v.ok, false);
    assert.match(v.reason, /還沒收/);
  });

  test('★★ 已經退給房客的不能再移', () => {
    // 放行的話會變成「同一筆錢退了又移」,兩邊的紀錄都說自己有那筆錢
    const v = canBeSource(A({ returned_on: '2026-06-01' }));
    assert.equal(v.ok, false);
    assert.match(v.reason, /已退款/);
  });

  test('★ 已經移轉出去的，訊息要說「已移轉」不是「已退款」', () => {
    // 兩個都是 returned_on 有值,但意思完全不同:
    // 一個錢匯給房客了,一個錢還在我們手上。訊息混用會讓人以為錢不見了。
    const v = canBeSource(A({ returned_on: '2026-06-01', transfer_to_id: 'B' }));
    assert.equal(v.ok, false);
    assert.match(v.reason, /已移轉/);
  });

  test('孤兒紀錄不能移 —— 來源訂單都不在了', () => {
    assert.equal(canBeSource(A({ orphaned: true })).ok, false);
  });
});

describe('可以當目的嗎', () => {
  test('尚未收的可以', () => {
    assert.equal(canBeTarget(B()).ok, true);
  });

  test('★★ 已經收過押金的不能再收 —— 那是收兩次', () => {
    const v = canBeTarget(B({ received_on: '2026-07-01' }));
    assert.equal(v.ok, false);
    assert.match(v.reason, /收過/);
  });

  test('★ 已經有移轉進來的，訊息要講清楚是移轉來的', () => {
    const v = canBeTarget(B({ received_on: '2026-07-01', transfer_from_id: 'A' }));
    assert.equal(v.ok, false);
    assert.match(v.reason, /移轉/);
  });

  test('已退款的不能當目的', () => {
    assert.equal(canBeTarget(B({ received_on: '2026-06-01', returned_on: '2026-07-01' })).ok, false);
  });
});

describe('配對', () => {
  test('等額同幣別可以移', () => {
    assert.equal(canTransfer(A(), B()).ok, true);
  });

  test('★★ 同一筆不能移給自己', () => {
    assert.equal(canTransfer(A(), A()).ok, false);
  });

  test('★★ 金額不同一律擋，訊息要帶差額', () => {
    /*
     * 為什麼不能放行:deposits.amount 是觸發器從 orders.deposit 同步的,
     * 移轉時改不動 B 那一欄 —— 下次訂單一存檔就被蓋回去。
     * 放行的話 B 會顯示一個從來沒收到的數字。
     */
    const v = canTransfer(A({ amount: 30_000 }), B({ amount: 40_000 }));
    assert.equal(v.ok, false);
    assert.match(v.reason, /10,000/);          // 差額要出現
    assert.match(v.hint ?? '', /30,000/);      // 兩個原始數字也要
    assert.match(v.hint ?? '', /40,000/);
  });

  test('★ 差額訊息要指到正確的地方改（訂單／契約）', () => {
    assert.match(canTransfer(A(), B({ amount: 1 })).hint ?? '', /訂單/);
    assert.match(
      canTransfer(A(), B({ amount: 1, order_id: null, contract_id: 'c1' })).hint ?? '', /契約/);
  });

  test('★★ 幣別不同一律擋 —— 換匯是另一件事', () => {
    const v = canTransfer(A({ currency: 'JPY' }), B({ currency: 'TWD' }));
    assert.equal(v.ok, false);
    assert.match(v.reason, /幣別/);
  });

  test('★ 小數的金額用整數分比，不要踩浮點數', () => {
    // 30000.1 !== 30000.1 這種事在浮點數加減之後真的會發生
    assert.equal(canTransfer(A({ amount: 0.1 + 0.2 }), B({ amount: 0.3 })).ok, true);
  });

  test('★ 訊息要說明是來源不行還是目的不行', () => {
    // 只說「不能移轉」的話,人會去改錯的那一邊
    assert.match(canTransfer(A({ received_on: null }), B()).reason, /來源/);
    assert.match(canTransfer(A(), B({ received_on: '2026-07-01' })).reason, /目的/);
  });
});

describe('挑來源的清單', () => {
  const ROWS = [
    A({ id: 'a1', room: 'A101', received_on: '2026-05-01' }),
    A({ id: 'a2', room: 'A102', received_on: '2026-07-01', guest_name: '陳先生' }),
    A({ id: 'a3', room: 'A103', received_on: null }),                   // 還沒收
    A({ id: 'a4', room: 'A104', returned_on: '2026-06-01' }),           // 已退
    A({ id: 'a5', room: 'A105', orphaned: true }),                      // 孤兒
  ];

  test('★★ 只列得出可以當來源的', () => {
    const c = transferCandidates(ROWS, B());
    assert.deepEqual(c.map((x) => x.dep.id), ['a2', 'a1']);
  });

  test('★★ 目的自己不會出現在清單裡', () => {
    // 出現的話點下去就是「移給自己」,而那看起來會像成功了
    const self = A({ id: 'self', received_on: '2026-05-01' });
    const c = transferCandidates([...ROWS, self], { ...self, id: 'self' } as TransferDep);
    assert.equal(c.some((x) => x.dep.id === 'self'), false);
  });

  test('★ 收款日新到舊 —— 剛換房的通常是最近收的那筆', () => {
    const c = transferCandidates(ROWS, B());
    assert.equal(c[0].dep.received_on, '2026-07-01');
  });

  test('搜房號、姓名、金額都找得到', () => {
    assert.equal(transferCandidates(ROWS, B(), 'A101').length, 1);
    assert.equal(transferCandidates(ROWS, B(), '陳先生').length, 1);
    assert.equal(transferCandidates(ROWS, B(), '30000').length, 2);
  });

  test('★★ 不用姓名自動比對 —— 換房常常也換人', () => {
    /*
     * 原本兩人住、剩一人續租的情況很常見。照姓名濾的話那些會全部消失,
     * 而使用者只會看到「找不到」,不會知道是被條件濾掉的。
     */
    const c = transferCandidates(ROWS, B({ guest_name: '完全不同的名字' }));
    assert.equal(c.length, 2);
  });

  test('★ 不能移的也帶著原因回來，不是直接消失', () => {
    // 金額不同的那筆要看得到「差多少」,不然使用者不知道該去改什麼
    const c = transferCandidates(ROWS, B({ amount: 99_999 }));
    assert.equal(c.length, 2);
    assert.equal(c.every((x) => !x.verdict.ok), true);
    assert.match(c[0].verdict.reason, /金額不同/);
  });
});

describe('挑目的的清單（從來源那邊開始）', () => {
  /*
   * 【為什麼這個方向也要有】（2026-08-19，實際操作時卡住）
   *
   * 原本入口只放在目的那一筆。但人手上先有的是**要移走的那筆押金** ——
   * 點進去卻什麼按鈕都沒有,而他不會想到「要去新房間那邊按」。
   */
  const ROWS = [
    B({ id: 'b1', room: 'B201' }),
    B({ id: 'b2', room: 'B101' }),
    B({ id: 'b3', room: 'B301', received_on: '2026-07-01' }),   // 已收過
    B({ id: 'b4', room: 'B401', orphaned: true }),              // 孤兒
  ];

  test('★★ 只列得出還沒收押金的', () => {
    const c = transferTargets(ROWS, A());
    assert.deepEqual(c.map((x) => x.dep.id).sort(), ['b1', 'b2']);
  });

  test('★★ 來源自己不會出現在清單裡', () => {
    const self = A({ id: 'self', received_on: null });
    assert.equal(
      transferTargets([...ROWS, self], self).some((x) => x.dep.id === 'self'), false);
  });

  test('★ 金額不同的排後面，但仍然看得到原因', () => {
    const c = transferTargets([...ROWS, B({ id: 'b9', room: 'B999', amount: 55_000 })], A());
    assert.equal(c[c.length - 1].dep.id, 'b9');
    assert.match(c[c.length - 1].verdict.reason, /金額不同/);
  });

  test('搜房號找得到', () => {
    assert.equal(transferTargets(ROWS, A(), 'B101').length, 1);
  });

  test('★ 兩個方向對同一組答案要一致', () => {
    // 不一致的話會出現「從 A 看得到 B,從 B 看不到 A」,而那沒有人查得出原因
    const a = A(); const b = B();
    assert.equal(canTransfer(a, b).ok, transferTargets([b], a)[0].verdict.ok);
    assert.equal(canTransfer(a, b).ok, transferCandidates([a], b)[0].verdict.ok);
  });
});

describe('狀態標籤', () => {
  const nameOf = (id: string) => ({ A: 'A101', B: 'B202' } as Record<string, string>)[id] ?? null;

  test('★★ 移轉出去要顯示「已移轉」，不能跟「已退」共用一個標籤', () => {
    /*
     * 同一個 returned_on 兩種意思:一個錢匯給房客了,一個錢還在我們手上。
     * 共用灰標籤的話,看清單的人會以為錢退出去了。
     */
    const c = transferChip({ transfer_to_id: 'B', transfer_from_id: null }, nameOf);
    assert.equal(c?.dir, 'out');
    assert.match(c!.text, /已移轉/);
    assert.match(c!.text, /B202/);
  });

  test('移轉進來要看得出來自哪裡', () => {
    const c = transferChip({ transfer_to_id: null, transfer_from_id: 'A' }, nameOf);
    assert.equal(c?.dir, 'in');
    assert.match(c!.text, /A101/);
  });

  test('不是移轉的回 null —— 照原本的狀態標籤走', () => {
    assert.equal(transferChip({ transfer_to_id: null, transfer_from_id: null }, nameOf), null);
  });

  test('對方那筆載不到時也要顯示得出來，不要變成空白', () => {
    const c = transferChip({ transfer_to_id: 'zzz', transfer_from_id: null }, () => null);
    assert.match(c!.text, /已移轉/);
  });

  test('isTransfer 兩邊都算', () => {
    assert.equal(isTransfer({ transfer_to_id: 'B', transfer_from_id: null }), true);
    assert.equal(isTransfer({ transfer_to_id: null, transfer_from_id: 'A' }), true);
    assert.equal(isTransfer({ transfer_to_id: null, transfer_from_id: null }), false);
  });
});

describe('名稱', () => {
  test('房號優先，沒有就用姓名，都沒有也不要空白', () => {
    assert.equal(depName({ room: 'A101', guest_name: '林' }), 'A101');
    assert.equal(depName({ room: '  ', guest_name: '林' }), '林');
    assert.equal(depName({ room: null, guest_name: null }), '（未填房號）');
  });
});
