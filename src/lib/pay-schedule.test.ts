import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paySchedule } from './pay-schedule.ts';

const R = (id: string, status: string, d: string, acct: string, amt: number) =>
  ({ id, status, planned_transfer_on: d, payout_account: acct, total_amount: amt });

test('paySchedule：已核可與待核可分開加總、每天有小計', () => {
  const s = paySchedule([
    R('a', 'approved', '2026-10-05', '4145', 815),
    R('b', 'pending', '2026-10-05', '4145', 10000),
    R('c', 'pending', '2026-10-05', '4145', 14000),
    R('d', 'approved', '2026-10-05', '安幸現金', 2566),
    R('e', 'pending', '2026-10-20', '4145', 177500),
    R('f', 'draft', '2026-10-05', '4145', 999),
  ]);
  assert.equal(s.approvedAmt, 3381);
  assert.equal(s.pendingAmt, 201500);
  assert.equal(s.days.length, 2);
  assert.equal(s.days[0].approvedAmt + s.days[0].pendingAmt, 27381);
  const g = s.days[0].groups;
  assert.deepEqual(g.map((x) => `${x.acct}/${x.approved ? '核' : '待'}/${x.reqs.length}`), ['4145/核/1', '4145/待/2', '安幸現金/核/1']);
});
test('paySchedule：草稿與駁回不算', () => {
  const s = paySchedule([R('x', 'rejected', '2026-10-05', '4145', 5), R('y', 'draft', '2026-10-05', '4145', 5)]);
  assert.equal(s.days.length, 0);
});
