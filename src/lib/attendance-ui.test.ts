import test from 'node:test';
import assert from 'node:assert/strict';
import {
  toTaipeiIso, hoursBetween, leaveVote, otVote, monthGrid, shiftMonth, checkFixDate,
} from './attendance-ui.ts';

// ── 時區 ───────────────────────────────────────────

test('★ datetime-local 一律補 +08:00,不看裝置時區', () => {
  assert.equal(toTaipeiIso('2026-08-10T09:00'), '2026-08-10T09:00:00+08:00');
  // 手機時區設錯的話,同一個 09:00 會存成不同時刻,而畫面看起來完全正常
  assert.equal(new Date(toTaipeiIso('2026-08-10T09:00')).toISOString(), '2026-08-10T01:00:00.000Z');
});

test('已經有秒數的字串不會被補成兩次', () => {
  assert.equal(toTaipeiIso('2026-08-10T09:00:30'), '2026-08-10T09:00:30+08:00');
});

// ── 時數 ───────────────────────────────────────────

test('時數算法要跟資料庫一致（epoch 差 / 3600,兩位小數）', () => {
  assert.equal(hoursBetween('2026-08-10T09:00:00+08:00', '2026-08-10T13:00:00+08:00'), 4);
  assert.equal(hoursBetween('2026-08-10T09:00:00+08:00', '2026-08-10T09:30:00+08:00'), 0.5);
});

test('★ 結束早於開始回 0,不是負數', () => {
  // 負數送進 request_leave 會被 hours > 0 擋掉,但畫面在送出前就該顯示 0
  assert.equal(hoursBetween('2026-08-10T13:00:00+08:00', '2026-08-10T09:00:00+08:00'), 0);
  assert.equal(hoursBetween('', ''), 0);
});

// ── 簽核狀態 ───────────────────────────────────────

test('★ 請假送審中要講出卡在誰身上', () => {
  assert.equal(leaveVote({ status: 'pending' }).text, '等主管與總經理');
  assert.equal(
    leaveVote({ status: 'pending', manager_at: '2026-08-10T00:00:00Z' }).text,
    '主管已簽，等總經理',
    '只寫「送審中」的話,等三天的人不知道該去問誰',
  );
});

test('駁回要把理由帶出來', () => {
  const v = leaveVote({ status: 'rejected', reject_reason: '當天人手不夠' });
  assert.match(v.text, /當天人手不夠/);
  assert.equal(v.tone, 'no');
});

test('加班只有主管一票', () => {
  assert.equal(otVote({ status: 'pending' }).text, '等主管核可');
  assert.equal(otVote({ status: 'approved' }).tone, 'ok');
});

// ── 月曆 ───────────────────────────────────────────

test('★ 月曆固定 42 格 —— 列數會變的話切月份時版面會跳', () => {
  for (const [y, m] of [[2026, 2], [2026, 8], [2027, 1]] as const) {
    assert.equal(monthGrid(y, m).length, 42, `${y}/${m}`);
  }
});

test('月曆第一格一定是週日', () => {
  assert.equal(monthGrid(2026, 8)[0].dow, 0);
});

test('2026 年 8 月 1 日是週六,所以前面補 6 格上個月', () => {
  const g = monthGrid(2026, 8);
  const firstIn = g.findIndex((c) => c.inMonth);
  assert.equal(firstIn, 6);
  assert.equal(g[firstIn].date, '2026-08-01');
  assert.equal(g[5].date, '2026-07-31');
});

test('二月不會少一天（含閏年）', () => {
  assert.equal(monthGrid(2024, 2).filter((c) => c.inMonth).length, 29);
  assert.equal(monthGrid(2026, 2).filter((c) => c.inMonth).length, 28);
});

test('★ 切月份要跨年,不能變成第 0 月或第 13 月', () => {
  assert.deepEqual(shiftMonth(2026, 1, -1), [2025, 12]);
  assert.deepEqual(shiftMonth(2026, 12, 1), [2027, 1]);
  assert.deepEqual(shiftMonth(2026, 8, 0), [2026, 8]);
});

// ── 補登的日期限制 ─────────────────────────────────

test('★ 補登不能補未來 —— 會在出勤表留下一筆沒人發現的未來紀錄', () => {
  const e = checkFixDate('2026-08-20', '2026-08-10');
  assert.ok(e);
  assert.match(e!, /未來/);
});

test('補今天或昨天都可以', () => {
  assert.equal(checkFixDate('2026-08-10', '2026-08-10'), null);
  assert.equal(checkFixDate('2026-08-09', '2026-08-10'), null);
});

test('超過兩個月擋下來,叫他找主管', () => {
  const e = checkFixDate('2026-05-01', '2026-08-10');
  assert.ok(e);
  assert.match(e!, /主管/);
});

test('沒選日期要講話,不能默默送出', () => {
  assert.ok(checkFixDate('', '2026-08-10'));
});
