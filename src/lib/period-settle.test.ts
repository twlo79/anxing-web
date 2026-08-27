import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  restOf, shouldAutoSettle, autoSettleBlockedReason, autoSettleMessage, lastPaidOn,
} from './period-settle.ts';

/**
 * 這一支釘的是**自動**行為。判斷錯的方向是整期無聲變綠，
 * 而那一期的錢實際上沒收齊 —— 沒有人會再看它一眼。
 */

test('restOf：還差多少', () => {
  assert.equal(restOf({ due: 155000, paid: 100000 }), 55000);
  assert.equal(restOf({ due: 155000, paid: 0 }), 155000);
});

test('★ 收滿或超收都回 0，不是負數', () => {
  assert.equal(restOf({ due: 155000, paid: 155000 }), 0);
  assert.equal(restOf({ due: 155000, paid: 160000 }), 0);
});

test('null / undefined 當 0，不要變 NaN', () => {
  assert.equal(restOf({ due: null, paid: null }), 0);
  assert.equal(restOf({ due: 100, paid: undefined }), 100);
});

test('★★ 剛好收滿 → 自動結清', () => {
  assert.equal(shouldAutoSettle({ due: 155000, paid: 155000 }), true);
});

test('★★ 還沒收滿 → 不自動', () => {
  assert.equal(shouldAutoSettle({ due: 155000, paid: 154999 }), false);
  assert.equal(shouldAutoSettle({ due: 155000, paid: 0 }), false);
});

test('★★ 超收 → 不自動（金額可能填錯，要人看一眼）', () => {
  assert.equal(shouldAutoSettle({ due: 155000, paid: 155001 }), false);
  // 多打一個 0
  assert.equal(shouldAutoSettle({ due: 155000, paid: 1550000 }), false);
});

test('★★ 應收 0 或負數 → 不自動（沒有「收滿」可言）', () => {
  // 整筆招待 / 純折讓的期別。自動的話一開畫面就變綠,而沒有錢進來過
  assert.equal(shouldAutoSettle({ due: 0, paid: 0 }), false);
  assert.equal(shouldAutoSettle({ due: 0, paid: 100 }), false);
  assert.equal(shouldAutoSettle({ due: -500, paid: 0 }), false);
});

test('金額比較前先四捨五入到整數（跟 order-payment 同一套規則）', () => {
  assert.equal(shouldAutoSettle({ due: 155000.4, paid: 155000 }), true);
  assert.equal(shouldAutoSettle({ due: 155000, paid: 154999.6 }), true);
});

test('★ 超收要講得出原因、而且要說差多少', () => {
  const r = autoSettleBlockedReason({ due: 155000, paid: 160000 });
  assert.ok(r);
  assert.match(r!, /155,000/);
  assert.match(r!, /160,000/);
  assert.match(r!, /5,000/);
});

test('沒收滿不用解釋 —— 畫面上「尚欠」就是答案', () => {
  assert.equal(autoSettleBlockedReason({ due: 155000, paid: 100000 }), null);
  assert.equal(autoSettleBlockedReason({ due: 0, paid: 0 }), null);
});

test('自動結清的提示要有金額與收款日', () => {
  const m = autoSettleMessage(155000, '2026-09-24');
  assert.match(m, /155,000/);
  assert.match(m, /2026-09-24/);
});

test('★★ lastPaidOn 取最大的日期，不是陣列最後一筆', () => {
  // 補登一筆早幾天的收款時,那筆排在後面但日期比較早 ——
  // 拿它當收款日的話整期的收款日會往回跳,而那決定算哪個月的收入
  assert.equal(lastPaidOn([
    { paid_on: '2026-09-20' },
    { paid_on: '2026-09-24' },
    { paid_on: '2026-09-22' },
  ]), '2026-09-24');
});

test('lastPaidOn：空的、空字串、null 都要撐得住', () => {
  assert.equal(lastPaidOn([]), null);
  assert.equal(lastPaidOn([{ paid_on: null }, { paid_on: '' }]), null);
  assert.equal(lastPaidOn([{ paid_on: null }, { paid_on: '2026-09-01' }]), '2026-09-01');
});
