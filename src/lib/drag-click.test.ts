import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDragClick } from './drag-click.ts';

test('在輸入框按下、拖到背景放開 → 擋（不關表單）', () => {
  assert.equal(isDragClick({ sameTarget: false, clickContainsDown: true, dx: 120, dy: 40 }), true);
});

test('一般的點：同一個元素按下放開 → 不擋', () => {
  assert.equal(isDragClick({ sameTarget: true, clickContainsDown: true, dx: 0, dy: 0 }), false);
  assert.equal(isDragClick({ sameTarget: true, clickContainsDown: true, dx: 200, dy: 0 }), false);
});

test('按在按鈕的字上、放在按鈕邊緣（手抖幾 px）→ 不擋', () => {
  assert.equal(isDragClick({ sameTarget: false, clickContainsDown: true, dx: 3, dy: 2 }), false);
});

test('click 收到的元素不是按下那個的上層 → 不擋', () => {
  assert.equal(isDragClick({ sameTarget: false, clickContainsDown: false, dx: 100, dy: 0 }), false);
});
