import test from 'node:test';
import assert from 'node:assert/strict';
import { METHOD_LABEL, METHOD_OPTS, needsAccount, normalizeMethod, methodText } from './pay-method.ts';

test('四個選項齊全,而且每個都有中文標籤', () => {
  assert.deepEqual(METHOD_OPTS, ['cash', 'transfer', 'credit_card', 'crypto']);
  for (const m of METHOD_OPTS) assert.ok(METHOD_LABEL[m], `${m} 沒有標籤`);
  assert.equal(METHOD_LABEL.transfer, '匯款');
  assert.equal(METHOD_LABEL.crypto, '加密貨幣');
});

test('needsAccount:只有匯款要帳號', () => {
  assert.equal(needsAccount('transfer'), true);
  assert.equal(needsAccount('cash'), false);
  assert.equal(needsAccount('credit_card'), false);
  assert.equal(needsAccount('crypto'), false);
  assert.equal(needsAccount(null), false);
});

test('normalizeMethod:匯款保留帳號', () => {
  assert.deepEqual(normalizeMethod('transfer', '8088'), { method: 'transfer', account: '8088' });
});

test('normalizeMethod:非匯款一律把帳號清成 null', () => {
  // 使用者先選匯款+8088,再改成現金 —— 舊帳號不清掉的話,
  // 這筆現金會出現在元大 8088 的對帳明細裡
  assert.deepEqual(normalizeMethod('cash', '8088'), { method: 'cash', account: null });
  assert.deepEqual(normalizeMethod('crypto', '8088'), { method: 'crypto', account: null });
  assert.deepEqual(normalizeMethod('credit_card', '0564'), { method: 'credit_card', account: null });
});

test('normalizeMethod:匯款但沒選帳號 → null,不是空字串', () => {
  // 空字串存進去會違反 payment_accounts 的外鍵
  assert.deepEqual(normalizeMethod('transfer', ''), { method: 'transfer', account: null });
});

test('methodText:匯款顯示帳戶名稱', () => {
  assert.equal(methodText('transfer', '8088', { 8088: '元大 8088' }), '匯款・元大 8088');
});

test('methodText:對不到名稱就顯示代碼,不要變成 undefined', () => {
  assert.equal(methodText('transfer', '9999', {}), '匯款・9999');
});

test('methodText:非匯款只顯示方式', () => {
  assert.equal(methodText('cash', null, {}), '現金');
  assert.equal(methodText('crypto', null, {}), '加密貨幣');
});

test('methodText:沒有方式回破折號', () => {
  assert.equal(methodText(null, null, {}), '—');
});
