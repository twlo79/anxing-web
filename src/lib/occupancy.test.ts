import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  usedDays, occupancyOf, occupancyByRoom, totalOccupancy, occupancyByEstate,
  fmtPct, occTone, OCC_HIGH, OCC_LOW,
  clipToRange, occupancyByMonth,
  leafRooms, ancestryOf, unitsOf, totalUnits, subtreeOf, contractOccupiesRoom,
  type RoomNode,
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


/* ══════════════════════════════════════════════════════════
 * 子母房源（2026-09-21）
 *
 * 開封的真實形狀：
 *     開封整棟 ─┬─ 開封2F ─┬─ 開封2-1
 *               │          └─ 開封2-2
 *               ├─ 開封3F
 *               └─ 開封4F
 *     開封1F-1（沒有父層 —— 「整棟」不含 1 樓）
 * ══════════════════════════════════════════════════════════ */

const KAI: RoomNode[] = [
  { name: '開封整棟', estate: '開封', parent: null },
  { name: '開封2F',   estate: '開封', parent: '開封整棟' },
  { name: '開封2-1',  estate: '開封', parent: '開封2F' },
  { name: '開封2-2',  estate: '開封', parent: '開封2F' },
  { name: '開封3F',   estate: '開封', parent: '開封整棟' },
  { name: '開封4F',   estate: '開封', parent: '開封整棟' },
  { name: '開封1F-1', estate: '開封', parent: null },
];

test('★★★ 父層不進分母 —— 葉子才算間數', () => {
  const leaves = leafRooms(KAI).map((r) => r.name).sort();
  // 整棟與 2F 有小孩 → 不是葉子
  assert.deepEqual(leaves, ['開封1F-1', '開封2-1', '開封2-2', '開封3F', '開封4F']);
  assert.equal(totalUnits(KAI), 5);
});

test('★★ 葉子是用「有沒有小孩」判斷，不是用名字裡有沒有「整棟」', () => {
  // 改個名字不該改變算法
  const renamed = KAI.map((r) => ({
    ...r,
    name: r.name === '開封整棟' ? 'XX' : r.name,
    parent: r.parent === '開封整棟' ? 'XX' : r.parent,
  }));
  assert.equal(totalUnits(renamed), 5);
  assert.ok(!leafRooms(renamed).some((r) => r.name === 'XX'));
});

test('自己 ＋ 所有祖先（由下往上）', () => {
  assert.deepEqual(ancestryOf(KAI, '開封2-1'), ['開封2-1', '開封2F', '開封整棟']);
  assert.deepEqual(ancestryOf(KAI, '開封3F'), ['開封3F', '開封整棟']);
  assert.deepEqual(ancestryOf(KAI, '開封1F-1'), ['開封1F-1']);
});

test('★★★ 訂了「整棟」→ 底下每一個葉子都算有人', () => {
  const by = { 開封整棟: [order('w', '開封整棟', '2026-09-01', '2026-09-11')] };  // 10 晚
  const list = occupancyByRoom(KAI, by, R);
  const get = (n: string) => list.find((o) => o.room === n)!;
  assert.equal(get('開封2-1').used, 10);
  assert.equal(get('開封2-2').used, 10);
  assert.equal(get('開封3F').used, 10);
  assert.equal(get('開封4F').used, 10);
  // ★ 「整棟」不含 1 樓 —— 1F-1 沒有父層，所以一天都不算
  assert.equal(get('開封1F-1').used, 0);
  const t = totalOccupancy(list);
  assert.equal(t.rooms, 5);
  assert.equal(t.used, 40);              // 4 間 × 10 天
  assert.equal(t.days, 150);             // 5 間 × 30 天
});

test('★★ 訂了中間那層「2F」→ 只有 2-1 與 2-2，3F／4F 不算', () => {
  const by = { 開封2F: [order('f', '開封2F', '2026-09-01', '2026-09-06')] };      // 5 晚
  const list = occupancyByRoom(KAI, by, R);
  const get = (n: string) => list.find((o) => o.room === n)!;
  assert.equal(get('開封2-1').used, 5);
  assert.equal(get('開封2-2').used, 5);
  assert.equal(get('開封3F').used, 0);
  assert.equal(get('開封4F').used, 0);
});

test('★★★ 父子同一天都被訂（撞房）→ 那天只算一次，不會超過 100%', () => {
  const by = {
    開封整棟: [order('w', '開封整棟', '2026-09-01', '2026-09-11')],   // 9/01~9/10
    開封3F:   [order('c', '開封3F',   '2026-09-05', '2026-09-09')],   // 9/05~9/08，整段都在裡面
  };
  const list = occupancyByRoom(KAI, by, R);
  const f3 = list.find((o) => o.room === '開封3F')!;
  assert.equal(f3.used, 10);            // 不是 14
  assert.ok(f3.rate <= 1);
});

test('★★ 修好之前是什麼樣子 —— 父層留在分母、佔用不展開', () => {
  /* 沒有 parent 的那一版（現在線上的形狀）：七列全部是葉子，
     訂了整棟只有整棟那一列有天數 → 10 / (7×30) = 4.8%，
     而實際是 40 / (5×30) = 26.7%。這條釘住「差很多」這件事本身。 */
  const flat: RoomNode[] = KAI.map((r) => ({ name: r.name, estate: r.estate }));
  const by = { 開封整棟: [order('w', '開封整棟', '2026-09-01', '2026-09-11')] };
  const before = totalOccupancy(occupancyByRoom(flat, by, R));
  const after = totalOccupancy(occupancyByRoom(KAI, by, R));
  assert.equal(before.rooms, 7);
  assert.equal(before.used, 10);
  assert.equal(after.rooms, 5);
  assert.equal(after.used, 40);
  assert.ok(after.rate > before.rate * 5);
});

/* ── units（打通房） ────────────────────────────────────── */

const TAI: RoomNode[] = [
  { name: '台1+2', estate: '台視', units: 2 },
  { name: '台3',   estate: '台視' },
  { name: '台4',   estate: '台視' },
];

test('★★★ 打通房一列算兩間 —— 分子分母都乘 2，單間的 rate 不變', () => {
  const by = { '台1+2': [order('a', '台1+2', '2026-09-01', '2026-09-11')] };   // 10 晚
  const list = occupancyByRoom(TAI, by, R);
  const t12 = list.find((o) => o.room === '台1+2')!;
  assert.equal(t12.units, 2);
  assert.equal(t12.used, 10);
  assert.equal(t12.rate, 10 / 30);        // ★ 兩間一起租，住房率一樣
  const t = totalOccupancy(list);
  assert.equal(t.rooms, 4);               // 2 ＋ 1 ＋ 1
  assert.equal(t.days, 120);              // 4 間 × 30
  assert.equal(t.used, 20);               // 10 天 × 2 間
});

test('★ units 沒填／0／負數／NaN 都當 1 —— 分母不能被一個沒填好的欄位吃掉', () => {
  assert.equal(unitsOf({}), 1);
  assert.equal(unitsOf({ units: 0 }), 1);
  assert.equal(unitsOf({ units: -3 }), 1);
  assert.equal(unitsOf({ units: null }), 1);
  assert.equal(unitsOf({ units: NaN }), 1);
  assert.equal(unitsOf({ units: 2.9 }), 2);   // 無條件捨去
  assert.equal(unitsOf({ units: 3 }), 3);
});

/* ── 防呆 ───────────────────────────────────────────────── */

test('★★★ 父子成環不會無限迴圈（資料庫也擋，但畫面不能靠資料一定是對的活著）', () => {
  const loop: RoomNode[] = [
    { name: 'A', estate: null, parent: 'B' },
    { name: 'B', estate: null, parent: 'A' },
  ];
  assert.deepEqual(ancestryOf(loop, 'A'), ['A', 'B']);
  // 兩列互為父子 → 都不是葉子 → 分母 0，而不是掛掉
  assert.equal(totalUnits(loop), 0);
});

test('★ 指到一個不存在的父層 → 就當它沒有父層，不要爆', () => {
  const orphan: RoomNode[] = [{ name: 'A', estate: null, parent: '不存在' }];
  assert.deepEqual(ancestryOf(orphan, 'A'), ['A', '不存在']);
  assert.equal(totalUnits(orphan), 1);      // 沒有人指 A 當父層 → A 是葉子
});

test('★★ 同名兩列（洪家 C房 那種）→ ancestryOf 只認第一筆，不看順序', () => {
  const dupe: RoomNode[] = [
    { name: 'C房', estate: '洪家', parent: null },
    { name: 'C房', estate: '洪家', parent: '別的' },
  ];
  assert.deepEqual(ancestryOf(dupe, 'C房'), ['C房']);
});

test('★ 沒有 parent 也沒有 units 的舊資料 —— 行為跟以前完全一樣', () => {
  const plain = [{ name: 'A', estate: '正隆' }, { name: 'B', estate: '正隆' }];
  const by = { A: [order('a', 'A', '2026-09-01', '2026-09-11')] };
  const t = totalOccupancy(occupancyByRoom(plain, by, R));
  assert.equal(t.rooms, 2);
  assert.equal(t.days, 60);
  assert.equal(t.used, 10);
});

test('★★ 按月切也要吃子母 —— 十二格加起來等於整體（跟舊的那條測試同一個性質）', () => {
  const by = { 開封整棟: [order('w', '開封整棟', '2026-09-01', '2026-09-11')] };
  const ms = occupancyByMonth(KAI, by, ['2026-09'], R);
  assert.equal(ms[0].rooms, 5);
  assert.equal(ms[0].used, 40);
  // 沒有交集的月份也要報 5 間，不是 7 列
  const none = occupancyByMonth(KAI, by, ['2026-01'], R);
  assert.equal(none[0].rooms, 5);
  assert.equal(none[0].days, 0);
});

/* ── subtreeOf（篩選單一房源時用） ──────────────────────── */

test('★★★ 篩「只看開封整棟」→ 底下五間都要進來，分母是 4 間不是 1 間', () => {
  const sub = subtreeOf(KAI, ['開封整棟']);
  assert.deepEqual(leafRooms(sub).map((r) => r.name).sort(),
    ['開封2-1', '開封2-2', '開封3F', '開封4F']);
  assert.equal(totalUnits(sub), 4);
  const by = { 開封整棟: [order('w', '開封整棟', '2026-09-01', '2026-09-11')] };
  const t = totalOccupancy(occupancyByRoom(sub, by, R));
  assert.equal(t.rooms, 4);
  assert.equal(t.used, 40);
});

test('★★ 篩「只看開封3F」→ 祖先要帶進來，不然記在整棟上的那幾天會消失', () => {
  const sub = subtreeOf(KAI, ['開封3F']);
  assert.deepEqual(leafRooms(sub).map((r) => r.name), ['開封3F']);   // 整棟有小孩，不是葉子
  const by = { 開封整棟: [order('w', '開封整棟', '2026-09-01', '2026-09-11')] };
  const t = totalOccupancy(occupancyByRoom(sub, by, R));
  assert.equal(t.rooms, 1);
  assert.equal(t.used, 10);                                          // 不是 0
});

test('★ 篩「只看開封2F」→ 2-1 與 2-2 進來（2 間），整棟當祖先跟著進來', () => {
  const sub = subtreeOf(KAI, ['開封2F']);
  assert.equal(totalUnits(sub), 2);
  assert.ok(sub.some((r) => r.name === '開封整棟'));
});

test('★ 沒有指定任何房源 → 全部', () => {
  assert.equal(subtreeOf(KAI, []).length, KAI.length);
});

/* ── 公司登記／辦公室登記不佔房 ─────────────────────────── */

test('★★★ 公司登記填了房號也不算佔房 —— 問的是類別，不是有沒有填房號', () => {
  assert.equal(contractOccupiesRoom({ room: '開封3F', type: 'company' }), false);
  assert.equal(contractOccupiesRoom({ room: '開封3F', type: 'office' }), false);
  assert.equal(contractOccupiesRoom({ room: '開封3F', type: 'longterm' }), true);
});

test('★ 沒有房號的一律不算（公司登記現在就是這個形狀）', () => {
  assert.equal(contractOccupiesRoom({ room: '', type: 'company' }), false);
  assert.equal(contractOccupiesRoom({ room: '  ', type: 'longterm' }), false);
  assert.equal(contractOccupiesRoom({ room: null, type: null }), false);
});

test('★ 類別是空的（舊資料）→ 有房號就算佔房，不要把舊資料踢掉', () => {
  assert.equal(contractOccupiesRoom({ room: 'A', type: null }), true);
  assert.equal(contractOccupiesRoom({ room: 'A' }), true);
});
