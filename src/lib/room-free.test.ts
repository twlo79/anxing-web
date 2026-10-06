import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dayBefore, busyOfOrder, busyOfContract, roomFree, freeRooms, nightsLabel } from './room-free.ts';

const A05 = { id: 'p5', name: 'A05', estate_id: 'e1' };
const A09 = { id: 'p9', name: 'A09', estate_id: 'e1' };

test('前一天：跨月、跨年', () => {
  assert.equal(dayBefore('2026-11-01'), '2026-10-31');
  assert.equal(dayBefore('2027-01-01'), '2026-12-31');
});
test('★ 退房日當天可以接新客：10/08 退房的單不擋 10/08 入住', () => {
  const b = [busyOfOrder({ property_id: 'p5', checkin: '2026-10-05', checkout: '2026-10-08' })!];
  assert.equal(roomFree(b, A05, '2026-10-08', '2026-10-10'), true);
  assert.equal(roomFree(b, A05, '2026-10-07', '2026-10-10'), false);
});
test('★ 整段都要空：中間有一晚被佔就不列', () => {
  const b = [busyOfOrder({ property_id: 'p5', checkin: '2026-10-12', checkout: '2026-10-13' })!];
  assert.equal(roomFree(b, A05, '2026-10-08', '2026-10-15'), false);
  assert.equal(roomFree(b, A05, '2026-10-08', '2026-10-12'), true);   // 最後一晚 10/11
});
test('契約的迄就是最後一晚（含）', () => {
  const b = [busyOfContract({ property_id: 'p9', start_date: '2026-09-01', end_date: '2026-10-08' })!];
  assert.equal(roomFree(b, A09, '2026-10-08', '2026-10-10'), false);
  assert.equal(roomFree(b, A09, '2026-10-09', '2026-10-10'), true);
});
test('沒有 property_id 的用 物業＋房號 對', () => {
  const b = [busyOfOrder({ estate_id: 'e1', property_raw: 'A05', checkin: '2026-10-08', checkout: '2026-10-09' })!];
  assert.deepEqual(freeRooms(b, [A05, A09], '2026-10-08', '2026-10-10').map((r) => r.name), ['A09']);
});
test('顯示：第一晚 ～ 最後一晚（不算退房日）', () => {
  assert.equal(nightsLabel('2026-10-08', '2026-10-10'), '10/08 ～ 10/09');
  assert.equal(nightsLabel('2026-10-13', '2026-10-15'), '10/13 ～ 10/14');
});
