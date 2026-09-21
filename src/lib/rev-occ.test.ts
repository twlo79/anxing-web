import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  toWan, wanParts, pickedLabel, noSrcFilter, toggleSrc, splitBySrc, cardRows,
  applySrcPicks, bySourceOf, ymDash, monthLabel,
} from './rev-occ.ts';

const KEYS = ['longterm', 'airbnb', 'private', 'office', 'other', 'company'];
const LAB: Record<string, string> = {
  longterm: '長租', airbnb: 'Airbnb', private: '私下',
  office: '辦公室租賃', other: '其他收入', company: '公司登記',
};
const lab = (k: string) => LAB[k] ?? k;

/* ── wanParts ───────────────────────────────────────────── */

test('★★★ 分項換算成萬之後，加起來要等於合計換算成萬', () => {
  /* 各自四捨五入會是 147+24+7+4+3+1 = 186，剛好；
     換一組就不一定 —— 下面這組各自進位後是 19，而合計是 18。 */
  const v = [44_900, 44_900, 44_900, 44_900];          // 合計 179,600 → 18 萬
  const p = wanParts(v);
  assert.equal(p.reduce((a, b) => a + b, 0), toWan(179_600));
  assert.equal(toWan(179_600), 18);
});

test('★★ 差額補在絕對值最大的那一項上，不是第一項', () => {
  const v = [1_000_000, 4_900, 4_900];                 // 100 + 0 + 0 = 100；合計 1,009,800 → 101
  const p = wanParts(v);
  assert.equal(p.reduce((a, b) => a + b, 0), 101);
  assert.equal(p[0], 101);                             // 補在最大的那一項
  assert.deepEqual(p.slice(1), [0, 0]);
});

test('★ 負數（折讓）也要能跑，而且還是加得起來', () => {
  const v = [1_000_000, -44_900, 4_900];
  const p = wanParts(v);
  assert.equal(p.reduce((a, b) => a + b, 0), toWan(1_000_000 - 44_900 + 4_900));
});

test('全部是 0 → 全部是 0，不是 NaN', () => {
  assert.deepEqual(wanParts([0, 0, 0]), [0, 0, 0]);
});

test('空陣列 → 空陣列', () => {
  assert.deepEqual(wanParts([]), []);
});

test('★★ 隨便一百組都要加得起來（這條才是真正在釘的東西）', () => {
  let seed = 42;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let t = 0; t < 100; t++) {
    const v = Array.from({ length: 6 }, () => Math.round(rnd() * 3_000_000));
    const p = wanParts(v);
    assert.equal(p.reduce((a, b) => a + b, 0),
      toWan(v.reduce((a, b) => a + b, 0)), `第 ${t} 組：${v}`);
  }
});

/* ── pickedLabel ────────────────────────────────────────── */

test('★★★ 全部選中 ＝ 沒有篩選 → 寫「全部來源」', () => {
  assert.equal(pickedLabel(['長租', 'Airbnb'], 2), '全部來源');
  assert.equal(pickedLabel([], 6), '全部來源');
});

test('三個以內寫完整，超過就封頂', () => {
  assert.equal(pickedLabel(['長租'], 6), '長租');
  assert.equal(pickedLabel(['長租', 'Airbnb', '私下'], 6), '長租 ＋ Airbnb ＋ 私下');
  assert.equal(pickedLabel(['長租', 'Airbnb', '私下', '辦公室租賃'], 6),
    '長租 ＋ Airbnb 等 4 種');
});

test('★ 有一整行可以寫的地方傳大一點的 max，就不封頂', () => {
  assert.equal(pickedLabel(['長租', 'Airbnb', '私下', '辦公室租賃'], 6, 6),
    '長租 ＋ Airbnb ＋ 私下 ＋ 辦公室租賃');
});

/* ── noSrcFilter / toggleSrc ────────────────────────────── */

test('★★ 一顆都沒亮、全部都亮 —— 兩種都是沒有篩選', () => {
  assert.equal(noSrcFilter([], KEYS), true);
  assert.equal(noSrcFilter(KEYS, KEYS), true);
  assert.equal(noSrcFilter(['airbnb'], KEYS), false);
});

test('★ 點一下加、再點一下拿掉；順序照來源清單不是照點擊順序', () => {
  let p = toggleSrc([], 'airbnb', KEYS);
  assert.deepEqual(p, ['airbnb']);
  p = toggleSrc(p, 'longterm', KEYS);
  assert.deepEqual(p, ['longterm', 'airbnb']);           // 不是 ['airbnb','longterm']
  p = toggleSrc(p, 'airbnb', KEYS);
  assert.deepEqual(p, ['longterm']);
});

/* ── splitBySrc ─────────────────────────────────────────── */

const BY = { longterm: 1_470_000, airbnb: 240_000, private: 70_000,
             office: 40_000, other: 30_000, company: 10_000 };

test('★★★ 長條的總高度永遠是全部來源，選中的只是變深', () => {
  const s = splitBySrc(BY, KEYS, ['longterm']);
  assert.equal(s.total, 1_860_000);
  assert.equal(s.sel, 1_470_000);
  assert.equal(s.rest, 390_000);
  assert.equal(s.sel + s.rest, s.total);
});

test('★★ 沒篩選時 rest 是 0 —— 不要畫一段高度 0 的淡色', () => {
  assert.equal(splitBySrc(BY, KEYS, []).rest, 0);
  assert.equal(splitBySrc(BY, KEYS, KEYS).rest, 0);
  assert.equal(splitBySrc(BY, KEYS, KEYS).sel, 1_860_000);
});

test('★ 選一部分時 sel ＋ rest 必須剛好是 total（小數也是）', () => {
  const by = { a: 0.1, b: 0.2, c: 0.3 };
  const s = splitBySrc(by, ['a', 'b', 'c'], ['b', 'c']);
  assert.equal(s.sel + s.rest, s.total);
  assert.ok(s.rest > 0);
});

/* ★★★ `splitBySrc` 裡的 `Math.max(..., 0)` 我**寫不出能讓它失敗的案例** ——
     sel 與 total 都照同一個 keys 順序加，subset 不會大於全體。
     原本那條「rest 不可以是負的」測試跑突變（把 Math.max 拿掉）**照樣全綠**，
     等於沒有在測任何東西，所以刪掉。
   ★★ 那個夾子留著，因為它守的是**以後的呼叫端**（兩邊用不同順序加的話就會負），
     但不假裝它有被測到 —— 一條永遠綠的測試比沒有測試更糟（CLAUDE.md）。 */

/* ── cardRows ───────────────────────────────────────────── */

test('★★★ 卡片的六列加起來等於合計，小計是那六列裡選中的那幾列', () => {
  const c = cardRows(BY, KEYS, ['longterm', 'airbnb'], lab);
  assert.equal(c.rows.length, 6);
  assert.equal(c.rows.reduce((n, r) => n + r.wan, 0), c.totalWan);
  assert.equal(c.selWan, c.rows.filter((r) => r.on).reduce((n, r) => n + r.wan, 0));
  assert.deepEqual(c.rows.map((r) => r.on), [true, true, false, false, false, false]);
});

test('★★ 沒選中的也要列出來 —— 要看的是「組成」', () => {
  const c = cardRows(BY, KEYS, ['company'], lab);
  assert.equal(c.rows.length, 6);
  assert.equal(c.rows[0].label, '長租');
  assert.ok(c.rows[0].wan > 0);
  assert.equal(c.rows[0].on, false);
});

test('★ 一顆都沒亮 → 六列全部算「選中」，小計等於合計', () => {
  const c = cardRows(BY, KEYS, [], lab);
  assert.ok(c.rows.every((r) => r.on));
  assert.equal(c.selWan, c.totalWan);
  assert.equal(c.selShare, 1);
});

test('★ 合計是 0 → 佔比回 0 不是 NaN', () => {
  const c = cardRows({}, KEYS, ['airbnb'], lab);
  assert.equal(c.totalWan, 0);
  assert.equal(c.selShare, 0);
  assert.ok(c.rows.every((r) => !Number.isNaN(r.share)));
});

/* ── applySrcPicks / bySourceOf ─────────────────────────── */

const ROWS = [
  { source: 'airbnb',   month_amount: 100 },
  { source: 'longterm', month_amount: 200 },
  { source: null,       month_amount: 30 },     // ★ 沒填 → other
  { source: '  ',       month_amount: 7 },      // ★ 只有空白 → 也是 other
];

test('★★★ 一顆都沒亮、全部都亮 —— 兩邊篩出來的要一模一樣', () => {
  const none = applySrcPicks(ROWS, [], ['airbnb', 'longterm', 'other']);
  const all  = applySrcPicks(ROWS, ['airbnb', 'longterm', 'other'], ['airbnb', 'longterm', 'other']);
  assert.equal(none.length, ROWS.length);
  assert.deepEqual(all, none);
});

test('選兩個 → 只留那兩個', () => {
  const r = applySrcPicks(ROWS, ['airbnb', 'other'], ['airbnb', 'longterm', 'other']);
  assert.equal(r.length, 3);                    // airbnb 1 筆 ＋ other 2 筆
});

test('★ 沒填 source 與只有空白都當 other —— 跟膠囊那邊同一套', () => {
  const by = bySourceOf(ROWS, (r) => r.month_amount);
  assert.equal(by.other, 37);
  assert.equal(by.airbnb, 100);
  assert.equal(by.longterm, 200);
});

test('★ 各來源加起來等於全部', () => {
  const by = bySourceOf(ROWS, (r) => r.month_amount);
  assert.equal(Object.values(by).reduce((a, b) => a + b, 0),
    ROWS.reduce((n, r) => n + r.month_amount, 0));
});

/* ── ymDash / monthLabel ────────────────────────────────── */

test('★★★ 兩種月份形狀都要吃 —— 拿錯一種，十二格營收全部變 0 而且不會叫', () => {
  assert.equal(ymDash('202510'), '2025-10');      // revenue_recognitions.ym
  assert.equal(ymDash('2025-10'), '2025-10');     // monthsBetween / 住房率
  assert.equal(ymDash('2025-10-01'), '2025-10');  // 日期也收得起來
});

test('★★ 用 ymDash 對起來的 map，兩種形狀查得到同一格', () => {
  const m: Record<string, number> = {};
  m[ymDash('202510')] = 999;
  assert.equal(m[ymDash('2025-10')], 999);
});

test('★★ 月份標籤：餵 YYYY-MM 進舊的 ymMonth() 會變成 "-1"，這支不會', () => {
  assert.equal(monthLabel('2025-10'), '10月');
  assert.equal(monthLabel('202510'), '10月');
  assert.equal(monthLabel('2026-01'), '01月');
});

test('★ 壞掉的值不要爆', () => {
  assert.equal(ymDash(''), '');
  assert.equal(ymDash(null), '');
  assert.equal(monthLabel(undefined), '');
});
