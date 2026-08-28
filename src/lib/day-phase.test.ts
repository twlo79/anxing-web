import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dayPhase, workedText, taipeiHour } from './day-phase.ts';

/*
 * ★★ 2026-08-28：背景從 Tailwind 的漸層類別搬到 `globals.css`。
 *
 *   原本兩個測試是**從類別字串裡挖 `[#RRGGBB]`** 來驗對比度的。
 *   搬走之後那些色碼不在 `.ts` 裡了 —— 而那兩個測試守的東西沒有消失:
 *   淺色底配白字,整張卡的時間就看不見。
 *
 * ★ 所以改成**去讀真正的 CSS**，不是在 `.ts` 裡抄一份色票。
 *   抄一份的話兩邊會各自演化,而測試會一直是綠的
 *   —— 那正是 README 9.4 #12「自檢不能複製被檢查的邏輯」。
 */
const CSS = readFileSync('src/app/globals.css', 'utf8');

/** 從 globals.css 撈某個 .phase-* 類別實際用到的所有色碼。 */
function stopsOf(cls: string): string[] {
  const i = CSS.indexOf(`.${cls} {`);
  assert.notEqual(i, -1, `globals.css 裡找不到 .${cls} —— 卡片會沒有背景,而且編譯不報錯`);
  const body = CSS.slice(i, CSS.indexOf('\n  }', i));
  return [...body.matchAll(/#[0-9A-Fa-f]{6}/g)].map((m) => m[0]);
}

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

test('★★ 每一段的背景類別在 globals.css 裡真的存在', () => {
  // 打錯一個字的症狀是**卡片沒有背景**,而 tsc 與其他測試都不會有反應。
  // 這一條問的是「那個類別真的在 CSS 裡嗎」,不是「字串長得對不對」。
  for (let h = 0; h < 24; h += 3) {
    const g = dayPhase(h).gradient;
    assert.match(g, /^phase-[a-z]+$/, `${g} 不是 phase-* 類別`);
    assert.ok(stopsOf(g).length >= 3, `${g} 在 CSS 裡的色碼太少,可能不是完整的背景`);
  }
});

test('★ 不要有橫線（2026-08-28 使用者指定）', () => {
  /*
   * 拿掉的理由不只是不好看:那些線跟卡片上數字的基線平行,
   * 眼睛會把它們當成表格的分隔線,而卡片上並沒有一行一行的東西。
   *
   * `repeating-linear-gradient` 是做出那種紋路唯一的方法 ——
   * 它出現就代表有人把橫線加回來了。
   */
  for (let h = 0; h < 24; h += 3) {
    const cls = dayPhase(h).gradient;
    const i = CSS.indexOf(`.${cls} {`);
    const body = CSS.slice(i, CSS.indexOf('\n  }', i));
    assert.ok(!body.includes('repeating-linear-gradient'), `${cls} 又有橫線了`);
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
    for (const stop of stopsOf(p.gradient)) {
      const r = contrast(fg, stop);
      assert.ok(r >= 3, `${p.key}:${fg} 對 ${stop} 只有 ${r.toFixed(1)}:1`);
    }
  }
});

test('★★ 兩種字色裡要挑比較讀得到的那一個', () => {
  /*
   * 原本這一條是「看最深的那個色停,白字撐得住就用白字」。
   *
   * ★★ 2026-08-28 降飽和之後那個規則壞了。
   *
   *   新的午後過渡最深的一停是 #7383AB —— 白字對它有 3.4:1,規則說「用白字」。
   *   但那一停只是卡片右下角的一小塊,**字實際上坐在左上角的 #F4E2CE 上**,
   *   白字對它只有 1.3:1。規則看的是一個字根本不會出現的地方。
   *
   * ★ 改成問**最糟的情況**:兩種字色各自算出它在整張卡上最難讀的一處,
   *   選中的那個必須比較好。這樣不管漸層長什麼樣、深色在哪一角都成立。
   */
  const MOR_INK = '#2E3840';
  for (const h of [7, 13, 18, 22]) {
    const p = dayPhase(h);
    const stops = stopsOf(p.gradient);
    assert.ok(stops.length, `${p.key} 撈不到色碼`);
    const worst = (fg: string) => Math.min(...stops.map((c) => contrast(fg, c)));
    const w = worst('#FFFFFF');
    const k = worst(MOR_INK);
    const chose = p.ink.strong === 'text-white';
    assert.equal(chose, w > k,
      `${p.key} 挑錯字色:白字最糟 ${w.toFixed(1)}:1、墨色最糟 ${k.toFixed(1)}:1，`
      + `而現在用的是${chose ? '白字' : '墨色字'}`);
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
