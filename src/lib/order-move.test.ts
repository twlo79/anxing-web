import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  moveStateOf, moveSegments, moveError, moveChain, movePatch, moveRpcSegs,
  wholeMove, splitMove, canQuickMove, splitDays, nightsIn, moveCandidates, type MoveState,
} from './order-move.ts';
import type { Busy } from './room-free.ts';

const R = (id: string, name: string, estate_id = 'E1') => ({ id, name, estate_id });
const ORDER = {
  id: 'o1', property_raw: '9A5', estate_id: 'E1', property_id: 'p5',
  checkin: '2026-10-08', checkout: '2026-10-13', amount: 14500, note: '晚到',
  guest_name: '王小明', source: 'airbnb', account: null,
};
const base = (): MoveState => moveStateOf([ORDER], 'o1');

test('moveStateOf：一段單', () => {
  const m = base();
  assert.equal(m.totalNights, 5);
  assert.equal(m.totalAmount, 14500);
  assert.deepEqual(m.origRooms, ['9A5']);
  assert.equal(m.origNote, '晚到');
  assert.equal(m.busy, null);
  assert.equal(canQuickMove(m), true);
});

test('moveStateOf：分段單取第一段的備註、總額加總', () => {
  const m = moveStateOf([
    { ...ORDER, amount: 8700, note: '第一段' },
    { ...ORDER, id: 'o2', property_raw: '9A6', checkin: '2026-10-11', checkout: '2026-10-13', amount: 5800, note: '第二段' },
  ], 'o1');
  assert.equal(m.totalAmount, 14500);
  assert.equal(m.checkout, '2026-10-13');
  assert.equal(m.origNote, '第一段');
  assert.deepEqual(m.origRooms, ['9A5', '9A6']);
  assert.equal(canQuickMove(m), false);
});

test('整段換一間：一段、金額不變', () => {
  const m = wholeMove(base(), R('p1', '9B1'));
  const segs = moveSegments(m);
  assert.equal(segs.length, 1);
  assert.equal(segs[0].room, '9B1');
  assert.equal(segs[0].propertyId, 'p1');
  assert.equal(segs[0].amount, 14500);
  assert.equal(segs[0].nights, 5);
  assert.equal(moveError(m), null);
});

test('從某天起換：照晚數拆、最後一段吃尾差', () => {
  const m = splitMove(base(), '2026-10-11', R('p6', '9A6'));
  const segs = moveSegments(m);
  assert.deepEqual(segs.map((s) => [s.room, s.from, s.to, s.nights, s.amount]), [
    ['9A5', '2026-10-08', '2026-10-11', 3, 8700],
    ['9A6', '2026-10-11', '2026-10-13', 2, 5800],
  ]);
  const odd = moveSegments(splitMove({ ...base(), totalAmount: 10000 }, '2026-10-09', R('p6', '9A6')));
  assert.equal(odd[0].amount + odd[1].amount, 10000);
});

test('moveError：沒選房、日期不對、有人住', () => {
  assert.equal(moveError({ ...base(), stays: [{ room: '', estateId: 'E1', propertyId: null, from: '2026-10-08' }] }), '每段都要選房源');
  assert.equal(moveError(splitMove(base(), '2026-10-08', R('p6', '9A6'))), '移入日期需晚於前一段');
  assert.equal(moveError(splitMove(base(), '2026-10-13', R('p6', '9A6'))), '每段至少 1 晚(日期需在期間內)');
  const busy: Busy[] = [{ propertyId: 'p6', estateId: 'E1', room: '9A6', first: '2026-10-01', last: '2026-10-10' }];
  assert.match(moveError({ ...wholeMove(base(), R('p6', '9A6')), busy }) ?? '', /9A6 在 10\/08 ～ 10\/12 有人住/);
  // 10/10 是最後一晚 → 10/11 起空
  assert.equal(moveError({ ...splitMove(base(), '2026-10-11', R('p6', '9A6')), busy }), null);
});

test('moveChain：去掉相鄰重複', () => {
  assert.deepEqual(moveChain(['B01'], ['B03']), ['B01', 'B03']);
  assert.deepEqual(moveChain(['B01'], ['B01', 'B03']), ['B01', 'B03']);
  assert.deepEqual(moveChain(['B01'], ['B01']), ['B01']);
  assert.deepEqual(moveChain([' B01 ', ''], ['B01']), ['B01']);
});

test('movePatch：備註追加不覆蓋、不重複加', () => {
  const m = wholeMove(base(), R('p1', '9B1'));
  assert.deepEqual(movePatch(m, moveSegments(m)), { move_chain: '9A5>9B1', note: '晚到\n移房 9A5>9B1' });
  const again = { ...m, origNote: '晚到\n移房 9A5>9B1' };
  assert.equal(movePatch(again, moveSegments(again)).note, '晚到\n移房 9A5>9B1');
  const blank = { ...m, origNote: null };
  assert.equal(movePatch(blank, moveSegments(blank)).note, '移房 9A5>9B1');
  const same = base();
  assert.deepEqual(movePatch(same, moveSegments(same)), {});
});

test('moveRpcSegs：欄位名對 RPC', () => {
  const m = wholeMove(base(), R('p1', '9B1'));
  assert.deepEqual(moveRpcSegs(moveSegments(m)), [{
    estate_id: 'E1', property_id: 'p1', room: '9B1', from: '2026-10-08', to: '2026-10-13', nights: 5, amount: 14500,
  }]);
});

test('splitDays／nightsIn', () => {
  assert.deepEqual(splitDays(base()), ['2026-10-09', '2026-10-10', '2026-10-11', '2026-10-12']);
  assert.deepEqual(nightsIn('2026-10-30', '2026-11-02'), ['2026-10-30', '2026-10-31', '2026-11-01']);
  assert.deepEqual(splitDays({ ...base(), checkout: '2026-10-09' }), []);
});

test('moveCandidates：只列同物業、排掉自己', () => {
  const rooms = [R('p5', '9A5'), R('p6', '9A6'), R('p3', '9A3'), R('p10', '10A1'), R('x1', '1F', 'E2'), R('x2', '2F', 'E2'), R('p7', '9A7')];
  const busy: Busy[] = [
    { propertyId: 'p6', estateId: 'E1', room: '9A6', first: '2026-10-01', last: '2026-10-10' }, // 部分
    { propertyId: 'p7', estateId: 'E1', room: '9A7', first: '2026-10-01', last: '2026-10-31' }, // 全滿
    { propertyId: 'x2', estateId: 'E2', room: '2F', first: '2026-10-09', last: '2026-10-09' },  // 別物業部分
  ];
  const c = moveCandidates(busy, rooms, '2026-10-08', '2026-10-13', 'p5', 'E1');
  assert.deepEqual(c.free.map((r) => r.name), ['9A3', '10A1']);   // 別物業的 1F 整段空也不列
  assert.deepEqual(c.partly.map((x) => [x.room.name, x.busyNights]), [['9A6', 3]]);
  // 原房沒設物業 → 一間都不列
  const none = moveCandidates(busy, rooms, '2026-10-08', '2026-10-13', 'p5', null);
  assert.deepEqual([none.free.length, none.partly.length], [0, 0]);
});
