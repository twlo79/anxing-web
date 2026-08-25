import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeBuckets, totalBuckets, type Bucket } from './deposit-summary.ts';

const b = (n: number, cur: Record<string, number>): Bucket => ({ n, cur });

test('筆數相加、同幣別金額相加', () => {
  assert.deepEqual(
    mergeBuckets(b(3, { TWD: 100 }), b(2, { TWD: 50 })),
    { n: 5, cur: { TWD: 150 } },
  );
});

test('★ 外幣不能消失 —— 只有一邊有的幣別要留著', () => {
  assert.deepEqual(
    mergeBuckets(b(1, { TWD: 100 }), b(1, { USD: 700 })),
    { n: 2, cur: { TWD: 100, USD: 700 } },
  );
});

test('三種幣別各自加各自的', () => {
  assert.deepEqual(
    mergeBuckets(b(1, { TWD: 10, USD: 1 }), b(1, { TWD: 20, JPY: 5 }), b(1, { USD: 2 })),
    { n: 3, cur: { TWD: 30, USD: 3, JPY: 5 } },
  );
});

test('空的分類不影響結果', () => {
  assert.deepEqual(mergeBuckets(b(0, {}), b(4, { TWD: 9 })), { n: 4, cur: { TWD: 9 } });
  assert.deepEqual(mergeBuckets(), { n: 0, cur: {} });
});

test('不會改到傳進來的東西（卡片還要用同一份）', () => {
  const a = b(1, { TWD: 100 });
  mergeBuckets(a, b(1, { TWD: 1 }));
  assert.deepEqual(a, { n: 1, cur: { TWD: 100 } });
});

test('totalBuckets：訂金＋押金，三個階段各自合併', () => {
  const earn = { pending: b(1, { TWD: 10 }), held: b(2, { TWD: 20 }), returned: b(3, { TWD: 30 }) };
  const dep = { pending: b(4, { TWD: 40 }), held: b(5, { USD: 7 }), returned: b(6, { TWD: 60 }) };
  const t = totalBuckets(earn, dep);
  assert.deepEqual(t.pending, { n: 5, cur: { TWD: 50 } });
  assert.deepEqual(t.held, { n: 7, cur: { TWD: 20, USD: 7 } });
  assert.deepEqual(t.returned, { n: 9, cur: { TWD: 90 } });
});

test('負數（沖銷）也照加，不特別處理', () => {
  assert.deepEqual(mergeBuckets(b(1, { TWD: 100 }), b(1, { TWD: -30 })), { n: 2, cur: { TWD: 70 } });
});
