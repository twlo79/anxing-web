import test from 'node:test';
import assert from 'node:assert/strict';
import { isStaleChunkError } from './stale-chunk.ts';

test('isStaleChunkError：Next 的 ChunkLoadError 三種長相都認得', () => {
  assert.equal(isStaleChunkError({ name: 'ChunkLoadError', message: 'x' }), true);
  assert.equal(isStaleChunkError(new Error('Loading chunk 5904 failed.\n(error: https://x/_next/static/chunks/5904.abc.js)')), true);
  assert.equal(isStaleChunkError(new Error('Failed to fetch dynamically imported module: https://x/a.js')), true);
});
test('isStaleChunkError：真的檔案壞掉不算', () => {
  assert.equal(isStaleChunkError(new Error("Can't find end of central directory")), false);
  assert.equal(isStaleChunkError(null), false);
  assert.equal(isStaleChunkError('隨便一句'), false);
});
