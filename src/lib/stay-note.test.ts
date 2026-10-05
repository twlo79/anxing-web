import { test } from 'node:test';
import assert from 'node:assert/strict';
import { noteTable, normNote, noteChanged, noteSaveError } from './stay-note.ts';

test('備註存回原本那張表：訂單 → orders，契約 → contracts', () => {
  assert.equal(noteTable('order'), 'orders');
  assert.equal(noteTable('contract'), 'contracts');
});
test('normNote：去頭尾空白，空的存 null，中間換行保留', () => {
  assert.equal(normNote('  每週三換床單\n11/15 家人來訪  '), '每週三換床單\n11/15 家人來訪');
  assert.equal(normNote('   \n '), null);
  assert.equal(normNote(null), null);
});
test('noteChanged：只差空白不算改', () => {
  assert.equal(noteChanged('abc', ' abc '), false);
  assert.equal(noteChanged(null, ''), false);
  assert.equal(noteChanged('abc', 'abd'), true);
});
test('★★ RLS 擋下＝0 列，要說沒存到，不能說已儲存', () => {
  assert.equal(noteSaveError(null, [{ id: 'x' }]), null);
  assert.match(noteSaveError(null, [])!, /沒存到/);
  assert.match(noteSaveError(null, null)!, /沒存到/);
  assert.match(noteSaveError({ message: 'boom' }, null)!, /boom/);
});
