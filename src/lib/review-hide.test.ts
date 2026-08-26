import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canHideReview, isHidden, hideError, hideReasonText, hideImpactText, HIDE_REASONS,
} from './review-hide.ts';

test('★ 只有經理與總管理員能隱藏 —— 要跟 RLS 的 reviews_write 一致', () => {
  assert.equal(canHideReview('manager'), true);
  assert.equal(canHideReview('super_admin'), true);
  assert.equal(canHideReview('accountant'), false);
  assert.equal(canHideReview('housekeeper'), false);
  assert.equal(canHideReview('cleaner'), false);
  assert.equal(canHideReview(null), false);
  assert.equal(canHideReview(undefined), false);
});

test('isHidden 看的是 hidden_at', () => {
  assert.equal(isHidden({ id: 'a' }), false);
  assert.equal(isHidden({ id: 'a', hidden_at: null }), false);
  assert.equal(isHidden({ id: 'a', hidden_at: '2026-08-25T00:00:00Z' }), true);
});

test('★★ 理由必填 —— 查不到為什麼的話沒有人敢把它放回去', () => {
  assert.equal(hideError('', ''), '請選擇隱藏原因');
  assert.equal(hideError(null, null), '請選擇隱藏原因');
  assert.equal(hideError('   ', ''), '請選擇隱藏原因');
});

test('★ 選了「其他」就要說明', () => {
  assert.equal(hideError('其他', ''), '選了「其他」請說明原因');
  assert.equal(hideError('其他', '   '), '選了「其他」請說明原因');
  assert.equal(hideError('其他', '客服協調後撤下'), null);
});

test('選固定選項不用再填說明', () => {
  for (const r of HIDE_REASONS.filter((x) => x !== '其他')) {
    assert.equal(hideError(r, ''), null, r);
  }
});

test('hideReasonText：「其他」把自由輸入接在後面，兩個資訊都留著', () => {
  assert.equal(hideReasonText('其他', '客服協調後撤下'), '其他：客服協調後撤下');
  assert.equal(hideReasonText('重複的評價', ''), '重複的評價');
  // 「其他」但沒填（理論上被 hideError 擋掉了）也不要變成「其他：」
  assert.equal(hideReasonText('其他', ''), '其他');
  assert.equal(hideReasonText('其他', '  '), '其他');
});

test('★ 影響說明要講出星等與哪一棟', () => {
  assert.match(hideImpactText(4, '開封'), /4 星/);
  assert.match(hideImpactText(4, '開封'), /開封/);
  assert.match(hideImpactText(4, '開封'), /平均星等/);
});

test('沒有物業名或星等時仍講得出一句完整的話', () => {
  assert.match(hideImpactText(4, null), /4 星/);
  assert.match(hideImpactText(null, '開封'), /平均星等/);
  assert.doesNotMatch(hideImpactText(null, null), /undefined|null|NaN/);
  assert.doesNotMatch(hideImpactText(4, null), /「」/);
});
