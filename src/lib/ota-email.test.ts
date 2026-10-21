import { test } from 'node:test';
import assert from 'node:assert/strict';
import { otaSource, otaDate, parseOtaEmail, matchEstate, matchProperty, otaOrderRow, otaCancelDecision, otaModifyDecision } from './ota-email.ts';

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

const ex = (o: Partial<NonNullable<Parameters<typeof otaCancelDecision>[0]>> = {}) =>
  ({ id: 'o1', source: 'airbnb', paid: false, checkin: '2026-10-23', checkout: '2026-11-23', note: null, ...o });
test('取消信：沒這張單 → not_found（不建）；已作廢 → skip', () => {
  assert.equal(otaCancelDecision(null, {}, '2026-10-21').kind, 'not_found');
  assert.equal(otaCancelDecision(ex({ source: 'airbnb_cancelled' }), {}, '2026-10-21').kind, 'skip');
});
test('取消信：已收款、不是 Airbnb 的 → attention（不自動歸零）', () => {
  assert.equal(otaCancelDecision(ex({ paid: true }), {}, '2026-10-21').kind, 'attention');
  assert.equal(otaCancelDecision(ex({ source: 'private' }), {}, '2026-10-21').kind, 'attention');
});
test('取消信：正常 → 改 airbnb_cancelled、金額 0、備註留原本的；日期對不上給提醒', () => {
  const d = otaCancelDecision(ex({ note: '原備註' }), { checkin: '2026-10-23', checkout: '2026-11-24', email_id: 'g1' }, '2026-10-21');
  assert.equal(d.kind, 'void');
  if (d.kind !== 'void') return;
  assert.equal(d.patch.source, 'airbnb_cancelled');
  assert.equal(d.patch.amount, 0);
  assert.match(d.patch.note, /取消通知信 2026-10-21・Gmail g1）\n原備註/);
  assert.equal(d.warnings.length, 1);
});

const mx = (o: Record<string, unknown> = {}) => ({ id: 'o1', source: 'airbnb', amount: 151170, checkin: '2026-10-03', checkout: '2027-02-01', note: null, move_chain: null, ...o });
const mb = { ota_no: 'HMFCDB484W', checkin: '2026-10-03', checkout: '2026-12-01', amount: '74,360', old_amount: '151,170', email_id: 'g2' };
test('修改信（David 的例子：縮短到 12/1）→ 日期、晚數、金額都改', () => {
  const d = otaModifyDecision(mx() as any, mb, '2026-10-21');
  assert.equal(d.kind, 'update');
  if (d.kind !== 'update') return;
  assert.equal(d.patch.checkout, '2026-12-01');
  assert.equal(d.patch.nights, 59);
  assert.equal(d.patch.amount, 74360);
  assert.match(String(d.patch.note), /Airbnb 修改通知 2026-10-21：2026-10-03～2027-02-01 → 2026-10-03～2026-12-01（59 晚）・金額 151,170 → 74,360（Gmail g2）/);
});
test('修改信：系統金額不是信上的原始金額（爬蟲寫過實收）→ 只改日期、金額不動並提醒', () => {
  const d = otaModifyDecision(mx({ amount: 140000 }) as any, mb, '2026-10-21');
  assert.equal(d.kind, 'update');
  if (d.kind !== 'update') return;
  assert.equal(d.patch.amount, undefined);
  assert.equal(d.warnings.length, 1);
});
test('修改信：沒這張 → not_found（route 會照新資料建單）；取消單、移過房 → attention；日期錯 → bad；沒變 → skip', () => {
  assert.equal(otaModifyDecision(null, mb, '2026-10-21').kind, 'not_found');
  assert.equal(otaModifyDecision(mx({ source: 'airbnb_cancelled' }) as any, mb, '2026-10-21').kind, 'attention');
  assert.equal(otaModifyDecision(mx({ move_chain: 'A01>A02' }) as any, mb, '2026-10-21').kind, 'attention');
  assert.equal(otaModifyDecision(mx() as any, { ...mb, checkout: 'x' }, '2026-10-21').kind, 'bad');
  assert.equal(otaModifyDecision(mx({ checkout: '2026-12-01', amount: 74360 }) as any, mb, '2026-10-21').kind, 'skip');
});
