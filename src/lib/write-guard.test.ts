import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeError, wrote, rowsWritten } from './write-guard.ts';

describe('writeError —— 寫入之後有沒有真的改到列', () => {
  test('改到一列 → null', () => {
    assert.equal(writeError({ data: [{ id: 'a' }], error: null }), null);
  });
  test('改到很多列 → null', () => {
    assert.equal(writeError({ data: [{ id: 'a' }, { id: 'b' }], error: null }), null);
  });

  test('★★★ 回成功但 0 列（RLS 擋下來）→ 要講出來', () => {
    const m = writeError({ data: [], error: null }, '儲存');
    assert.ok(m?.startsWith('儲存沒有改到任何一列'), m ?? '(null)');
    assert.ok(m?.includes('權限或關帳'));
  });

  test('★★ data 是 undefined（忘了 .select(\'id\')）→ 不可以當成功', () => {
    const m = writeError({ error: null }, '刪除');
    assert.ok(m?.includes("少了 .select('id')"), m ?? '(null)');
  });
  test('data 是 null 同樣不算成功', () => {
    assert.ok(writeError({ data: null, error: null }) !== null);
  });

  test('有 error → 把資料庫的話帶出來', () => {
    const m = writeError({ data: null, error: { message: 'permission denied' } }, '收款');
    assert.equal(m, '收款失敗：permission denied');
  });
  test('error 沒有 message 也不會印 undefined', () => {
    const m = writeError({ data: null, error: {} }, '更新');
    assert.equal(m, '更新失敗：未知錯誤');
  });
  test('整個回傳是 null／undefined', () => {
    assert.ok(writeError(null)?.includes('沒有收到回應'));
    assert.ok(writeError(undefined)?.includes('沒有收到回應'));
  });
  test('what 預設是「更新」', () => {
    assert.ok(writeError({ data: [], error: null })?.startsWith('更新沒有改到'));
  });

  test('★ error 優先於 0 列 —— 有錯就講錯，不要講「多半是權限」', () => {
    const m = writeError({ data: [], error: { message: 'boom' } }, '儲存');
    assert.equal(m, '儲存失敗：boom');
  });
});

describe('wrote / rowsWritten', () => {
  test('wrote', () => {
    assert.equal(wrote({ data: [{ id: 'a' }], error: null }), true);
    assert.equal(wrote({ data: [], error: null }), false);
    assert.equal(wrote({ error: null }), false);
  });
  test('rowsWritten 回筆數', () => {
    assert.equal(rowsWritten({ data: [{ id: 'a' }, { id: 'b' }], error: null }), 2);
    assert.equal(rowsWritten({ data: [], error: null }), 0);
  });
  test('rowsWritten：有錯或沒接 select 回 null（跟 0 分得開）', () => {
    assert.equal(rowsWritten({ data: null, error: { message: 'x' } }), null);
    assert.equal(rowsWritten({ error: null }), null);
  });
});
