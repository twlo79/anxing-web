import test from 'node:test';
import assert from 'node:assert/strict';
import { punchUi, geoErrorMessage, hhmm, remainText } from './punch.ts';

// ── 按鈕該顯示什麼 ─────────────────────────────────

test('還沒打卡 → 顯示「上班打卡」', () => {
  const u = punchUi(null);
  assert.equal(u.action, 'in');
  assert.equal(u.label, '上班打卡');
});

test('打了上班沒打下班 → 顯示「下班打卡」,並講出幾點上班的', () => {
  const u = punchUi({ in_at: '09:02' });
  assert.equal(u.action, 'out');
  assert.match(u.hint, /09:02/);
});

test('★ 上下班都打完 → 兩顆都不能按', () => {
  const u = punchUi({ in_at: '09:02', out_at: '18:05' });
  assert.equal(u.action, null, '已經打完還讓人按,只會撞到必定失敗的 ALREADY_OUT');
  assert.match(u.hint, /補登申請/, '要告訴他怎麼修改');
});

test('只有下班卡（異常）→ 仍然顯示上班打卡', () => {
  // migration_98 擋住了這種情況,但舊資料或補登可能造成
  const u = punchUi({ out_at: '18:00' });
  assert.equal(u.action, 'in');
});

// ── GPS 的三種失敗要講不同的話 ─────────────────────

test('★ 權限被拒 → 教他去哪裡開權限', () => {
  const e = geoErrorMessage(1);
  assert.equal(e.code, 'PERMISSION_DENIED');
  assert.match(e.message, /鎖頭|設定/);
  assert.match(e.message, /無痕/, '無痕視窗擋定位是很常見的原因');
});

test('★ 收不到訊號 → 叫他走到窗邊,不是去改權限', () => {
  const e = geoErrorMessage(2);
  assert.equal(e.code, 'POSITION_UNAVAILABLE');
  assert.match(e.message, /窗邊|戶外/);
  assert.doesNotMatch(e.message, /權限/, '室內收不到訊號的人跑去改權限,改完還是不行然後放棄');
});

test('逾時 → 叫他再按一次', () => {
  const e = geoErrorMessage(3);
  assert.equal(e.code, 'TIMEOUT');
  assert.match(e.message, /再按一次/);
});

test('未知錯誤也要有話講,不能是空白', () => {
  assert.ok(geoErrorMessage(99).message.length > 0);
});

// ── 顯示 ───────────────────────────────────────────

test('沒有時間顯示 — 而不是空白（空白看起來像壞掉）', () => {
  assert.equal(hhmm(null), '—');
  assert.equal(hhmm(''), '—');
  assert.equal(hhmm('not-a-date'), '—');
});

test('剩餘假同時給小時與天 —— 制度是小時,但人是用天在想的', () => {
  assert.equal(remainText(52, 8), '52 小時（約 6.5 天）');
  assert.equal(remainText(80, 8), '80 小時（約 10 天）');
});

test('無額度上限的假別顯示「不限」', () => {
  assert.equal(remainText(null, 8), '不限');
});

test('每日工時是 0 時不能除以零', () => {
  assert.equal(remainText(52, 0), '52 小時（約 0 天）');
});
