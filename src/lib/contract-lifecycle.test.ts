import test from 'node:test';
import assert from 'node:assert/strict';
import {
  summarize, needsTypedConfirm, deleteConfirmText,
  strayPaid, endLeaseRemoved, monthStart, type OrderLite,
} from './contract-lifecycle.ts';

const o = (p: Partial<OrderLite>): OrderLite => ({
  id: p.id ?? Math.random().toString(36).slice(2),
  order_key: p.order_key ?? 'LT_2F-4_202601',
  checkin: p.checkin ?? '2026-01-01',
  amount: p.amount ?? 1000,
  paid: p.paid ?? false,
  imported_via: p.imported_via ?? 'contract',
});

test('summarize:月租單與加費分開計算', () => {
  const im = summarize([
    o({ amount: 1000, paid: true }),
    o({ amount: 1000, paid: false }),
    o({ amount: 500, paid: true, imported_via: 'manual' }),
  ]);
  assert.equal(im.monthly.n, 2);
  assert.equal(im.monthly.paidN, 1);
  assert.equal(im.monthly.paidAmt, 1000);
  assert.equal(im.extra.n, 1);
  assert.equal(im.extra.paidAmt, 500);
  assert.equal(im.total.n, 3);
  assert.equal(im.total.amt, 2500);
  assert.equal(im.total.paidAmt, 1500);
});

test('summarize:期間取最早與最晚', () => {
  const im = summarize([
    o({ checkin: '2024-05-01' }), o({ checkin: '2022-11-01' }), o({ checkin: '2026-04-01' }),
  ]);
  assert.equal(im.from, '2022-11-01');
  assert.equal(im.to, '2026-04-01');
});

test('summarize:空陣列不會炸,期間是 null', () => {
  const im = summarize([]);
  assert.equal(im.total.n, 0);
  assert.equal(im.from, null);
  assert.equal(im.to, null);
});

test('needsTypedConfirm:有已收款才要打字', () => {
  assert.equal(needsTypedConfirm(summarize([o({ paid: false })])), false);
  assert.equal(needsTypedConfirm(summarize([o({ paid: true })])), true);
  // 建錯的契約沒有任何訂單 —— 正常路徑,一句 confirm 就好
  assert.equal(needsTypedConfirm(summarize([])), false);
});

test('deleteConfirmText:沒有訂單時說可以安全刪除', () => {
  const t = deleteConfirmText('測試', summarize([]));
  assert.match(t, /沒有任何訂單/);
  assert.doesNotMatch(t, /無法復原/);
});

test('deleteConfirmText:有已收款時要出現筆數、金額與「結束租約」的替代建議', () => {
  const t = deleteConfirmText('乃志商行 2F-4', summarize([
    o({ amount: 1250, paid: true }), o({ amount: 1250, paid: true }), o({ amount: 1250, paid: false }),
  ]));
  assert.match(t, /乃志商行 2F-4/);
  assert.match(t, /月租單 3 筆/);
  assert.match(t, /已收款 2 筆/);
  assert.match(t, /2,500/);        // 已收款金額要有千分位
  assert.match(t, /3,750/);        // 認列總額
  assert.match(t, /結束租約/);      // 一定要提供替代路徑
});

test('deleteConfirmText:全未收款時不出現「已收款」警告', () => {
  const t = deleteConfirmText('測試', summarize([o({ paid: false }), o({ paid: false })]));
  assert.match(t, /皆未收款/);
  assert.doesNotMatch(t, /真的收進來的錢/);
  assert.match(t, /無法復原/);
});

test('strayPaid:租期外且已收款才算', () => {
  const rows = [
    o({ checkin: '2025-12-01', paid: true }),                 // 起日之前,已收 → 算
    o({ checkin: '2026-01-01', paid: true }),                 // 租期內 → 不算
    o({ checkin: '2026-07-01', paid: true }),                 // 迄日之後,已收 → 算
    o({ checkin: '2026-07-01', paid: false }),                // 迄日之後但未收 → 資料庫會自己刪,不算
    o({ checkin: '2026-07-01', paid: true, imported_via: 'manual' }), // 加費不受租期管 → 不算
  ];
  const s = strayPaid(rows, '2026-01-15', '2026-06-30');
  assert.equal(s.length, 2);
  assert.deepEqual(s.map((x) => x.checkin), ['2025-12-01', '2026-07-01']);
});

test('strayPaid:起日在月中時,該月整月都算租期內', () => {
  // 契約 1/15 起,月租單的 checkin 是 1/1 —— 不能因為 1/1 < 1/15 就判成租期外
  const s = strayPaid([o({ checkin: '2026-01-01', paid: true })], '2026-01-15', '2026-12-31');
  assert.equal(s.length, 0);
});

test('monthStart:退回當月一號', () => {
  assert.equal(monthStart('2026-01-15'), '2026-01-01');
  assert.equal(monthStart('2026-12-31'), '2026-12-01');
});

test('endLeaseRemoved:只清迄日之後、未收款的月租單', () => {
  const rows = [
    o({ checkin: '2026-05-01', paid: false }),
    o({ checkin: '2026-07-01', paid: false }),                 // → 清
    o({ checkin: '2026-08-01', paid: true }),                  // 已收款 → 留
    o({ checkin: '2026-09-01', paid: false, imported_via: 'manual' }), // 加費 → 留
  ];
  const r = endLeaseRemoved(rows, '2026-06-30');
  assert.equal(r.length, 1);
  assert.equal(r[0].checkin, '2026-07-01');
});

test('endLeaseRemoved:迄日當天的列要被清掉（與 SQL 的 checkin >= end_date 一致）', () => {
  const r = endLeaseRemoved([o({ checkin: '2026-06-01', paid: false })], '2026-06-01');
  assert.equal(r.length, 1);
});
