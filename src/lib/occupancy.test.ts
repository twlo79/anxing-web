import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  usedDays, occupancyOf, occupancyByRoom, totalOccupancy, occupancyByEstate,
  fmtPct, occTone, OCC_HIGH, OCC_LOW,
  clipToRange, occupancyByMonth,
} from './occupancy.ts';
import type { Stay } from './room-calendar.ts';

const R = { from: '2026-09-01', to: '2026-09-30' };   // 30 天

function order(id: string, room: string, start: string, end: string): Stay {
  return { id, room, kind: 'order', start, end, tone: 'short' };
}
function contract(id: string, room: string, start: string, end: string): Stay {
  return { id, room, kind: 'contract', start, end, tone: 'longterm' };
}

/* ── usedDays ───────────────────────────────────────────── */

test('沒有任何佔用 → 0 天', () => {
  assert.equal(usedDays([], R), 0);
});

test('訂單的 checkout 是退房日，最後一晚是前一天', () => {
  // 9/01 進、9/11 退 → 住 9/01~9/10 共 10 晚
  assert.equal(usedDays([order('a', 'A', '2026-09-01', '2026-09-11')], R), 10);
});

test('契約的 end_date 就是最後一晚，不用 -1', () => {
  // 9/01 ~ 9/10 → 10 晚
  assert.equal(usedDays([contract('c', 'A', '2026-09-01', '2026-09-10')], R), 10);
});

test('★★★ 重疊只算一次 —— 不是把天數加起來', () => {
  const s = [
    order('a', 'A', '2026-09-01', '2026-09-11'),   // 9/01~9/10 共 10
    order('b', 'A', '2026-09-08', '2026-09-16'),   // 9/08~9/15 共 8，重疊 3 天
  ];
  // 加總會是 18；實際是 9/01~9/15 共 15
  assert.equal(usedDays(s, R), 15);
});

test('★★★ 重疊不會讓入住率超過 100%', () => {
  const s = [
    order('a', 'A', '2026-09-01', '2026-10-01'),
    order('b', 'A', '2026-09-01', '2026-10-01'),
    contract('c', 'A', '2026-09-01', '2026-09-30'),
  ];
  const o = occupancyOf(s, R);
  assert.equal(o.used, 30);
  assert.equal(o.rate, 1);
});

test('跨進來的長住只算落在區間裡的那幾天', () => {
  // 8/20 ~ 9/05（契約：9/05 是最後一晚）→ 九月只有 5 天
  assert.equal(usedDays([contract('c', 'A', '2026-08-20', '2026-09-05')], R), 5);
});

test('跨出去的長住只算到區間結束', () => {
  assert.equal(usedDays([contract('c', 'A', '2026-09-20', '2027-06-30')], R), 11);
});

test('整段都在區間外 → 0 天', () => {
  assert.equal(usedDays([order('a', 'A', '2026-07-01', '2026-07-10')], R), 0);
});

test('checkout 剛好等於區間起日的訂單不算 —— 它的最後一晚在上個月', () => {
  assert.equal(usedDays([order('a', 'A', '2026-08-20', '2026-09-01')], R), 0);
});

test('當日進當日出（加費單）不佔任何一晚', () => {
  assert.equal(usedDays([order('a', 'A', '2026-09-05', '2026-09-05')], R), 0);
});

/* ── occupancyOf ────────────────────────────────────────── */

test('整段住滿 = 100%', () => {
  const o = occupancyOf([contract('c', 'A', '2026-09-01', '2026-09-30')], R);
  assert.deepEqual(o, { days: 30, used: 30, free: 0, rate: 1 });
});

test('一半 = 50%', () => {
  const o = occupancyOf([contract('c', 'A', '2026-09-01', '2026-09-15')], R);
  assert.equal(o.used, 15);
  assert.equal(o.rate, 0.5);
});

test('★ 空的期間回 0 不是 NaN', () => {
  const o = occupancyOf([contract('c', 'A', '2026-09-01', '2026-09-30')], { from: '', to: '' });
  assert.equal(o.days, 0);
  assert.equal(o.rate, 0);
  assert.ok(!Number.isNaN(o.rate));
});

test('★ 起迄顛倒回 0，不會回負數', () => {
  const o = occupancyOf([], { from: '2026-09-30', to: '2026-09-01' });
  assert.equal(o.days, 0);
  assert.equal(o.free, 0);
});

test('free 永遠等於 days − used', () => {
  const o = occupancyOf([order('a', 'A', '2026-09-01', '2026-09-11')], R);
  assert.equal(o.free, o.days - o.used);
  assert.equal(o.free, 20);
});

/* ── occupancyByRoom ────────────────────────────────────── */

const ROOMS = [
  { name: '10A', estate: '正隆' },
  { name: '2A', estate: '正隆' },
  { name: 'B01', estate: '復興' },
];

test('每一間房各算各的', () => {
  const by = {
    '2A': [contract('c1', '2A', '2026-09-01', '2026-09-30')],
    '10A': [order('o1', '10A', '2026-09-01', '2026-09-16')],   // 15 晚
  };
  const list = occupancyByRoom(ROOMS, by, R);
  const m = Object.fromEntries(list.map((x) => [x.room, x]));
  assert.equal(m['2A'].rate, 1);
  assert.equal(m['10A'].used, 15);
  assert.equal(m['B01'].used, 0);
  assert.equal(m['B01'].rate, 0);
});

test('★ 排序照房號的自然順序，不是按入住率', () => {
  const list = occupancyByRoom(ROOMS, {}, R);
  assert.deepEqual(list.map((x) => x.room), ['2A', '10A', 'B01']);
});

test('沒有佔用資料的房源照樣出現在清單裡（率 0）', () => {
  const list = occupancyByRoom(ROOMS, {}, R);
  assert.equal(list.length, 3);
  assert.ok(list.every((x) => x.used === 0 && x.days === 30));
});

test('★ 傳進來的房源就是分母 —— 這支不負責篩掉沒在租的', () => {
  const list = occupancyByRoom([{ name: '2B10', estate: '正隆' }], {}, R);
  assert.equal(list.length, 1);
  assert.equal(list[0].days, 30);
});

/* ── totalOccupancy ─────────────────────────────────────── */

test('★★★ 合計是「總天數 ÷ 總可住天數」，不是各房率的平均', () => {
  // A 住滿 30/30，B 空 0/30 → 平均是 50%，總和也是 50%（房數天數相同）
  const same = totalOccupancy([
    { room: 'A', estate: null, days: 30, used: 30, free: 0, rate: 1 },
    { room: 'B', estate: null, days: 30, used: 0, free: 30, rate: 0 },
  ]);
  assert.equal(same.rate, 0.5);

  // 天數不同時就會分岔：平均 = (1 + 0)/2 = 0.5，總和 = 30/(30+10) = 0.75
  const diff = totalOccupancy([
    { room: 'A', estate: null, days: 30, used: 30, free: 0, rate: 1 },
    { room: 'B', estate: null, days: 10, used: 0, free: 10, rate: 0 },
  ]);
  assert.equal(diff.rate, 0.75);
});

test('合計帶著房間數 —— 分母是怎麼來的要看得到', () => {
  const t = totalOccupancy(occupancyByRoom(ROOMS, {}, R));
  assert.equal(t.rooms, 3);
  assert.equal(t.days, 90);
});

test('★ 一間房都沒有 → 0，不是 NaN', () => {
  const t = totalOccupancy([]);
  assert.equal(t.rooms, 0);
  assert.equal(t.days, 0);
  assert.equal(t.rate, 0);
  assert.ok(!Number.isNaN(t.rate));
});

/* ── occupancyByEstate ──────────────────────────────────── */

test('依物業彙總', () => {
  const by = { '2A': [contract('c1', '2A', '2026-09-01', '2026-09-30')] };
  const es = occupancyByEstate(occupancyByRoom(ROOMS, by, R));
  const m = Object.fromEntries(es.map((x) => [x.estate, x]));
  assert.equal(m['正隆'].rooms, 2);
  assert.equal(m['正隆'].used, 30);
  assert.equal(m['正隆'].rate, 0.5);
  assert.equal(m['復興'].rooms, 1);
  assert.equal(m['復興'].rate, 0);
});

test('沒設物業的收在空字串，不會混進某一棟', () => {
  const es = occupancyByEstate([
    { room: 'X', estate: null, days: 30, used: 30, free: 0, rate: 1 },
    { room: 'Y', estate: '正隆', days: 30, used: 0, free: 30, rate: 0 },
  ]);
  const m = Object.fromEntries(es.map((x) => [x.estate, x]));
  assert.equal(m[''].rooms, 1);
  assert.equal(m['正隆'].rooms, 1);
});

/* ── 顯示 ───────────────────────────────────────────────── */

test('fmtPct 一位小數', () => {
  assert.equal(fmtPct(0.8734), '87.3%');
  assert.equal(fmtPct(1), '100.0%');
  assert.equal(fmtPct(0), '0.0%');
});

test('★ 一位小數才分得出「全空」跟「住了一天」', () => {
  assert.notEqual(fmtPct(0), fmtPct(1 / 30));
});

test('fmtPct 接到壞數字回破折號，不印 NaN%', () => {
  assert.equal(fmtPct(NaN), '—');
  assert.equal(fmtPct(Infinity), '—');
});

test('occTone 的分界點是 >=', () => {
  assert.equal(occTone(OCC_HIGH), 'high');
  assert.equal(occTone(OCC_HIGH - 0.0001), 'mid');
  assert.equal(occTone(OCC_LOW), 'mid');
  assert.equal(occTone(OCC_LOW - 0.0001), 'low');
  assert.equal(occTone(0), 'low');
  assert.equal(occTone(1), 'high');
});

/* ══════════════════════════════════════════════════════════
 * clipToRange ／ occupancyByMonth（2026-09-18 合圖）
 * ══════════════════════════════════════════════════════════ */

test('整個月都在區間裡 → 夾出整個月', () => {
  assert.deepEqual(clipToRange('2026-09', { from: '2026-08-01', to: '2026-10-31' }),
    { from: '2026-09-01', to: '2026-09-30' });
});

test('★★★ 區間在月中就截斷 —— 不然分母會用整個月，住房率無聲變低', () => {
  assert.deepEqual(clipToRange('2026-09', { from: '2026-09-01', to: '2026-09-18' }),
    { from: '2026-09-01', to: '2026-09-18' });
  assert.deepEqual(clipToRange('2026-09', { from: '2026-09-10', to: '2026-10-31' }),
    { from: '2026-09-10', to: '2026-09-30' });
});

test('剛好只有一天交集也算交集', () => {
  assert.deepEqual(clipToRange('2026-09', { from: '2026-09-30', to: '2026-12-31' }),
    { from: '2026-09-30', to: '2026-09-30' });
});

test('完全沒有交集 → null', () => {
  assert.equal(clipToRange('2026-09', { from: '2026-10-01', to: '2026-10-31' }), null);
  assert.equal(clipToRange('2026-09', { from: '2026-07-01', to: '2026-08-31' }), null);
});

test('二月的天數照月份走（不是固定 30）', () => {
  assert.deepEqual(clipToRange('2026-02', { from: '2026-01-01', to: '2026-12-31' }),
    { from: '2026-02-01', to: '2026-02-28' });
});

const ROOMS2 = [{ name: 'A', estate: '甲' }, { name: 'B', estate: '甲' }];

test('★★★ 十二格的入住天數加起來 ＝ 整體的入住天數', () => {
  // 兩間房、跨三個月的契約一張，加一張九月的短租
  const by = {
    A: [contract('c1', 'A', '2026-07-15', '2026-09-20')],
    B: [order('o1', 'B', '2026-09-01', '2026-09-11')],
  };
  const r = { from: '2026-07-01', to: '2026-09-30' };
  const all = totalOccupancy(occupancyByRoom(ROOMS2, by, r));
  const ms = occupancyByMonth(ROOMS2, by, ['2026-07', '2026-08', '2026-09'], r);
  assert.equal(ms.reduce((s, m) => s + m.used, 0), all.used);
  assert.equal(ms.reduce((s, m) => s + m.days, 0), all.days);
});

test('★★★ 不在區間裡的月份回 days 0 —— 折線要斷開，不是畫成 0%', () => {
  const by = { A: [order('o1', 'A', '2026-09-01', '2026-09-11')] };
  const ms = occupancyByMonth(ROOMS2, by, ['2026-05', '2026-09'],
    { from: '2026-09-01', to: '2026-09-30' });
  assert.equal(ms[0].days, 0);
  assert.equal(ms[0].used, 0);
  assert.equal(ms[1].days, 60);          // 2 間 × 30 天
  assert.equal(ms[1].used, 10);
});

test('★★ 真的一天都沒住的月份 rate 是 0 而 days 不是 0 —— 那是事實不是沒資料', () => {
  const ms = occupancyByMonth(ROOMS2, {}, ['2026-09'],
    { from: '2026-09-01', to: '2026-09-30' });
  assert.equal(ms[0].days, 60);
  assert.equal(ms[0].rate, 0);
});

test('區間最後一個月被截斷時，分母跟著變小', () => {
  const by = { A: [contract('c1', 'A', '2026-09-01', '2026-09-30')] };
  const ms = occupancyByMonth([{ name: 'A', estate: null }], by, ['2026-09'],
    { from: '2026-09-01', to: '2026-09-10' });
  assert.equal(ms[0].days, 10);
  assert.equal(ms[0].used, 10);
  assert.equal(ms[0].rate, 1);           // 夾對了就是 100%，不是 33%
});

test('月份清單是空的 → 空陣列（不自己生月份）', () => {
  assert.deepEqual(occupancyByMonth(ROOMS2, {}, [], { from: '2026-09-01', to: '2026-09-30' }), []);
});
