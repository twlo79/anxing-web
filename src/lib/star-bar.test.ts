import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STAR_BAR_DARK, STAR_BAR_LIGHT, STAR_TRACK_LIGHT, DEEP_BLUE, ROW_Y,
  UI_CONTRAST_MIN, contrast, flatten, luminance, deepAt,
} from './star-bar.ts';

/*
 * ★★ 這支測的是「看不看得見」與「順序對不對」，不是「顏色是不是那幾個字串」。
 *
 *   比字串的話，把紅換成另一個紅照樣會過 —— 而畫面糊掉的原因
 *   從來不是「用錯字串」，是「那個顏色在那個底上不夠亮」。
 *
 * ★ 而且這種錯**不會報錯**:畫面只是有點糊，每個人都以為是自己的螢幕。
 */

const LABELS = ['5 星', '4 星', '3 星', '2 星', '1 星'];

/** 第 i 列的軌道:黑 32% 疊在那一列高度的卡片色上（跟 STAR_TRACK_DARK 一致）。 */
const trackAt = (i: number) => flatten('#000000', 0.32, deepAt(ROW_Y[i]));

/** 色相角度（0–360）。 */
function hue(hex: string): number {
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(1 + i, 3 + i), 16) / 255);
  const mx = Math.max(r, g, b); const mn = Math.min(r, g, b); const d = mx - mn;
  if (d === 0) return 0;
  const h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return ((h * 60) + 360) % 360;
}

/* ══════════════ 先驗工具本身 ══════════════ */

test('對比度算得對（拿已知的黑白與同色驗算）', () => {
  // 工具錯的話，下面每一條都是假的通過。
  assert.equal(Math.round(contrast('#000000', '#FFFFFF')), 21);
  assert.equal(Math.round(contrast('#777777', '#777777')), 1);
  assert.ok(luminance('#FFFFFF') > luminance('#000000'));
});

test('flatten 疊色算得對', () => {
  assert.equal(flatten('#000000', 1, '#FFFFFF'), '#000000');
  assert.equal(flatten('#000000', 0, '#FFFFFF'), '#FFFFFF');
  assert.equal(flatten('#FFFFFF', 0.5, '#000000'), '#808080');
});

test('deepAt 落在色停上要剛好等於色停，中間要單調變暗', () => {
  assert.equal(deepAt(0), '#4C79A2');
  assert.equal(deepAt(0.46), '#3A5F86');
  assert.equal(deepAt(1), '#26445F');
  const ys = [0, 0.2, 0.46, 0.7, 1];
  for (let i = 1; i < ys.length; i++) {
    assert.ok(luminance(deepAt(ys[i])) < luminance(deepAt(ys[i - 1])),
      `漸層在 y=${ys[i]} 沒有比 y=${ys[i - 1]} 更暗`);
  }
});

/* ══════════════ 使用者拍板的三條規則 ══════════════ */

/*
 * ★★★ 規則一:5 星到 1 星越來越暗（使用者原話）。
 *
 *   釘住的是**順序**不是數值 —— 之後微調顏色沒關係,把順序弄反才是問題。
 */
test('★★ 5 星到 1 星，亮度嚴格遞減（深藍卡）', () => {
  const ls = STAR_BAR_DARK.map(luminance);
  for (let i = 1; i < ls.length; i++) {
    assert.ok(ls[i] < ls[i - 1],
      `${LABELS[i]} ${STAR_BAR_DARK[i]}（${(ls[i] * 100).toFixed(1)}%）`
      + ` 沒有比 ${LABELS[i - 1]} ${STAR_BAR_DARK[i - 1]}（${(ls[i - 1] * 100).toFixed(1)}%）暗`);
  }
});

test('★★ 白底那組也是遞減 —— 兩邊要同一個故事', () => {
  const ls = STAR_BAR_LIGHT.map(luminance);
  for (let i = 1; i < ls.length; i++) {
    assert.ok(ls[i] < ls[i - 1], `白底版 ${LABELS[i]} 沒有比 ${LABELS[i - 1]} 暗`);
  }
});

/*
 * ★★★ 規則二:色相依序是 黃 → 橙 → 紅 → 紅紫 → 深紫藍。
 *
 *   容差給得寬（±18°）—— 這裡問的是「還在那個色系嗎」,不是「精確幾度」。
 *   訂太窄的話,任何一次微調都會紅,而那是假警報（README 9.4 #13）。
 */
test('★★ 色相依序是 黃 → 橙 → 紅 → 紅紫 → 深紫藍', () => {
  const WANT: [string, number][] = [
    ['黃', 45], ['橙', 29], ['紅', 9], ['紅紫', 337], ['深紫藍', 281],
  ];
  STAR_BAR_DARK.forEach((c, i) => {
    const [name, want] = WANT[i];
    const d = Math.abs(hue(c) - want);
    assert.ok(Math.min(d, 360 - d) <= 18,
      `${LABELS[i]} 應該是${name}（約 ${want}°），實際 ${c} 是 ${hue(c).toFixed(0)}°`);
  });
});

test('★ 白底那組跟深色那組是同一條色帶（色相對得起來）', () => {
  STAR_BAR_LIGHT.forEach((c, i) => {
    const d = Math.abs(hue(c) - hue(STAR_BAR_DARK[i]));
    assert.ok(Math.min(d, 360 - d) <= 20,
      `${LABELS[i]} 兩組色相差太多：深 ${STAR_BAR_DARK[i]} / 白 ${c}`);
  });
});

/*
 * ★★★ 規則三:跟背景藍和諧 —— 1 星要停在離卡片藍最近的地方。
 *
 *   這是「和諧」唯一量得出來的部分:整條色帶從離藍色最遠的黃出發,
 *   一路走回紫藍。1 星若比 2 星還遠離背景，那條色帶就沒有終點了。
 */
test('★★ 1 星的紫藍離卡片藍最近 —— 色帶要走得回來', () => {
  const dist = (c: string) => {
    const d = Math.abs(hue(c) - hue(DEEP_BLUE));
    return Math.min(d, 360 - d);
  };
  const ds = STAR_BAR_DARK.map(dist);
  assert.ok(ds[4] === Math.min(...ds),
    `1 星應該離背景藍最近，實際各星距離：`
    + STAR_BAR_DARK.map((c, i) => `${LABELS[i]} ${ds[i].toFixed(0)}°`).join('、'));
  assert.ok(ds[4] < 90, `1 星離背景 ${ds[4].toFixed(0)}°，太遠了不像同一家`);
});

/* ══════════════ 看不看得見 ══════════════ */

/*
 * ★★★ 這是整支最重要的一條。
 *
 *   「越來越暗」跟「看得見」會打架 —— 舊版 1 星 gray-900 就是暗過頭,
 *   在深藍上讀起來像一個洞。所以遞減必須有地板。
 */
test('★★★ 深藍卡:五條對「自己那一列」的軌道都要 ≥ 3:1', () => {
  const bad: string[] = [];
  STAR_BAR_DARK.forEach((bar, i) => {
    const r = contrast(bar, trackAt(i));
    if (r < UI_CONTRAST_MIN) {
      bad.push(`${LABELS[i]} ${bar} 在 ${trackAt(i)} 上只有 ${r.toFixed(2)}:1`);
    }
  });
  assert.deepEqual(bad, [], '這幾條在深藍卡上看不清楚：\n' + bad.join('\n'));
});

test('★★ 白底:五條對軌道都要 ≥ 3:1', () => {
  const bad = STAR_BAR_LIGHT
    .map((bar, i) => ({ bar, i, r: contrast(bar, STAR_TRACK_LIGHT) }))
    .filter((x) => x.r < UI_CONTRAST_MIN)
    .map((x) => `${LABELS[x.i]} ${x.bar} 只有 ${x.r.toFixed(2)}:1`);
  assert.deepEqual(bad, [], '這幾條在白底上看不清楚：\n' + bad.join('\n'));
});

/*
 * ★ 門檻是 3:1 不是 4.5:1。
 *   4.5 是小字的標準（WCAG 1.4.3）；長條走非文字元件的 1.4.11 = 3:1。
 *   釘住它是因為「順手改嚴一點」會逼出過深的顏色,而那會讓卡片變髒 ——
 *   那不是無害的保守。
 */
test('門檻是 3（非文字元件），不是 4.5', () => {
  assert.equal(UI_CONTRAST_MIN, 3);
});

test('五條各不相同 —— 不要有兩條撞色', () => {
  assert.equal(new Set(STAR_BAR_DARK).size, 5);
  assert.equal(new Set(STAR_BAR_LIGHT).size, 5);
});

/*
 * ★ 兩組不能合成一組。
 *   這條在的意義是:哪天有人為了「少一組常數」把兩邊統一，
 *   會立刻在這裡紅，而不是等到有人瞇著眼看表格才發現。
 */
test('★ 兩組不能互換 —— 深底那組印在白底上是看不見的', () => {
  const onWhite = STAR_BAR_DARK.map((c) => contrast(c, STAR_TRACK_LIGHT));
  assert.ok(Math.min(...onWhite) < UI_CONTRAST_MIN,
    '深色卡那組如果在白底也過得了，代表其中一組挑錯了');
});
