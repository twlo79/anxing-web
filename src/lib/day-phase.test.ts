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
  // 畫面上會沒有背景而且編譯不報錯 —— 這個專案踩過一次。
  // 寫死的 from-[#41689B] 掃描得到,所以中括號本身沒問題,
  // 有問題的是中括號裡面出現變數
  for (let h = 0; h < 24; h += 3) {
    const g = dayPhase(h).gradient;
    assert.match(g, /^bg-gradient-to-br from-\S+ via-\S+ to-\S+$/);
    assert.ok(!g.includes('${'), '不能有插值');
    for (const m of g.matchAll(/\[([^\]]*)\]/g)) {
      assert.match(m[1], /^#[0-9A-Fa-f]{6}$/, `${m[1]} 不是寫死的色碼`);
    }
  }
});

const lum = (hex: string) => {
  const c = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const contrast = (a: string, b: string) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

test('★ 每一段的字色對它自己的底色都要讀得清楚', () => {
  // 打卡是站在戶外做的事。原本 amber-400 上的白字對比只有 1.6:1,
  // 太陽底下等於看不見 —— 而那時他正需要確認自己算不算遲到。
  //
  // 淡藍與黃色底一定要配深色字,所以字色跟著時段走(ink),
  // 這個測試就是在盯「配錯了會發生什麼」
  const MOR_INK = '#2E3840';
  for (const h of [7, 13, 18, 22]) {
    const p = dayPhase(h);
    const fg = p.ink.strong === 'text-white' ? '#FFFFFF' : MOR_INK;
    for (const m of p.gradient.matchAll(/\[(#[0-9A-Fa-f]{6})\]/g)) {
      const r = contrast(fg, m[1]);
      assert.ok(r >= 3, `${p.key}:${fg} 對 ${m[1]} 只有 ${r.toFixed(1)}:1`);
    }
  }
});

test('★ 淺色底不能配白字', () => {
  // 「早上淡藍、中午黃色」—— 那兩塊底色上的白字對比約 1.2:1,
  // 等於整張卡上的時間看不見。加深色底時很容易忘記這件事
  for (const h of [7, 13, 18, 22]) {
    const p = dayPhase(h);
    const stops = [...p.gradient.matchAll(/\[(#[0-9A-Fa-f]{6})\]/g)].map((m) => m[1]);
    const darkest = stops.reduce((a, b) => (lum(a) < lum(b) ? a : b));
    const whiteWorks = contrast('#FFFFFF', darkest) >= 3;
    assert.equal(p.ink.strong === 'text-white', whiteWorks,
      `${p.key} 的底色(${darkest})與字色搭錯了`);
  }
});

test('★ 打卡按鈕四段長得一樣：白底黑字', () => {
  // 它是整張卡唯一要人動手的地方。跟著卡片翻面的話,
  // 使用者每次打開都要重新找那顆按鈕在哪裡
  for (const h of [7, 13, 18, 22]) {
    const b = dayPhase(h).ink.btn;
    assert.match(b, /bg-white/, `${dayPhase(h).key} 的按鈕不是白底`);
    assert.match(b, /text-mor-ink/, `${dayPhase(h).key} 的按鈕不是黑字`);
  }
});

test('★ 淺色卡上的白按鈕要有邊', () => {
  // 白底按鈕擺在淺藍或黃橘上,邊界會糊掉 —— 那顆按鈕會看起來像
  // 一塊沒有形狀的亮斑,而不是一個可以按的東西
  for (const h of [7, 13, 18, 22]) {
    const p = dayPhase(h);
    if (p.ink.strong !== 'text-white') {
      assert.match(p.ink.btn, /ring-/, `${p.key} 的按鈕沒有邊`);
    }
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
