import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settlePath, depositAvail, settleTotals, quickPicks, settleError, cancelBlockedReason, CANCEL_REVIEW_AT } from './cancel-settle.ts';

test('三條路：0 結案、未滿 3,000 免審、3,000 以上送審（邊界）', () => {
  assert.equal(CANCEL_REVIEW_AT, 3000);
  assert.equal(settlePath(0), 'close');
  assert.equal(settlePath(1), 'direct');
  assert.equal(settlePath(2999), 'direct');
  assert.equal(settlePath(3000), 'review');
  assert.equal(settlePath(7400), 'review');
});

test('押金可結算：沒收到是 0；扣掉已從押金扣的加費', () => {
  assert.equal(depositAvail({ received_on: null, amount: 10000 }), 0);
  assert.equal(depositAvail({ received_on: '2026-10-05', received_amount: 10000, amount: 10000 }, 500), 9500);
  assert.equal(depositAvail({ received_on: '2026-10-05', received_amount: null, amount: 10000 }), 10000);
  assert.equal(depositAvail(null), 0);
});

test('已收合計 ＝ 押金 ＋ 房費已收；快選', () => {
  const t = settleTotals(10000, 7400);
  assert.deepEqual(t, { deposit: 10000, order: 7400, total: 17400 });
  assert.deepEqual(quickPicks(t).map((q) => [q.label, q.forfeit]),
    [['全部', 17400], ['只沒入押金', 10000], ['只沒入房費', 7400], ['全退', 0]]);
  assert.deepEqual(quickPicks(settleTotals(10000, 0)).map((q) => q.label), ['全部', '全退']);
});

test('★★ 退還不能多於已收合計 —— 直接講原因', () => {
  assert.match(settleError(-100, 17500, 17400)!, /退還 \$17,500 超過/);
  assert.match(settleError(0, 17500, 17400)!, /退還 \$17,500 超過已收合計 \$17,400/);
  assert.match(settleError(17500, -100, 17400)!, /沒入 \$17,500 超過/);
  assert.equal(settleError(15000, 2400, 17400, { name: 'Fei', account: '123' }), null);
  assert.match(settleError(15000, 2400, 17400, { name: '', account: '' })!, /戶名/);
  assert.equal(settleError(17400, 0, 17400, { name: '', account: '' }), null);
  assert.match(settleError(0, 0, 0)!, /還沒收到/);
});

test('只有私下訂單、還沒取消的才能結算；被駁回的可以重來', () => {
  assert.match(cancelBlockedReason({ source: 'airbnb' })!, /私下/);
  assert.equal(cancelBlockedReason({ source: 'private' }), null);
  assert.match(cancelBlockedReason({ source: 'private', cancelled_on: '2026-10-06', cancel_settle: { status: 'done' } })!, /已經取消/);
  assert.equal(cancelBlockedReason({ source: 'private', cancelled_on: '2026-10-06', cancel_settle: { status: 'rejected' } }), null);
});
