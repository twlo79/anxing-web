import test from 'node:test';
import assert from 'node:assert/strict';
import {
  leaseMonthStarts, baseInvoiceYms, buildInvoiceSlots, attachIssued, slotStatus,
  invoiceEveryOptions, invoiceEveryText,
} from './invoice-plan.ts';

/* ── 月份照起租日切 ───────────────────────────────── */
test('leaseMonthStarts：8/17～8/16 是 12 個月，不是 13', () => {
  const ms = leaseMonthStarts('2026-08-17', '2027-08-16');
  assert.equal(ms.length, 12);
  assert.equal(ms[0], '202608'); assert.equal(ms[11], '202707');
});
test('leaseMonthStarts：1 號起租、月底結束照舊 12 個', () => {
  assert.equal(leaseMonthStarts('2026-10-01', '2027-09-30').length, 12);
});
test('leaseMonthStarts：31 號起租夾到月底、往前漂（跟 Postgres 一樣）', () => {
  const ms = leaseMonthStarts('2026-01-31', '2026-04-30');
  assert.deepEqual(ms, ['202601', '202602', '202603', '202604']);
});
test('leaseMonthStarts：沒租期回空', () => {
  assert.deepEqual(leaseMonthStarts(null, '2027-01-01'), []);
  assert.deepEqual(leaseMonthStarts('2027-01-01', '2026-01-01'), []);
});

/* ── 基本清單 ─────────────────────────────────────── */
const Y = { start_date: '2026-08-17', end_date: '2028-08-16', cadence: 'yearly' };
test('baseInvoiceYms：每月開 ＝ 每個月；每年開 ＝ 每期第一個月', () => {
  assert.equal(baseInvoiceYms({ ...Y, invoice_every: 'month' }).length, 24);
  assert.deepEqual(baseInvoiceYms({ ...Y, invoice_every: 'period' }), ['202608', '202708']);
});
test('baseInvoiceYms：沒填 invoice_every 當每月', () => {
  assert.equal(baseInvoiceYms({ ...Y }).length, 24);
});
test('baseInvoiceYms：季繳每季開', () => {
  assert.deepEqual(baseInvoiceYms({ start_date: '2026-02-10', end_date: '2027-01-09', cadence: 'quarterly', invoice_every: 'period' }),
    ['202602', '202605', '202608', '202611']);
});

/* ── 例外 ─────────────────────────────────────────── */
const M = { start_date: '2026-08-17', end_date: '2027-08-16', cadence: 'yearly', invoice_every: 'month' as const };
test('buildInvoiceSlots：不開的那列留著、劃掉；額外的排在同月 auto 後面', () => {
  const slots = buildInvoiceSlots(M, [
    { id: 's1', ym: '202610', kind: 'skip', note: '併 11 月' },
    { id: 'e1', ym: '202611', kind: 'extra', amount: 12000, note: '水電分攤' },
  ], () => 165000);
  assert.equal(slots.length, 13);
  const oct = slots.find((s) => s.ym === '202610')!;
  assert.equal(oct.skipped, true); assert.equal(oct.skipNote, '併 11 月'); assert.equal(oct.due, 165000);
  const nov = slots.filter((s) => s.ym === '202611');
  assert.deepEqual(nov.map((s) => s.kind), ['auto', 'extra']);
  assert.equal(nov[1].due, 12000); assert.equal(nov[1].extraId, 'e1');
});

/* ── 已開的發票配到列上，而且只讀不改 ───────────────── */
test('attachIssued：一個月一張配一列；舊的一期一張掛第一個月也照配', () => {
  const slots = buildInvoiceSlots(M, [], () => 165000);
  const issued = [{ id: 'v1', ym: '202608', invoice_no: 'AB12345678', amount: 1980000 }];
  const out = attachIssued(slots, issued);
  assert.equal(out.find((s) => s.ym === '202608')!.invoice?.invoice_no, 'AB12345678');
  assert.equal(out.filter((s) => s.invoice).length, 1);
  assert.deepEqual(issued, [{ id: 'v1', ym: '202608', invoice_no: 'AB12345678', amount: 1980000 }]);   // 沒被改
});
test('attachIssued：同月兩張 → auto 一張、extra 一張；第三張掛在最後一列的 more', () => {
  const slots = buildInvoiceSlots(M, [{ id: 'e1', ym: '202611', kind: 'extra', amount: 1 }], () => 2);
  const out = attachIssued(slots, [{ id: 'a', ym: '202611' }, { id: 'b', ym: '202611' }, { id: 'c', ym: '202611' }]);
  const nov = out.filter((s) => s.ym === '202611');
  assert.equal(nov.length, 2);
  assert.equal(nov[0].invoice?.id, 'a'); assert.equal(nov[1].invoice?.id, 'b');
  assert.deepEqual(nov[1].more?.map((v) => v.id), ['c']);
});
test('★ attachIssued：標了不開的月份卻有發票 → 另起一列顯示，發票不會消失', () => {
  const slots = buildInvoiceSlots(M, [{ id: 's', ym: '202609', kind: 'skip' }], () => 1);
  const out = attachIssued(slots, [{ id: 'v', ym: '202609' }]);
  assert.ok(out.some((s) => s.ym === '202609' && s.invoice?.id === 'v'));
});

/* ── 狀態 ─────────────────────────────────────────── */
const O = { fromYm: '202609', curYm: '202610', todayDay: 7 };
test('slotStatus：起算月之前不算；未來收起來；過了就逾期', () => {
  assert.equal(slotStatus({ ym: '202608' }, O), 'before');
  assert.equal(slotStatus({ ym: '202612' }, O), 'future');
  assert.equal(slotStatus({ ym: '202609' }, O), 'overdue');
});
test('slotStatus：本月看開票日 —— 7 號：開票日 5 逾期、15 還沒到、沒填不逾期', () => {
  assert.equal(slotStatus({ ym: '202610' }, { ...O, invoiceDay: 5 }), 'overdue');
  assert.equal(slotStatus({ ym: '202610' }, { ...O, invoiceDay: 15 }), 'due');
  assert.equal(slotStatus({ ym: '202610' }, { ...O, invoiceDay: null }), 'due');
});
test('slotStatus：已開、不開優先於日期', () => {
  assert.equal(slotStatus({ ym: '202605', invoice: {} }, O), 'issued');
  assert.equal(slotStatus({ ym: '202605', skipped: true }, O), 'skipped');
});

/* ── 文字 ─────────────────────────────────────────── */
test('invoiceEveryOptions：第二個選項跟著繳別', () => {
  assert.deepEqual(invoiceEveryOptions('yearly').map((o) => o.label), ['每月開', '每年開']);
  assert.deepEqual(invoiceEveryOptions('quarterly').map((o) => o.label), ['每月開', '每季開']);
});
test('invoiceEveryText：月繳約不管選什麼都是每月開', () => {
  assert.equal(invoiceEveryText({ cadence: 'monthly', invoice_every: 'period' }), '每月開');
  assert.equal(invoiceEveryText({ cadence: 'yearly', invoice_every: 'period' }), '每年開');
  assert.equal(invoiceEveryText({ cadence: 'yearly' }), '每月開');
});
