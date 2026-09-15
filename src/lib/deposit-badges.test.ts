import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { depBadges } from './deposit-transfer.ts';

/*
 * ══════════════════════════════════════════════════════════
 * 押金狀態：有收款日 ≠ 收滿（2026-09-15）
 *
 * 19B3 碩美的押金在列表上顯示綠色的「全收」，
 * 而點進去的抽屜寫「部分收款・尚欠 $175,000」——
 * 同一筆錢，兩個地方各說各話。
 *
 *     應收 350,000　已收 175,000（訂金轉入）　received_on = 2026-09-15
 *
 * `depBadges` 原本是 `if (received_on) return 'paid'`，
 * 理由寫著「received_on 只有收滿才會被觸發器填上」——
 * 而「訂金轉押金」那條路徑**沒收滿也寫了 received_on**。
 *
 * ★ 教訓跟今天押金守衛那支一樣：**別信代理欄位，直接比事實**。
 *   `received_on` 是「收滿了沒」的代理，
 *   而 `received_amount` / `amount` 就是答案本身。
 * ══════════════════════════════════════════════════════════
 */

const D = (o: Record<string, unknown> = {}) => ({
  transfer_to_id: null, transfer_from_id: null, orphaned: false,
  received_on: null, returned_on: null,
  received_amount: null, amount: 350000, ...o,
} as any);

describe('★★★ 押金狀態：有收款日不等於收滿', () => {
  test('★★★ 訂金轉入一半 → 收部分，不是全收（2026-09-15 的 bug）', () => {
    const d = D({ received_on: '2026-09-15', received_amount: 175000, amount: 350000 });
    assert.equal(depBadges(d).pay, 'partial');
  });

  test('★ 收滿了才是全收', () => {
    assert.equal(depBadges(D({ received_on: '2026-09-15', received_amount: 350000, amount: 350000 })).pay, 'paid');
  });

  test('★ 超收也算全收 —— 多收是另一件事，不該在這一欄講', () => {
    assert.equal(depBadges(D({ received_on: '2026-09-15', received_amount: 360000, amount: 350000 })).pay, 'paid');
  });

  /*
   * ★★★ 「改成比金額會不會誤傷舊資料」—— **查過了**（2026-09-15）:
   *   89 筆有收款日的押金，`received_amount` 全部都有值，
   *   null 與 0 各 0 筆。所以不留「金額是 0 就當作收滿」那道護欄 ——
   *   留著的話，「有收款日卻一毛沒收」這種真正的錯誤會顯示成綠色的「全收」。
   *
   * ★ 這一條釘的就是那個決定:有收款日、金額是 0 → **收部分**，不是全收。
   */
  test('★★★ 有收款日但一毛沒收 → 收部分（不放過這種錯）', () => {
    assert.equal(depBadges(D({ received_on: '2026-09-15', received_amount: 0, amount: 350000 })).pay, 'partial');
  });

  test('★ 應收是 0 的話不降級 —— 沒有「收滿」可言', () => {
    assert.equal(depBadges(D({ received_on: '2026-09-15', received_amount: 0, amount: 0 })).pay, 'paid');
  });

  test('沒有收款日、收了一部分 → 收部分（既有行為，不動）', () => {
    assert.equal(depBadges(D({ received_on: null, received_amount: 175000 })).pay, 'partial');
  });

  test('沒有收款日、一毛都沒收 → 尚未收', () => {
    assert.equal(depBadges(D()).pay, 'unpaid');
  });

  test('★ 孤兒、已移轉、已退還是優先 —— 收了多少不影響那三種', () => {
    assert.equal(depBadges(D({ orphaned: true, received_on: '2026-09-15', received_amount: 175000 })).pay, 'orphan');
    assert.equal(depBadges(D({ transfer_to_id: 'x', received_on: '2026-09-15', received_amount: 175000 })).pay, 'transferred');
    assert.equal(depBadges(D({ returned_on: '2026-09-20', received_on: '2026-09-15', received_amount: 175000 })).pay, 'returned');
  });

  test('★ 移轉進來又沒收滿 → 兩個標籤都要在（migration_147 那次修的）', () => {
    const b = depBadges(D({ transfer_from_id: 'x', received_on: '2026-09-15', received_amount: 175000 }));
    assert.equal(b.pay, 'partial');
    assert.equal(b.showFrom, true, '移轉來歷不能被收款狀態蓋掉');
  });
});
