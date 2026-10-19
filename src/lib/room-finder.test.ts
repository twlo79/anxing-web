import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findRooms, finderError, nightsBetween, splitPrice } from './room-finder.ts';
import type { Stay } from './room-calendar.ts';

const o = (room: string, start: string, end: string): Stay => ({ id: `o${room}${start}`, room, kind: 'order', start, end, tone: 'short' });

test('找房：起訖檢查', () => {
  assert.equal(nightsBetween('2026-11-18', '2026-11-25'), 7);
  assert.match(finderError('', '2026-11-25') ?? '', /都要填/);
  assert.match(finderError('2026-11-25', '2026-11-18') ?? '', /之後/);
  assert.equal(finderError('2026-11-18', '2026-11-25'), null);
});

test('找房：整段空房（退房那晚不算）', () => {
  const r = findRooms(['A01', 'A02', 'A11'], [o('A01', '2026-11-01', '2026-12-01'), o('A02', '2026-11-24', '2026-11-30')], '2026-11-18', '2026-11-25');
  assert.equal(r.kind, 'full');
  if (r.kind === 'full') assert.deepEqual(r.rooms, ['A11']);
  // A02 11/25 才入住 → 11/18～11/25 也是空的
  const r2 = findRooms(['A02'], [o('A02', '2026-11-25', '2026-11-30')], '2026-11-18', '2026-11-25');
  assert.equal(r2.kind, 'full');
});

test('找房：只能拼 —— 換房最少、第一段住久的排前面', () => {
  const st = [o('A04', '2026-11-18', '2026-11-21'), o('A06', '2026-11-18', '2026-11-21'), o('A09', '2026-11-21', '2026-12-01')];
  const r = findRooms(['A04', 'A06', 'A09'], st, '2026-11-18', '2026-11-25');
  assert.equal(r.kind, 'mix');
  if (r.kind !== 'mix') return;
  assert.equal(r.plans.length, 2);
  assert.deepEqual(r.plans[0], [
    { room: 'A09', from: '2026-11-18', to: '2026-11-21', nights: 3 },
    { room: 'A04', from: '2026-11-21', to: '2026-11-25', nights: 4 },
  ]);
  assert.equal(r.plans[1][1].room, 'A06');
});

test('找房：某幾晚整個物業都滿 → 沒有空房，講出是哪幾晚', () => {
  const st = [o('A01', '2026-11-22', '2026-11-24'), o('A02', '2026-11-20', '2026-11-30')];
  const r = findRooms(['A01', 'A02'], st, '2026-11-18', '2026-11-25');
  assert.equal(r.kind, 'none');
  if (r.kind === 'none') assert.deepEqual(r.fullNights, ['2026-11-22', '2026-11-23']);
});

test('拼房分錢：照晚數攤、零頭給最後一段', () => {
  assert.deepEqual(splitPrice(10000, [{ nights: 3 }, { nights: 4 }]), [4285, 5715]);
  assert.deepEqual(splitPrice(0, [{ nights: 3 }, { nights: 4 }]), [0, 0]);
});
