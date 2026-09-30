import { test } from 'node:test';
import assert from 'node:assert/strict';
import { savedText, justRow, SAVED_EVENT, SAVED_TOAST_MS } from './saved-feedback.ts';

test('savedText：帶名字', () => assert.equal(savedText('已儲存', 'PR-202609-048'), '已儲存：PR-202609-048'));
test('savedText：沒名字就只有動詞', () => {
  assert.equal(savedText('已送出', ''), '已送出');
  assert.equal(savedText('已送出', null), '已送出');
});
test('savedText：動詞空的補「已儲存」', () => assert.equal(savedText('', 'x'), '已儲存：x'));
test('savedText：太長截斷、換行壓成空白', () => {
  const s = savedText('已儲存', '住宅火災及地震保險 A棟\n住宅火災及地震保險 B棟 還有很多很多字');
  assert.ok(s.length <= '已儲存：'.length + 28);
  assert.ok(s.endsWith('⋯'));
  assert.ok(!s.includes('\n'));
});
test('justRow：標的那一列才有屬性', () => {
  assert.deepEqual(justRow(true), { 'data-just-saved': '1' });
  assert.deepEqual(justRow(false), {});
});
test('常數沒被改掉（SavedToast 聽的是同一個名字）', () => {
  assert.equal(SAVED_EVENT, 'anxing:saved');
  assert.equal(SAVED_TOAST_MS, 2500);
});
