import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildStayIndex, matchStay } from './review-match.ts';

const orders = [
  { guest_name: 'Ka Chun', checkin: '2026-09-05', checkout: '2026-09-24', property_id: 'T4' },
  { guest_name: 'Ka Chun', checkin: '2026-09-24', checkout: '2026-09-28', property_id: 'T3' },
  { guest_name: 'Frank', checkin: '2026-09-20', checkout: '2026-09-23', property_id: 'KF3' },
  { guest_name: 'Twin', checkin: '2026-08-01', checkout: '2026-08-05', property_id: 'A' },
  { guest_name: 'Twin', checkin: '2026-08-01', checkout: '2026-08-05', property_id: 'B' },
  { guest_name: 'NoProp', checkin: '2026-08-01', checkout: '2026-08-05', property_id: null },
];
const idx = buildStayIndex(orders);

describe('matchStay', () => {
  it('① 房客＋退房日完全相同', () => {
    assert.deepEqual(matchStay(idx, 'Ka Chun', '2026-09-05', '2026-09-24'), { propertyId: 'T4', how: 'checkout' });
  });
  it('② 退房日差一天（提前退房），改用入住日對到（2026-09-29 那一筆）', () => {
    assert.deepEqual(matchStay(idx, 'Ka Chun', '2026-09-24', '2026-09-29'), { propertyId: 'T3', how: 'checkin' });
  });
  it('③ 只有退房日、差一天', () => {
    assert.deepEqual(matchStay(idx, 'Frank', null, '2026-09-22'), { propertyId: 'KF3', how: 'checkout±1' });
    assert.deepEqual(matchStay(idx, 'Frank', null, '2026-09-24'), { propertyId: 'KF3', how: 'checkout±1' });
  });
  it('差兩天不對', () => {
    assert.deepEqual(matchStay(idx, 'Frank', null, '2026-09-25'), { propertyId: null, how: null });
  });
  it('同名房客同一天兩間 → 不猜', () => {
    assert.deepEqual(matchStay(idx, 'Twin', '2026-08-01', '2026-08-05'), { propertyId: null, how: null });
    assert.deepEqual(matchStay(idx, 'Twin', null, '2026-08-06'), { propertyId: null, how: null });
  });
  it('房客名大小寫與前後空白不算差異', () => {
    assert.equal(matchStay(idx, ' ka chun ', null, '2026-09-24').propertyId, 'T4');
  });
  it('沒房客、沒日期、訂單沒房源 → null', () => {
    assert.equal(matchStay(idx, '', '2026-09-05', '2026-09-24').propertyId, null);
    assert.equal(matchStay(idx, 'Ka Chun', null, null).propertyId, null);
    assert.equal(matchStay(idx, 'NoProp', '2026-08-01', '2026-08-05').propertyId, null);
  });
  it('Ka Chun 9/24 是兩張單的交界：退房日 9/24 對到 T4、入住日 9/24 對到 T3，各走各的關', () => {
    assert.equal(matchStay(idx, 'Ka Chun', '2026-09-20', '2026-09-24').propertyId, 'T4');
    assert.equal(matchStay(idx, 'Ka Chun', '2026-09-24', '2026-09-30').propertyId, 'T3');
  });
});
