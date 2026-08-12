import test from 'node:test';
import assert from 'node:assert/strict';
import { dayPhase, workedText, taipeiHour } from './day-phase.ts';

test('四個時段的分界', () => {
  assert.equal(dayPhase(5).key, 'morning');
  assert.equal(dayPhase(10).key, 'morning');
  assert.equal(dayPhase(11).key, 'afternoon');
  assert.equal(dayPhase(16).key, 'afternoon');
  assert.equal(dayPhase(17).key, 'evening');
  assert.equal(dayPhase(19).key, 'evening');
  assert.equal(dayPhase(20).key, 'night');
  assert.equal(dayPhase(4).key, 'night');
});

test('★ 半夜與跨界的整數都要有結果,不能回 undefined', () => {
  // 回 undefined 的話卡片會沒有背景色,而且不會報錯
  for (let h = 0; h < 24; h++) assert.ok(dayPhase(h).gradient, `${h} 點沒有漸層`);
});

test('超出範圍的數字要收斂,不要爆掉', () => {
  assert.equal(dayPhase(24).key, dayPhase(0).key);
  assert.equal(dayPhase(-1).key, dayPhase(23).key);
  assert.equal(dayPhase(12.9).key, 'afternoon');
});

test('★ 漸層是寫死的完整類別字串', () => {
  // 組出來的類別（from-[${x}]）Tailwind 靜態掃描不到,
  // 畫面上會沒有背景而且編譯不報錯 —— 這個專案踩過一次
  for (let h = 0; h < 24; h += 3) {
    const g = dayPhase(h).gradient;
    assert.match(g, /^bg-gradient-to-br from-\S+ via-\S+ to-\S+$/);
    assert.ok(!g.includes('${') && !g.includes('['), '不能有動態片段');
  }
});

test('每段都有問候語與圖示', () => {
  for (const h of [7, 13, 18, 22]) {
    assert.ok(dayPhase(h).greeting);
    assert.ok(dayPhase(h).icon);
  }
});

// ── 已工作多久 ──────────────────────────────────

const at = (hhmm: string) => new Date(`2026-08-12T${hhmm}:00+08:00`);

test('沒打上班卡就不顯示', () => {
  assert.equal(workedText(null), '');
  assert.equal(workedText(''), '');
});

test('★ 亂七八糟的值不能算出東西來', () => {
  // hhmm() 在沒有時間時會回 '—',那個值要是被算成 0 點就會顯示「已工作 15 小時」
  assert.equal(workedText('—'), '');
  assert.equal(workedText('abc'), '');
});

test('剛打完不寫「已工作 0 分」', () => {
  assert.equal(workedText('14:14', at('14:14')), '剛打完上班卡');
});

test('未滿一小時只寫分鐘', () => {
  assert.equal(workedText('14:14', at('14:59')), '已工作 45 分');
});

test('滿一小時寫小時與分', () => {
  assert.equal(workedText('14:14', at('15:57')), '已工作 1 小時 43 分');
  assert.equal(workedText('09:00', at('17:00')), '已工作 8 小時');
});

test('★ 跨午夜的班不能顯示負數', () => {
  // 22:00 上班、01:30 還在 —— 不補一天的話會變成「已工作 -1230 分」
  assert.equal(workedText('22:00', at('01:30')), '已工作 3 小時 30 分');
});

test('taipeiHour 回 0–23 的整數', () => {
  const h = taipeiHour(new Date('2026-08-12T07:57:00Z'));  // 台北 15:57
  assert.equal(h, 15);
});
