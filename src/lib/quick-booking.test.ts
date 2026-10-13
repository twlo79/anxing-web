import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  occupiedRange, lengthOf, lengthText, draftFree, draftError, orderInsert, contractInsert, addDays,
  type BookingDraft,
} from './quick-booking.ts';
import type { Busy } from './room-free.ts';

const P: BookingDraft = {
  kind: 'private', name: ' 王小明 ', from: '2026-10-14', to: '2026-10-17',
  estateId: 'E1', propertyId: 'p1', room: '9B1', price: 9000, note: ' 晚到 ',
};
const C: BookingDraft = { ...P, kind: 'contract', from: '2026-11-01', to: '2027-04-30', price: 32000 };

test('兩種「迄」：私下是退房日、契約含最後一天', () => {
  assert.deepEqual(occupiedRange(P), { from: '2026-10-14', to: '2026-10-17' });
  assert.equal(lengthOf(P), 3);
  assert.deepEqual(occupiedRange(C), { from: '2026-11-01', to: '2027-05-01' });
  assert.equal(lengthOf(C), 181);
  // 契約起訖同一天＝1 天；私下同一天＝不成立
  assert.equal(lengthOf({ kind: 'contract', from: '2026-11-01', to: '2026-11-01' }), 1);
  assert.equal(occupiedRange({ kind: 'private', from: '2026-11-01', to: '2026-11-01' }), null);
});

test('lengthText', () => {
  assert.match(lengthText(P), /^住 3 晚（最後一晚 10\/16/);
  assert.match(lengthText(C), /^約 6 個月・181 天/);
  assert.equal(lengthText({ kind: 'private', from: '', to: '' }), '');
});

test('addDays 跨月跨年', () => {
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
});

test('draftError：照畫面順序一次講一件', () => {
  assert.equal(draftError({ ...P, from: '' }, []), '填住宿起訖');
  assert.equal(draftError({ ...C, to: '' }, []), '填租期起訖');
  assert.equal(draftError({ ...P, to: '2026-10-14' }, []), '退房日要在入住日之後');
  assert.equal(draftError({ ...C, to: '2026-10-31' }, []), '最後一天不能早於起租日');
  assert.equal(draftError({ ...P, estateId: null }, []), '選物業');
  assert.equal(draftError({ ...P, room: '' }, []), '選房源');
  assert.equal(draftError({ ...P, price: -1 }, []), '價格不能是負的');
  assert.equal(draftError({ ...C, price: null }, []), '契約要填月租金');
  assert.equal(draftError({ ...C, price: 0 }, []), '契約要填月租金');
  assert.equal(draftError({ ...P, price: null }, []), null);   // 私下可以先不填價格
  assert.equal(draftError(P, null), null);                      // 空房還沒載好不擋
});

test('有人住就擋：私下退房日當天可接、契約最後一天要算', () => {
  const busy: Busy[] = [{ propertyId: 'p1', estateId: 'E1', room: '9B1', first: '2026-10-17', last: '2026-10-20' }];
  assert.equal(draftFree(busy, P), true);                       // 10/17 退房、新客 10/17 入住
  assert.match(draftError({ ...P, to: '2026-10-18' }, busy) ?? '', /9B1 這段有人住/);
  const busyC: Busy[] = [{ propertyId: 'p1', estateId: 'E1', room: '9B1', first: '2027-04-30', last: '2027-05-03' }];
  assert.equal(draftFree(busyC, C), false);                     // 契約 4/30 那天自己也住
  assert.equal(draftFree(busyC, { ...C, to: '2027-04-29' }), true);
});

test('orderInsert：跟訂單頁新增私下訂單同一組欄位', () => {
  const o = orderInsert(P, 123);
  assert.equal(o.source, 'private');
  assert.equal(o.order_key, 'PV_2026-10-14_9B1_王小明_123');
  assert.equal(o.imported_via, 'manual');
  assert.equal(o.purpose_type, 'estate');
  assert.equal(o.guest_name, '王小明');
  assert.equal(o.note, '晚到');
  assert.equal(o.nights, 3);
  assert.equal(o.amount, 9000);
  assert.equal(o.earnest_amount, 0);
  assert.equal(o.earnest_only, false);
  assert.equal(o.book, 'anxing');
  assert.equal(orderInsert({ ...P, price: null, name: '', note: '' }).amount, 0);
  assert.equal(orderInsert({ ...P, name: '  ' }).guest_name, null);
});

test('contractInsert：月繳長租、月租＝每期', () => {
  const c = contractInsert(C);
  assert.equal(c.cadence, 'monthly');
  assert.equal(c.type, 'longterm');
  assert.equal(c.amount_per_period, 32000);
  assert.equal(c.monthly_rent, 32000);
  assert.equal(c.start_date, '2026-11-01');
  assert.equal(c.end_date, '2027-04-30');
  assert.equal(c.name, '王小明-9B1');
  assert.equal(c.purpose_type, 'estate');
  assert.equal(c.active, true);
  assert.deepEqual(c.rent_lines, []);
});
