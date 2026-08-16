import test from 'node:test';
import assert from 'node:assert/strict';
import {
  taskLabel, sortTasks, byDate, dayCounts, linenSets, tasksOf, isAuto,
  toneKeyOf, toneOfType, TYPE_LEGEND, isPending,
  durationMin, hhmmOf, timeRangeText, startKeyOf, displayTitle,
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

test('★ 一天的四個數字：總數、未指派、已完成、待確認', () => {
  const c = dayCounts([
    t({ staff_id: 's1', done_at: '2026-08-14T03:00:00Z' }),
    t({ staff_id: 's1' }),
    t({ staff_id: null }),
  ]);
  assert.deepEqual(c, { total: 3, unassigned: 1, done: 1, pending: 0 });
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

/* ── 工作類型的顏色（2026-08-16，照 TimeTree） ─── */

test('★★ 退房要排在清潔前面 —— 不然「退房清潔」會撞到「清潔」', () => {
  assert.equal(toneKeyOf('退房清潔'), '退房');
  assert.equal(toneKeyOf('入住清潔'), '入住');
});

test('★ 換房、細清、公區都歸清潔', () => {
  assert.equal(toneKeyOf('換房清潔'), '清潔');
  assert.equal(toneKeyOf('細清'), '清潔');
  assert.equal(toneKeyOf('公區清潔'), '清潔');
});

test('★★ 用包含比對,類型改名不會掉回「其他」', () => {
  // 工作類型是設定頁可以改的。「退房清潔（含布巾）」不該變成灰色
  assert.equal(toneKeyOf('退房清潔（含布巾）'), '退房');
});

test('休假與請假同一色', () => {
  assert.equal(toneKeyOf('U休'), '休假');
  assert.equal(toneKeyOf('請假'), '休假');
});

test('認不出來的落到「其他」,不是沒有顏色', () => {
  assert.equal(toneKeyOf('贈品補充'), '其他');
  assert.equal(toneKeyOf(''), '其他');
  assert.equal(toneKeyOf(null), '其他');
});

test('★ 每一種都真的拿得到顏色', () => {
  for (const t of ['退房清潔', '入住清潔', '細清', 'U休', '其他工時']) {
    assert.ok(toneOfType(t).bg.startsWith('#'), t);
    assert.ok(toneOfType(t).fg.startsWith('#'), t);
  }
});

test('★★ 黃色用深字 —— 白字在黃底上讀不到', () => {
  assert.equal(toneOfType('U休').fg, '#5C4B00');
  assert.equal(toneOfType('退房清潔').fg, '#FFFFFF');
});

test('圖例五種都在', () => {
  assert.equal(TYPE_LEGEND.length, 5);
  assert.deepEqual(TYPE_LEGEND.map((x) => x.key), ['退房', '入住', '清潔', '休假', '其他']);
});

/* ── 未接受的建議（migration_133） ─────────────── */

test('★★ 未接受的不算進 total —— 那是建議不是工作', () => {
  // 「今天 6 件」跟「4 件 ＋ 2 個建議」是兩回事。
  // 混在一起的話人會照 6 去排人力，而其中兩件他還沒決定要不要做
  const c = dayCounts([
    t({ accepted: true }), t({ accepted: true }),
    t({ accepted: false }), t({ accepted: false }),
  ]);
  assert.equal(c.total, 2);
  assert.equal(c.pending, 2);
});

test('★ 沒有 accepted 欄位的一律當成已接受', () => {
  // 舊資料與還沒跑 migration 的環境不能突然變空白
  const c = dayCounts([t({}), t({})]);
  assert.equal(c.total, 2);
  assert.equal(c.pending, 0);
});

test('★ 未指派只數已接受的', () => {
  const c = dayCounts([
    t({ accepted: true, staff_id: null }),
    t({ accepted: false, staff_id: null }),
  ]);
  assert.equal(c.unassigned, 1, '未接受的還沒到「要指派」那一步');
});

test('isPending 只認明確的 false', () => {
  assert.equal(isPending({ accepted: false }), true);
  assert.equal(isPending({ accepted: true }), false);
  assert.equal(isPending({}), false);
});

/* ── 時間（migration_134） ─────────────────────── */

test('★★ 跨夜是 +24 小時,不是負數', () => {
  // end < start 代表做到隔天。直接相減會顯示「−20 小時」,
  // 看的人只會覺得系統壞了
  assert.equal(durationMin('22:00', '02:00'), 240);
});

test('★ 正常區間', () => {
  assert.equal(durationMin('09:00', '17:30'), 510);
});

test('缺一半就算不出來', () => {
  assert.equal(durationMin('09:00', null), null);
  assert.equal(durationMin(null, '17:00'), null);
});

test('★ 秒不顯示 —— 那個 :00 沒有資訊', () => {
  assert.equal(hhmmOf('09:00:00'), '09:00');
  assert.equal(hhmmOf(null), '');
});

test('★★ 全天不寫「全天」兩個字', () => {
  // 絕大多數工作都是全天,每一列掛一個「全天」等於整片噪音
  assert.equal(timeRangeText({ all_day: true }), '');
  assert.equal(timeRangeText({ all_day: false, start_time: '09:00:00', end_time: '11:00:00' }), '09:00–11:00');
});

test('只填開始時間也顯示得出來', () => {
  assert.equal(timeRangeText({ all_day: false, start_time: '14:00', end_time: null }), '14:00');
});

test('★ 全天排最前,其餘照開始時間', () => {
  assert.equal(startKeyOf({ all_day: true }), -1);
  assert.equal(startKeyOf({ all_day: false, start_time: '09:00' }), 540);
  assert.equal(startKeyOf({ all_day: false, start_time: null }), 1440, '沒填時間的排最後');
});

test('★★ 有自訂標題就用它', () => {
  // 「聚餐」不該被組成「其他工時 (無房源)」
  assert.equal(displayTitle({ ...t(), title: '聚餐' }), '聚餐');
  assert.equal(displayTitle({ ...t(), title: '  ' }), '退房清潔 A15・Kevin', '只有空白不算填了');
  assert.equal(displayTitle(t()), '退房清潔 A15・Kevin');
});
