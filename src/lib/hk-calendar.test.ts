import test from 'node:test';
import assert from 'node:assert/strict';
import { groupByStaff, byDate, entryText, dayTotal, type WorkItem } from './hk-calendar.ts';

const NAMES: Record<string, string> = { s1: 'Una', s2: '庭玉', s3: '劉姐' };
const WORK: Record<string, string> = { 清潔: '清潔', 洗烘折: '洗烘折' };
const staffName = (id: string) => NAMES[id] ?? id;
const workName = (c: string) => WORK[c] ?? c;
const roomName = (c: string) => c;

const wi = (staff_id: string, property_code: string | null, work_type = '清潔', work_date = '2026-08-12'): WorkItem =>
  ({ id: Math.random().toString(36), work_date, property_code, work_type, staff_id });

test('同一個人同一種工作收成一列', () => {
  const g = groupByStaff([wi('s1', 'A1'), wi('s1', 'A2'), wi('s1', 'A3')], staffName, workName, roomName);
  assert.equal(g.length, 1);
  assert.equal(g[0].staff, 'Una');
  assert.deepEqual(g[0].rooms, ['A1', 'A2', 'A3']);
});

test('★ 同一個人不同工作類型要分開', () => {
  // 併成一列的話「Una 清潔 9 間」裡面混了三筆洗烘折,間數就是錯的
  const g = groupByStaff(
    [wi('s1', 'A1'), wi('s1', null, '洗烘折')], staffName, workName, roomName);
  assert.equal(g.length, 2);
});

test('★ 沒有房源的工作不能消失', () => {
  // property_code = null 是「協助行政、洗烘折毛巾」,那仍然是一件工作
  const g = groupByStaff([wi('s1', null, '洗烘折')], staffName, workName, roomName);
  assert.equal(g.length, 1);
  assert.deepEqual(g[0].rooms, []);
});

test('間數多的排前面 —— 一眼看到當天主力', () => {
  const g = groupByStaff(
    [wi('s2', 'B1'), wi('s1', 'A1'), wi('s1', 'A2'), wi('s1', 'A3')],
    staffName, workName, roomName);
  assert.deepEqual(g.map((e) => e.staff), ['Una', '庭玉']);
});

test('間數相同時照姓名排 —— 順序不能每次重新整理都在跳', () => {
  const g = groupByStaff([wi('s3', 'C1'), wi('s2', 'B1')], staffName, workName, roomName);
  assert.equal(g.length, 2);
  assert.deepEqual(g.map((e) => e.staff).sort(), ['劉姐', '庭玉'].sort());
});

test('房號在同一列裡也要排序', () => {
  const g = groupByStaff([wi('s1', 'A3'), wi('s1', 'A1'), wi('s1', 'A2')], staffName, workName, roomName);
  assert.deepEqual(g[0].rooms, ['A1', 'A2', 'A3']);
});

test('byDate 依日期分組', () => {
  const m = byDate([
    wi('s1', 'A1', '清潔', '2026-08-12'),
    wi('s1', 'A2', '清潔', '2026-08-13'),
    wi('s2', 'B1', '清潔', '2026-08-12'),
  ]);
  assert.equal(m['2026-08-12'].length, 2);
  assert.equal(m['2026-08-13'].length, 1);
  assert.equal(m['2026-08-14'], undefined);
});

test('★ 沒有房源時不寫「0 間」', () => {
  // 「Una 洗烘折 0」看起來像出錯了,但那是一件正常的工作
  const g = groupByStaff([wi('s1', null, '洗烘折')], staffName, workName, roomName);
  assert.equal(entryText(g[0]), 'Una 洗烘折');
  const g2 = groupByStaff([wi('s1', 'A1')], staffName, workName, roomName);
  assert.equal(entryText(g2[0]), 'Una 1');
});

test('★ 一天的人數不能重複計算', () => {
  // 同一個人做兩種工作是一個人,不是兩個
  const g = groupByStaff(
    [wi('s1', 'A1'), wi('s1', null, '洗烘折'), wi('s2', 'B1')], staffName, workName, roomName);
  const t = dayTotal(g);
  assert.equal(t.people, 2);
  assert.equal(t.rooms, 2);
});

test('空的一天回 0,不是 NaN', () => {
  assert.deepEqual(dayTotal([]), { people: 0, rooms: 0 });
});

test('查不到名稱時退回代碼,不要顯示空白', () => {
  const g = groupByStaff([wi('unknown', 'X1')], staffName, workName, roomName);
  assert.equal(g[0].staff, 'unknown');
});
