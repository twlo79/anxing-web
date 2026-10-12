import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mixRequests, countByKind, filterKind, emptyText, type MixItem } from './request-mix.ts';

const I = (kind: MixItem<null>['kind'], key: string, at: string): MixItem<null> => ({ kind, key, at, row: null });
const L = [
  I('ot', 'o1', '2026-10-04T10:00:00Z'),
  I('leave', 'l1', '2026-10-06T08:00:00Z'),
  I('fix', 'f1', '2026-10-07T09:00:00Z'),
  I('leave', 'l2', '2026-10-04T10:00:00Z'),
];

test('待審：最舊的在上；同一刻依種類', () => {
  assert.deepEqual(mixRequests(L, true).map((x) => x.key), ['l2', 'o1', 'l1', 'f1']);
});

test('其他：最新的在上', () => {
  assert.deepEqual(mixRequests(L, false).map((x) => x.key), ['f1', 'l1', 'l2', 'o1']);
});

test('不改原陣列', () => {
  const before = L.map((x) => x.key);
  mixRequests(L, true);
  assert.deepEqual(L.map((x) => x.key), before);
});

test('countByKind／filterKind', () => {
  assert.deepEqual(countByKind(L), { leave: 2, ot: 1, fix: 1 });
  assert.deepEqual(countByKind([]), { leave: 0, ot: 0, fix: 0 });
  assert.deepEqual(filterKind(L, 'leave').map((x) => x.key), ['l1', 'l2']);
  assert.equal(filterKind(L, '').length, 4);
});

test('emptyText', () => {
  assert.equal(emptyText('', '沒有待處理的'), '沒有待處理的單');
  assert.equal(emptyText('ot', '沒有待處理的'), '沒有待處理的加班');
});
