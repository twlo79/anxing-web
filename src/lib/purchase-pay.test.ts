import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PAY_LABEL, PAY_OPTS, needsPayout, needsPayeeAccount, needsPlan,
  hasTransferFee, dateWord, acctWord, payLabel,
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
