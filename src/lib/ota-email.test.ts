import { test } from 'node:test';
import assert from 'node:assert/strict';
import { otaSource, otaDate, parseOtaEmail, matchEstate, matchProperty, otaOrderRow } from './ota-email.ts';

test('來源：主旨第一個字 → airbnb／agoda，其他認不得', () => {
  assert.equal(otaSource('Airbnb'), 'airbnb');
  assert.equal(otaSource('AIRBNB:'), 'airbnb');
  assert.equal(otaSource('Agoda'), 'agoda');
  assert.equal(otaSource('Booking'), null);
  assert.equal(otaSource(null), null);
});
test('日期：接受 - / . 年月日，吐 YYYY-MM-DD', () => {
  assert.equal(otaDate('2026-10-11'), '2026-10-11');
  assert.equal(otaDate('2026/1/5'), '2026-01-05');
  assert.equal(otaDate('2026年10月11日'), '2026-10-11');
  assert.equal(otaDate('Oct 11'), null);
  assert.equal(otaDate('2026-13-01'), null);
});
test('parse：缺編號、認不得來源、日期錯、退房沒晚於入住 → 一句話', () => {
  assert.match((parseOtaEmail({}) as any).error, /ota_no/);
  assert.match((parseOtaEmail({ ota_no: 'HM1', source: 'Booking' }) as any).error, /認不得/);
  assert.match((parseOtaEmail({ ota_no: 'HM1', source: 'Airbnb', checkin: 'x' }) as any).error, /checkin/);
  assert.match((parseOtaEmail({ ota_no: 'HM1', source: 'Airbnb', checkin: '2026-10-11', checkout: '2026-10-11' }) as any).error, /沒有晚於/);
});
test('parse：正常一封信', () => {
  const r = parseOtaEmail({ ota_no: ' HMABCD ', source: 'Airbnb', checkin: '2026/10/11', checkout: '2026-10-15',
    property: '時兆', unit: 'A15', amount: 'NT$7,400', email_id: 'abc' });
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.v.order_key, 'HMABCD');
    assert.equal(r.v.nights, 4);
    assert.equal(r.v.amount, 7400);
    assert.equal(r.v.guest_name, null);
  }
});
test('對物業、房源：名稱包含也算；房號正規化 A015 = A15；對不到回 null', () => {
  const es = [{ id: 'e1', name: '時兆' }, { id: 'e2', name: '正隆' }];
  assert.equal(matchEstate(es, '時兆大樓')?.id, 'e1');
  assert.equal(matchEstate(es, '開封'), null);
  const ps = [{ id: 'p1', name: 'A15', estate_id: 'e1' }, { id: 'p2', name: 'A15', estate_id: 'e2' }];
  assert.equal(matchProperty(ps, 'e2', 'A015')?.id, 'p2');
  assert.equal(matchProperty(ps, 'e1', 'B01'), null);
});
test('寫進 orders 的列：imported_via=email、沒金額時備註寫等爬蟲', () => {
  const r = parseOtaEmail({ ota_no: 'HM1', source: 'Airbnb', checkin: '2026-10-11', checkout: '2026-10-12', unit: 'A15' });
  assert.ok(r.ok);
  if (r.ok) {
    const row = otaOrderRow(r.v, 'e1', 'p1');
    assert.equal(row.imported_via, 'email');
    assert.equal(row.paid, false);
    assert.match(row.note, /等爬蟲同步/);
  }
});
