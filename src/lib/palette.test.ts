import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { contrast } from './star-bar.ts';

/**
 * 色票的對比守門員。
 *
 * ============================================================
 * 【★★ 去讀 `tailwind.config.ts`，不要在測試裡抄一份色碼】
 *
 * 抄一份的話，改了設定檔而忘了改測試 —— 測試還是綠的，
 * 而它守的是一組**已經不存在的顏色**。那比沒有測試更糟:
 * 它會讓人以為有人在看。
 *
 * 這跟 `day-phase.test.ts` 去讀 `globals.css` 是同一套做法。
 *
 *
 * ============================================================
 * 【★★★ 為什麼會有 `mor-greendark` 這個色】
 *
 * 2026-08-28 匯出鈕要改成綠色外框。第一個念頭是用現成的 `mor-green`，
 * 但量出來 **#3FAE7C 對白底只有 2.78:1** ——
 *
 *   · 它一直是對的，因為它只被拿來畫**進度條**（一大片面積的「面」）
 *   · 拿來當 12px 的字與 1px 的邊框就會糊掉
 *
 * ★ 同一個顏色，用在「面」上合格、用在「線與字」上不合格 ——
 *   而畫面不會說話。所以分成兩個色票，各自守各自的門檻。
 */

const CFG = readFileSync(new URL('../../tailwind.config.ts', import.meta.url), 'utf8');

/** 從 tailwind.config.ts 撈一個 mor 色票。撈不到就讓測試紅，不要回預設值。 */
function tone(name: string): string {
  const m = CFG.match(new RegExp(`\\b${name}:\\s*'(#[0-9A-Fa-f]{6})'`));
  assert.ok(m, `tailwind.config.ts 裡找不到 mor.${name} —— 是不是被改名或刪掉了？`);
  return m![1].toUpperCase();
}

const WHITE = '#FFFFFF';
/** 小字與細線的門檻（WCAG 1.4.3）。 */
const TEXT_MIN = 4.5;

test('色票都還在（改名或刪掉要在這裡先紅）', () => {
  for (const n of ['slate', 'slatedark', 'green', 'greendark', 'greenlight', 'line', 'ink']) {
    assert.match(tone(n), /^#[0-9A-F]{6}$/);
  }
});

/*
 * ★★★ 這是整支的重點:匯出鈕的字與邊框在白底上要讀得到。
 */
test('★★ 匯出鈕的綠（greendark）在白底上 ≥ 4.5:1', () => {
  const r = contrast(tone('greendark'), WHITE);
  assert.ok(r >= TEXT_MIN,
    `mor-greendark ${tone('greendark')} 對白底只有 ${r.toFixed(2)}:1，字會糊`);
});

/*
 * ★ hover 時底色會變成 greenlight —— 那一刻字還是要讀得到。
 *
 *   只驗白底的話，滑鼠移上去才糊掉,而那是**最常被看到的那一瞬間**。
 */
test('★★ 滑過去（底變 greenlight）字還是要讀得到', () => {
  const r = contrast(tone('greendark'), tone('greenlight'));
  assert.ok(r >= TEXT_MIN,
    `greendark 在 greenlight 上只有 ${r.toFixed(2)}:1 —— hover 的瞬間會糊`);
});

/*
 * ★★ 釘住「green 不能拿來當文字」這件事本身。
 *
 *   這條的寫法很特別:它**期待 mor-green 不及格**。
 *   哪天有人把 green 調深到 4.5 以上,兩個色票就重疊了 ——
 *   那時該做的是把 greendark 刪掉,而不是留兩個一樣的。
 *   所以這裡紅了不是壞事,是在說「可以合併了」。
 */
test('★ mor-green 是給「面」用的 —— 它當文字本來就不及格', () => {
  const r = contrast(tone('green'), WHITE);
  assert.ok(r < TEXT_MIN,
    `mor-green 現在是 ${r.toFixed(2)}:1，已經夠當文字了 —— `
    + `那 greendark 就是多餘的，考慮合併成一個`);
});

test('主色 mor-slate 上的白字 ≥ 4.5:1（實心鈕）', () => {
  const r = contrast(WHITE, tone('slate'));
  assert.ok(r >= TEXT_MIN, `白字在 mor-slate 上只有 ${r.toFixed(2)}:1`);
});

test('hover 的 slatedark 要比 slate 更暗，不是更亮', () => {
  assert.ok(contrast(WHITE, tone('slatedark')) > contrast(WHITE, tone('slate')),
    'slatedark 沒有比 slate 暗 —— hover 會變淡，感覺像按鈕壞了');
});

/*
 * ★ 匯出（綠）與新增（藍）必須一眼分得出來。
 *   兩個都是按鈕、都在同一排,顏色是唯一的區分 ——
 *   而「一眼分得出來」的底線是**色相差夠遠**，不是對比度。
 */
test('★ 匯出綠與主色藍的色相要離得夠遠', () => {
  const hue = (hex: string) => {
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(1 + i, 3 + i), 16) / 255);
    const mx = Math.max(r, g, b); const mn = Math.min(r, g, b); const d = mx - mn;
    if (d === 0) return 0;
    const h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return ((h * 60) + 360) % 360;
  };
  const d = Math.abs(hue(tone('greendark')) - hue(tone('slate')));
  assert.ok(Math.min(d, 360 - d) >= 45,
    `匯出綠 ${tone('greendark')} 與主色 ${tone('slate')} 只差 ${Math.min(d, 360 - d).toFixed(0)}°，太像了`);
});
