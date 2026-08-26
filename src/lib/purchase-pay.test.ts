import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PAY_LABEL, PAY_OPTS, needsPayout, needsPayeeAccount, needsPlan,
  hasTransferFee, dateWord, acctWord, payLabel, accountMethodFor, payAccountsFor,
} from './purchase-pay.ts';

/**
 * 加新的付款方式時，最危險的不是「新的不能用」，
 * 是**舊的判斷式漏掉它**：那張單只會安靜地不出現在待排付款清單裡。
 * 所以每一支述詞都把五種方式全列一次。
 */

test('五種方式都有標籤，而且下拉選得到', () => {
  assert.deepEqual(PAY_OPTS, ['cash', 'transfer', 'credit_card', 'counter', 'autopay']);
  for (const m of PAY_OPTS) assert.ok(PAY_LABEL[m], m);
  assert.equal(PAY_LABEL.counter, '臨櫃');
  assert.equal(PAY_LABEL.autopay, '自動繳款');
});

test('★ 需要安幸付款帳號：現金以外全部都要', () => {
  assert.equal(needsPayout('cash'), false);
  assert.equal(needsPayout('transfer'), true);
  assert.equal(needsPayout('credit_card'), true);
  assert.equal(needsPayout('counter'), true);
  assert.equal(needsPayout('autopay'), true);
});

test('★★ 廠商收款帳號只有匯款必填 —— 臨櫃與自動繳款沒有匯款對象', () => {
  assert.equal(needsPayeeAccount('transfer'), true);
  assert.equal(needsPayeeAccount('counter'), false);
  assert.equal(needsPayeeAccount('autopay'), false);
  assert.equal(needsPayeeAccount('cash'), false);
  assert.equal(needsPayeeAccount('credit_card'), false);
});

test('★ 要先排付款：現金以外全部都要', () => {
  assert.equal(needsPlan('cash'), false);
  for (const m of ['transfer', 'credit_card', 'counter', 'autopay']) {
    assert.equal(needsPlan(m), true, m);
  }
});

test('沒選付款方式時不算「要排付款」—— 空的單不該擠進待排清單', () => {
  assert.equal(needsPlan(null), false);
  assert.equal(needsPlan(undefined), false);
  assert.equal(needsPlan(''), false);
});

test('★ 手續費維持只有匯款 —— 這次沒有跟著放寬', () => {
  assert.equal(hasTransferFee('transfer'), true);
  assert.equal(hasTransferFee('counter'), false);
  assert.equal(hasTransferFee('autopay'), false);
});

test('用詞：只有信用卡講「刷卡」', () => {
  assert.equal(dateWord('credit_card'), '刷卡日');
  assert.equal(acctWord('credit_card'), '刷卡卡片');
  for (const m of ['transfer', 'counter', 'autopay', 'cash']) {
    assert.equal(dateWord(m), '付款日', m);
    assert.equal(acctWord(m), '安幸付款帳號', m);
  }
});

test('payLabel：認不出來回原始值，不要變空白', () => {
  assert.equal(payLabel('counter'), '臨櫃');
  assert.equal(payLabel('mystery'), 'mystery');
  assert.equal(payLabel(null), '—');
  assert.equal(payLabel(''), '—');
});

test('★★ needsPayout 與 needsPlan 對每一種的答案一致 —— 兩者都是「現金以外」', () => {
  // 不一致的話會出現「排得進待付款卻沒有帳號可填」這種卡住的狀態
  for (const m of PAY_OPTS) assert.equal(needsPayout(m), needsPlan(m), m);
});

/*
 * ── 付款方式 → 可選帳號（2026-08-25）─────────────────
 *
 * payment_accounts 只有 transfer / credit_card 兩種 method，
 * 直接拿 payment_method 去比的話，臨櫃與自動繳款會篩出空清單 ——
 * 下拉打開只有「請選擇」，畫面上不會說為什麼。
 */
const ACCTS = [
  { code: 'A48088', method: 'transfer' },
  { code: 'A70564', method: 'transfer' },
  { code: 'CARD1', method: 'credit_card' },
];

test('★★ 臨櫃與自動繳款拿得到銀行帳戶（原本是空的）', () => {
  for (const m of ['counter', 'autopay']) {
    assert.deepEqual(payAccountsFor(ACCTS, m).map((a) => a.code), ['A48088', 'A70564'], m);
  }
});

test('匯款一樣是銀行帳戶', () => {
  assert.deepEqual(payAccountsFor(ACCTS, 'transfer').map((a) => a.code), ['A48088', 'A70564']);
});

test('信用卡只挑卡片，不該看到銀行帳戶', () => {
  assert.deepEqual(payAccountsFor(ACCTS, 'credit_card').map((a) => a.code), ['CARD1']);
});

test('★ 現金回空陣列，不是全部 —— 回全部會讓現金出現在元大明細裡', () => {
  assert.deepEqual(payAccountsFor(ACCTS, 'cash'), []);
  assert.deepEqual(payAccountsFor(ACCTS, null), []);
});

test('accountMethodFor：只有信用卡對到卡片', () => {
  assert.equal(accountMethodFor('credit_card'), 'credit_card');
  for (const m of ['transfer', 'counter', 'autopay']) {
    assert.equal(accountMethodFor(m), 'transfer', m);
  }
});

test('帳號清單是 null / 空的時候不炸', () => {
  assert.deepEqual(payAccountsFor(null, 'counter'), []);
  assert.deepEqual(payAccountsFor([], 'counter'), []);
});

test('★★ needsPayout 為真的每一種都挑得到帳號 —— 不然是選得到卻填不了', () => {
  for (const m of PAY_OPTS) {
    if (needsPayout(m)) assert.ok(payAccountsFor(ACCTS, m).length > 0, m);
  }
});
