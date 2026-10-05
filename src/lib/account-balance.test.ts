import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cardBalance, stmtDiffers } from './account-balance.ts';

test('cardBalance：有流水就看最後一筆（2026-10-05 24145 那次）', () => {
  assert.equal(cardBalance({ manual: false, lastTxnBalance: 4775684, stmtClosing: 2728106 }), 4775684);
});
test('cardBalance：銀行帳戶沒有流水才退回對帳單期末', () => {
  assert.equal(cardBalance({ manual: false, stmtClosing: 2728106 }), 2728106);
  assert.equal(cardBalance({ manual: false }), null);
});
test('cardBalance：現金帳戶沒有流水退回期初', () => {
  assert.equal(cardBalance({ manual: true, opening: 500 }), 500);
  assert.equal(cardBalance({ manual: true, lastTxnBalance: 0, opening: 500 }), 0, '餘額 0 是真的 0，不是沒有');
});
test('stmtDiffers', () => {
  assert.equal(stmtDiffers(4775684, 2728106), true);
  assert.equal(stmtDiffers(38838, 38838), false);
  assert.equal(stmtDiffers(1, null), false);
});
test('★ 帳戶明細頁不准自己拿 closing_balance 當卡片餘額（要走 cardBalance）', () => {
  const src = readFileSync(new URL('../app/(app)/accounts/page.tsx', import.meta.url), 'utf8');
  assert.match(src, /cardBalance\(/);
  assert.doesNotMatch(src, /value=\{money\([^)]*closing_balance/, '卡片的 value 直接讀 closing_balance');
  assert.doesNotMatch(src, /balance:\s*[^,\n]*closing_balance/, '合計的 balance 直接讀 closing_balance');
});
