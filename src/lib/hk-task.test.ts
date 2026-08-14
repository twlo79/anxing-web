import test from 'node:test';
import assert from 'node:assert/strict';
import {
  taskLabel, sortTasks, byDate, dayCounts, linenSets, tasksOf, isAuto,
  type TaskView,
} from './hk-task.ts';

let seq = 0;
const t = (p: Partial<TaskView> = {}): TaskView => ({
  id: `t${++seq}`, work_date: '2026-08-14',
  property_id: 'p1', work_type: '退房清潔', staff_id: null,
  auto_kind: 'checkout', done_at: null, note: null, order_id: 'o1',
  room: 'A15', guest: 'Kevin', staff: null, ...p,
});

/* ── 一條字 ──────────────────────────────────── */

test('★ 順序是 工作類型 → 房源 → 客人', () => {
  // 由粗到細。掃過一整排時眼睛先抓到的是「退房」還是「入住」——
  // 那決定今天幾點要到、要帶什麼
  assert.equal(taskLabel(t()), '退房清潔 A15・Kevin');
});

test('沒有客人就不留那個間隔號', () => {
  // 「退房清潔 A15・」尾巴掛一個點,看起來像壞掉
  assert.equal(taskLabel(t({ guest: null })), '退房清潔 A15');
  assert.equal(taskLabel(t({ guest: '  ' })), '退房清潔 A15');
});

test('★ 沒有房源要講出來,不是留白', () => {
  // 洗烘折毛巾、協助行政本來就沒有房號。留白的話看起來像漏填,
  // 而人會去找一個不存在的問題
  assert.match(taskLabel(t({ room: null, work_type: '其他工時' })), /（無房源）/);
});

/* ── 排序 ────────────────────────────────────── */

test('★★ 未指派的排最前面', () => {
  // 那是這個畫面唯一需要人動手的東西。排後面的話會被擠進「+3」裡,
  // 而那正是最不該被藏起來的
  const r = sortTasks([
    t({ id: 'a', staff_id: 's1', work_type: '入住清潔' }),
    t({ id: 'b', staff_id: null, work_type: '退房清潔' }),
    t({ id: 'c', staff_id: 's2', work_type: '入住清潔' }),
  ]);
  assert.equal(r[0].id, 'b');
});

test('其餘依工作類型再依房源 —— 同一種工作聚在一起', () => {
  const r = sortTasks([
    t({ id: 'a', staff_id: 's1', work_type: '退房清潔', room: 'B7' }),
    t({ id: 'b', staff_id: 's1', work_type: '入住清潔', room: 'A15' }),
    t({ id: 'c', staff_id: 's1', work_type: '退房清潔', room: 'A13' }),
  ]);
  assert.deepEqual(r.map((x) => x.id), ['b', 'c', 'a']);
});

test('排序不會改到原本的陣列', () => {
  const src = [t({ id: 'a', staff_id: 's1' }), t({ id: 'b' })];
  sortTasks(src);
  assert.equal(src[0].id, 'a', '原陣列要保持原樣');
});

/* ── 分組與計數 ──────────────────────────────── */

test('依日期分組,而且每天都排好序', () => {
  const g = byDate([
    t({ id: 'a', work_date: '2026-08-14', staff_id: 's1' }),
    t({ id: 'b', work_date: '2026-08-14', staff_id: null }),
    t({ id: 'c', work_date: '2026-08-15' }),
  ]);
  assert.deepEqual(Object.keys(g).sort(), ['2026-08-14', '2026-08-15']);
  assert.equal(g['2026-08-14'][0].id, 'b', '未指派的要在前面');
});

test('★ 一天的三個數字：總數、未指派、已完成', () => {
  const c = dayCounts([
    t({ staff_id: 's1', done_at: '2026-08-14T03:00:00Z' }),
    t({ staff_id: 's1' }),
    t({ staff_id: null }),
  ]);
  assert.deepEqual(c, { total: 3, unassigned: 1, done: 1 });
});

/* ── 布巾 ────────────────────────────────────── */

const beds: Record<string, number | null> = { p1: 2, p2: 4, p3: null };
const bedsOf = (id: string) => beds[id];

test('★ 布巾組數 = 每筆工作的房源床數加總', () => {
  const r = linenSets([t({ property_id: 'p1' }), t({ property_id: 'p2' })], bedsOf);
  assert.deepEqual(r, { sets: 6, unknown: 0 });
});

test('★★ 床數沒填的不能當成 0,要另外報', () => {
  // 當成 0 的話那間房就靜靜地少帶一組床單 —— 房務到現場才發現,
  // 而總數看起來完全正常
  const r = linenSets([t({ property_id: 'p1' }), t({ property_id: 'p3' })], bedsOf);
  assert.deepEqual(r, { sets: 2, unknown: 1 });
});

test('沒有房源的工作不帶布巾', () => {
  const r = linenSets([t({ property_id: null, work_type: '其他工時' })], bedsOf);
  assert.deepEqual(r, { sets: 0, unknown: 0 });
});

test('★ 公區與整棟可以排除在布巾之外', () => {
  const r = linenSets(
    [t({ property_id: 'p1' }), t({ property_id: 'p2' })],
    bedsOf, (id) => id !== 'p2');
  assert.deepEqual(r, { sets: 2, unknown: 0 });
});

/* ── 個人視角 ────────────────────────────────── */

test('★ 房務只看自己的', () => {
  const r = tasksOf([
    t({ id: 'a', staff_id: 's1' }),
    t({ id: 'b', staff_id: 's2' }),
    t({ id: 'c', staff_id: 's1' }),
  ], 's1');
  assert.deepEqual(r.map((x) => x.id).sort(), ['a', 'c']);
});

test('未指派的不算任何人的', () => {
  assert.equal(tasksOf([t({ staff_id: null })], 's1').length, 0);
});

/* ── 自動 vs 人工 ────────────────────────────── */

test('★ 分得出哪些是系統自動長出來的', () => {
  // 自動的用灰色標「自動填入」—— 看的人要知道那不是誰排的,
  // 是訂單推導出來的,改訂單日期它會自己搬
  assert.equal(isAuto(t({ auto_kind: 'checkout' })), true);
  assert.equal(isAuto(t({ auto_kind: 'checkin' })), true);
  assert.equal(isAuto(t({ auto_kind: null })), false);
});
