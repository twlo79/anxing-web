import test from 'node:test';
import assert from 'node:assert/strict';
import {
  toTaipeiIso, hoursBetween, leaveVote, otVote, monthGrid, shiftMonth, checkFixDate,
  dayStatus, countTodo, monthSummary, monthRange, quickRange, type ReportRow,
} from './attendance-ui.ts';

const row = (p: Partial<ReportRow>): ReportRow => ({
  work_date: '2026-08-05', item: '上班日', in_at: null, out_at: null,
  work_hours: 8, leave_hours: 0, ot_hours: 0, late_min: 0, early_min: 0, note: null, ...p,
});

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

// ── 每日打卡狀態 ───────────────────────────────────

test('上下班都打完、沒遲到早退 → 正常', () => {
  const s = dayStatus(row({ in_at: '09:57', out_at: '19:21' }), '2026-08-10');
  assert.equal(s.label, '正常');
  assert.equal(s.tone, 'ok');
  assert.equal(s.fixKind, null);
});

test('★ 今天打了上班還沒下班 → 是「上班中」,不是異常', () => {
  const s = dayStatus(row({ work_date: '2026-08-10', in_at: '09:49' }), '2026-08-10');
  assert.equal(s.tone, 'wait', '把還在上班的人標成紅色異常,他會每天早上看到一次紅字');
  assert.equal(s.fixKind, null);
});

test('★ 前一天打了上班沒下班 → 要處理,而且要能一鍵補下班卡', () => {
  const s = dayStatus(row({ work_date: '2026-08-07', in_at: '10:00' }), '2026-08-10');
  assert.equal(s.tone, 'bad');
  assert.equal(s.fixKind, 'out', '只標紅字的話員工看到也只會想「喔」然後關掉');
});

test('只有下班卡 → 補上班卡', () => {
  const s = dayStatus(row({ work_date: '2026-08-04', out_at: '21:21' }), '2026-08-10');
  assert.equal(s.label, '沒打上班卡');
  assert.equal(s.fixKind, 'in');
});

test('遲到與早退各自講出分鐘數', () => {
  assert.match(dayStatus(row({ in_at: '10:25', out_at: '19:00', late_min: 25 }), '2026-08-10').label, /遲到 25 分/);
  assert.match(dayStatus(row({ in_at: '09:00', out_at: '18:58', early_min: 62 }), '2026-08-10').label, /早退 62 分/);
  const both = dayStatus(row({ in_at: '10:25', out_at: '17:00', late_min: 25, early_min: 60 }), '2026-08-10');
  assert.match(both.label, /遲到.*早退/);
});

test('★ 例假日與國定假日不是異常', () => {
  for (const item of ['例假日', '中秋節', '國慶日']) {
    const s = dayStatus(row({ item }), '2026-08-10');
    assert.equal(s.tone, 'off', `${item} 被標成異常的話,一個月會有十幾天紅的`);
    assert.equal(s.label, item);
  }
});

test('★ 請假當天沒打卡不是曠職', () => {
  const s = dayStatus(row({ item: '事假', leave_hours: 8 }), '2026-08-10');
  assert.equal(s.tone, 'off');
  assert.equal(s.fixKind, null);
});

test('上班日兩張卡都沒有、也沒請假 → 未出勤,要補', () => {
  const s = dayStatus(row({ item: '未出勤' }), '2026-08-10');
  assert.equal(s.label, '未出勤');
  assert.equal(s.tone, 'bad');
});

test('未來的日期不顯示狀態(還沒發生)', () => {
  assert.equal(dayStatus(row({ work_date: '2026-08-20' }), '2026-08-10').tone, 'none');
});

test('★ 今天還沒打上班卡 → 「還沒打卡」,不是未出勤', () => {
  const s = dayStatus(row({ work_date: '2026-08-10', item: '未出勤' }), '2026-08-10');
  assert.equal(s.tone, 'wait', '今天還沒過完,不能說人家未出勤');
  assert.equal(s.fixKind, null, '今天的卡直接打就好,不用補登');
});

test('★ 系統上線前的日子完全不評價', () => {
  // 系統 8/10 上線。沒有這條的話近 30 天會有 21 天「未出勤」,
  // 而那 21 天根本還沒有打卡這回事 —— 全紅的清單跟全綠的一樣沒有資訊量
  const s = dayStatus(row({ work_date: '2026-07-15', item: '未出勤' }), '2026-08-10', '2026-08-10');
  assert.equal(s.tone, 'none');
  assert.equal(s.label, '');
});

test('上線後的未出勤還是要抓出來', () => {
  const s = dayStatus(row({ work_date: '2026-08-12', item: '未出勤' }), '2026-08-20', '2026-08-10');
  assert.equal(s.tone, 'bad');
});

test('★ 待處理天數會扣掉上線前的日子', () => {
  const rows = [
    row({ work_date: '2026-07-20', item: '未出勤' }),
    row({ work_date: '2026-07-21', item: '未出勤' }),
    row({ work_date: '2026-08-12', item: '未出勤' }),
  ];
  assert.equal(countTodo(rows, '2026-08-20'), 3, '不給 firstDay 就是全部都算');
  assert.equal(countTodo(rows, '2026-08-20', '2026-08-10'), 1);
});

// ── 月統計 ─────────────────────────────────────────

test('月統計把三十列加起來', () => {
  const rows = [
    row({ work_date: '2026-08-03', in_at: '09:57', out_at: '19:21', work_hours: 8, ot_hours: 2 }),
    row({ work_date: '2026-08-04', in_at: '10:25', out_at: '19:00', work_hours: 8, late_min: 25 }),
    row({ work_date: '2026-08-05', item: '事假', leave_hours: 8, work_hours: 0 }),
    row({ work_date: '2026-08-08', item: '例假日', work_hours: 0 }),
  ];
  const s = monthSummary(rows, '2026-08-20', '2026-08-01');
  assert.equal(s.days, 2, '有上班卡的天數');
  assert.equal(s.workHours, 16);
  assert.equal(s.otHours, 2);
  assert.equal(s.leaveHours, 8);
  assert.equal(s.lateDays, 1);
  assert.equal(s.earlyDays, 0);
});

test('★ 例假日不會被算進工時', () => {
  const s = monthSummary([row({ item: '例假日', work_hours: 0 })], '2026-08-20');
  assert.equal(s.workHours, 0, '例假日算工時的話一個月會憑空多出十幾天');
  assert.equal(s.days, 0);
});

test('待處理天數 = 紅色那幾天', () => {
  const rows = [
    row({ work_date: '2026-08-03', in_at: '09:57', out_at: '19:21' }),   // 正常
    row({ work_date: '2026-08-04', out_at: '21:21' }),                    // 沒打上班
    row({ work_date: '2026-08-06', item: '例假日' }),                      // 例假
    row({ work_date: '2026-08-07', in_at: '10:00' }),                     // 沒打下班
  ];
  assert.equal(countTodo(rows, '2026-08-10'), 2);
});

// ── 快速區間 ───────────────────────────────────────

test('本月 = 這個月的一號到月底', () => {
  assert.deepEqual(quickRange('thisMonth', '2026-08-10'), { from: '2026-08-01', to: '2026-08-31' });
});

test('★ 上個月要跨年,而且月底天數要對', () => {
  assert.deepEqual(quickRange('lastMonth', '2026-01-15'), { from: '2025-12-01', to: '2025-12-31' });
  assert.deepEqual(monthRange(2026, 2), { from: '2026-02-01', to: '2026-02-28' });
  assert.deepEqual(monthRange(2024, 2), { from: '2024-02-01', to: '2024-02-29' });
  assert.deepEqual(monthRange(2026, 4), { from: '2026-04-01', to: '2026-04-30' });
});

test('近 30 天含今天', () => {
  assert.deepEqual(quickRange('last30', '2026-08-10'), { from: '2026-07-12', to: '2026-08-10' });
});
