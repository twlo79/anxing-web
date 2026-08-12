import test from 'node:test';
import assert from 'node:assert/strict';
import {
  money, stayRange, stars, orderLine, reviewLine, importBody, importTitle, MAX_LINES,
} from './notify-text.ts';

const TODAY = new Date('2026-08-12T00:00:00Z');

/* ── 金額 ────────────────────────────────────── */

test('千分位', () => {
  assert.equal(money(20000), '$20,000');
  assert.equal(money(3800), '$3,800');
  assert.equal(money(1234567), '$1,234,567');
  assert.equal(money(800), '$800');
});

test('★ 不用 toLocaleString —— 伺服器 locale 不同會吐出 20 000 或 20.000', () => {
  // 這個測試的意義在於:如果有人「順手」改成 toLocaleString,
  // 在他的機器上會通過,在 Vultr 上可能不會 —— 所以釘住確切輸出
  assert.equal(money(20000), '$20,000');
  assert.notEqual(money(20000), '$20 000');
});

test('小數四捨五入,不留分', () => {
  assert.equal(money(3800.4), '$3,800');
  assert.equal(money(3800.6), '$3,801');
});

test('null 與負數', () => {
  assert.equal(money(null), '$0');
  assert.equal(money(-500), '-$500');
});

/* ── 住宿期間 ────────────────────────────────── */

test('今年的日期不寫年份', () => {
  assert.equal(stayRange('2026-07-01', '2026-07-05', TODAY), '7/1–7/5');
});

test('月日不補零 —— 07/01 比 7/1 多兩個字,而通知的每個字都在搶位置', () => {
  assert.equal(stayRange('2026-07-01', '2026-07-05', TODAY), '7/1–7/5');
});

test('★ 跨年一定要標年份', () => {
  // 不標的話 12/28–1/2 看起來像退房日早於入住日
  assert.equal(stayRange('2025-12-28', '2026-01-02', TODAY), '2025/12/28–1/2');
});

test('★ 同一個非今年的年份只標一次', () => {
  // 「2027/7/1–2027/7/5」把年份講兩遍,多出來的五個字會擠掉後面的欄位
  assert.equal(stayRange('2027-07-01', '2027-07-05', TODAY), '2027/7/1–7/5');
});

test('只有一個日期時不硬湊區間', () => {
  assert.equal(stayRange('2026-07-01', null, TODAY), '7/1');
  assert.equal(stayRange(null, null, TODAY), '');
});

/* ── 星等 ────────────────────────────────────── */

test('整數星等不補小數', () => {
  assert.equal(stars(5), '★5');
  assert.equal(stars(3), '★3');
  assert.equal(stars(4.5), '★4.5');
});

test('沒有星等時不顯示 ★0 —— 那看起來像 0 星負評', () => {
  assert.equal(stars(null), '★－');
  assert.equal(stars(0), '★－');
});

/* ── 整行 ────────────────────────────────────── */

const O = {
  amount: 20000, property: 'A15', guest: 'Kevin',
  checkin: '2026-07-01', checkout: '2026-07-05',
};

test('★ 訂單以金額開頭 —— 手機只保證看得到每行的開頭', () => {
  // 異常幾乎都是金額異常(少打一個 0、算錯天數)。
  // 金額擺第一個,那一行就算被切掉也還是有用的
  assert.equal(orderLine(O, TODAY), '$20,000 · A15 · Kevin · 7/1–7/5');
});

test('★ 評價以星等開頭', () => {
  // 5 星不用處理,3 星要 —— 星等決定要不要開這則通知
  assert.equal(reviewLine({ rating: 3, property: 'A15', guest: 'Kevin' }), '★3 · A15 · Kevin');
});

test('★ 分隔符是 · 不是 - —— 房源名稱本身含 -', () => {
  // 「舊-A15 - Kevin」讀的人分不出哪個是分隔、哪個是名字的一部分
  const s = orderLine({ ...O, property: '舊-A15' }, TODAY);
  assert.match(s, /· 舊-A15 ·/);
});

test('★ 缺房源時不留空洞', () => {
  // 「$3,800 ·  · Kevin」看起來像程式壞了,實際上只是還沒對到房源
  const s = orderLine({ ...O, property: null }, TODAY);
  assert.equal(s, '$20,000 · Kevin · 7/1–7/5');
  assert.ok(!s.includes('·  ·'));
});

test('房客姓名是空的也不會壞', () => {
  assert.equal(orderLine({ ...O, guest: null }, TODAY), '$20,000 · A15 · 7/1–7/5');
});

/* ── 收成內文 ────────────────────────────────── */

test('沒超過上限就全部列出', () => {
  assert.equal(importBody(['a', 'b', 'c']), 'a\nb\nc');
});

test('剛好等於上限不加尾巴', () => {
  const lines = Array.from({ length: MAX_LINES }, (_, i) => String(i));
  assert.ok(!importBody(lines).includes('還有'));
});

test('★ 超過就自己收尾,不要讓手機無聲切掉', () => {
  // 手機會截,但截在哪裡看不出來、也沒有提示 ——
  // 讀的人會以為那就是全部
  const lines = Array.from({ length: 12 }, (_, i) => `line${i}`);
  const body = importBody(lines);
  assert.equal(body.split('\n').length, MAX_LINES + 1);
  assert.match(body, /還有 8 筆/);
  assert.ok(body.startsWith('line0'));
});

test('上限是使用者定的 4', () => {
  assert.equal(MAX_LINES, 4);
});

test('標題帶筆數', () => {
  assert.equal(importTitle(3, '筆', '訂單'), '新增 3 筆訂單');
  assert.equal(importTitle(2, '則', '評價'), '新增 2 則評價');
});

test('★ 通知裡不出現「爬蟲」', () => {
  // 使用者要看的是發生了什麼事,不是我們怎麼拿到的
  const t = importTitle(3, '筆', '訂單');
  const b = importBody([orderLine(O, TODAY)]);
  assert.ok(!(t + b).includes('爬蟲'));
});
