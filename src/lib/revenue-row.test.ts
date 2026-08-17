import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  roomCell, rangeText, periodCell, amountCell, nightsText, nightlyRate, isSplit, fmtMoney,
  dayBefore, type RevRow,
} from './revenue-row.ts';

const r = (o: Partial<RevRow> = {}): RevRow => ({
  source: 'airbnb', estate_name: '時兆', property_raw: 'B5', guest_name: '李瑪琍',
  checkin: '2026-07-25', checkout: '2026-07-29',
  period_start: '2026-07-25', period_end: '2026-07-28',
  total_amount: 6000, total_nights: 4, month_nights: 4, month_amount: 6000,
  ...o,
});

// ── 房源欄 ────────────────────────────────────────

test('房源在上、物業在下', () => {
  assert.deepEqual(roomCell(r()), { main: 'B5', sub: '時兆' });
});

test('辦公室出租不顯示房源，物業提上來當主要那行', () => {
  // 資料上 property_raw 是有值的（契約帶的房號），刻意不顯示
  assert.deepEqual(
    roomCell(r({ source: 'office', property_raw: '2F-28', estate_name: '正隆' })),
    { main: '正隆', sub: '' });
});

test('公司登記同樣不顯示房源', () => {
  assert.deepEqual(
    roomCell(r({ source: 'company', property_raw: '2F-28', estate_name: '正隆' })),
    { main: '正隆', sub: '' });
});

test('房源與物業都沒有時是破折號，不是空字串', () => {
  // 空字串會讓那一格看起來像壞掉，破折號是「確實沒有」
  assert.deepEqual(roomCell(r({ property_raw: null, estate_name: null })), { main: '—', sub: '' });
});

test('房源留白（只有空格）視同沒有', () => {
  assert.deepEqual(roomCell(r({ property_raw: '   ' })), { main: '時兆', sub: '' });
});

// ── 區間 ──────────────────────────────────────────

test('同一天只寫一次', () => {
  assert.equal(rangeText('2026-07-31', '2026-07-31'), '2026-07-31');
});

test('同一年的結束段省略年份', () => {
  assert.equal(rangeText('2026-07-26', '2026-08-01'), '2026-07-26~08-01');
});

test('跨年兩邊都寫全 —— 不然看不出是隔年', () => {
  assert.equal(rangeText('2026-12-28', '2027-01-03'), '2026-12-28~2027-01-03');
});

test('兩邊都沒有回破折號', () => {
  assert.equal(rangeText(null, null), '—');
});

test('只有一邊就印那一邊', () => {
  assert.equal(rangeText('2026-07-26', null), '2026-07-26');
  assert.equal(rangeText(null, '2026-08-01'), '2026-08-01');
});

test('帶時間的字串會被切掉', () => {
  assert.equal(rangeText('2026-07-26T00:00:00Z', '2026-07-26T00:00:00Z'), '2026-07-26');
});

// ── 期間欄 ────────────────────────────────────────

test('沒跨月時只留一行 —— 重複印會稀釋掉真正跨月的那幾筆', () => {
  // period_end 跟 checkout 相同（都是排他的退房日）＝ 認列涵蓋整張訂單
  const x = periodCell(r({
    checkin: '2026-07-25', checkout: '2026-07-29',
    period_start: '2026-07-25', period_end: '2026-07-29',
  }));
  assert.equal(x.main, '2026-07-25~07-28');   // 認列印到最後一晚
  assert.equal(x.sub, '');
});

test('★ 比日期不比字串 —— 兩行的慣例差一天，比字串會讓每一列都印兩行', () => {
  // 認列印「最後一晚」7/28、訂單印「退房日」7/29，文字永遠不相等
  const x = periodCell(r({
    checkin: '2026-07-25', checkout: '2026-07-29',
    period_start: '2026-07-25', period_end: '2026-07-29',
  }));
  assert.notEqual(x.main, rangeText('2026-07-25', '2026-07-29'));
  assert.equal(x.sub, '');
});

test('跨月時第二行是訂單起訖', () => {
  const x = periodCell(r({
    checkin: '2026-07-26', checkout: '2026-09-22',
    period_start: '2026-07-26', period_end: '2026-08-01',
  }));
  assert.equal(x.main, '2026-07-26~07-31');
  assert.equal(x.sub, '2026-07-26~09-22');
});

// ── 排他的結束邊界 ────────────────────────────────

test('period_end 是排他的，顯示要減一天', () => {
  // 資料庫存 least(checkout, 下個月1號)。7 月整月存成 08-01，但 8/1 不屬於 7 月
  assert.equal(dayBefore('2026-08-01'), '2026-07-31');
});

test('跨月邊界減一天要跨回上個月', () => {
  assert.equal(dayBefore('2026-01-01'), '2025-12-31');
  assert.equal(dayBefore('2026-03-01'), '2026-02-28');
});

test('閏年的 3/1 前一天是 2/29', () => {
  assert.equal(dayBefore('2028-03-01'), '2028-02-29');
});

test('空值與壞格式回空字串，不回 Invalid Date', () => {
  assert.equal(dayBefore(null), '');
  assert.equal(dayBefore(''), '');
  assert.equal(dayBefore('2026-8-1'), '');
});

test('★ 整月認列顯示成 07-01~07-31，不是 07-01~08-01', () => {
  // 這是併欄時漏掉的那一條 —— 直接印會看起來像認列了 32 天
  const x = periodCell(r({
    checkin: '2026-07-01', checkout: '2026-08-01',
    period_start: '2026-07-01', period_end: '2026-08-01',
    total_nights: 31, month_nights: 31,
  }));
  assert.equal(x.main, '2026-07-01~07-31');
});

test('非整月：7/16 起租的第一期是 07-16~07-31', () => {
  const x = periodCell(r({
    source: 'longterm',
    checkin: '2026-07-16', checkout: '2026-08-01',
    period_start: '2026-07-16', period_end: '2026-08-01',
    total_nights: 16, month_nights: 16,
  }));
  assert.equal(x.main, '2026-07-16~07-31');
});

test('長租第二行用傳進來的契約期間，不是月租單起訖', () => {
  // 月租單的 checkin~checkout 就是那個月，印出來跟認列期間幾乎一樣＝什麼都沒說
  const x = periodCell(r({
    source: 'longterm',
    checkin: '2026-07-01', checkout: '2026-08-01',
    period_start: '2026-07-01', period_end: '2026-07-31',
  }), '2025-09-01~2027-08-31');
  assert.equal(x.sub, '2025-09-01~2027-08-31');
});

test('查不到契約（空字串）就走一般規則，不猜一份無關的契約', () => {
  const x = periodCell(r({
    checkin: '2026-07-16', checkout: '2026-09-01',
    period_start: '2026-07-16', period_end: '2026-08-01',
  }), '');
  assert.equal(x.main, '2026-07-16~07-31');
  assert.equal(x.sub, '2026-07-16~09-01');
});

test('舊資料沒有認列起訖時退回訂單起訖，不是空白', () => {
  const x = periodCell(r({ period_start: null, period_end: null }));
  assert.equal(x.main, '2026-07-25~07-29');   // 沒有 period_end 就退回 checkout，不減一天
  assert.equal(x.sub, '');   // 退回之後兩段一樣，不重複印
});

// ── 金額欄 ────────────────────────────────────────

test('金額相同時不重複印', () => {
  assert.deepEqual(amountCell(r({ month_amount: 6000, total_amount: 6000 })),
    { main: '$6,000', sub: '' });
});

test('跨月時第二行是訂單總額', () => {
  assert.deepEqual(amountCell(r({ month_amount: 5682, total_amount: 17048 })),
    { main: '$5,682', sub: '$17,048' });
});

test('金額四捨五入 —— 小數是分攤除不盡來的，不是真的有零頭', () => {
  assert.equal(fmtMoney(5681.6667), '$5,682');
  assert.equal(fmtMoney(null), '$0');
});

// ── 天數與均價 ────────────────────────────────────

test('天數是分子/分母', () => {
  assert.equal(nightsText(r({ month_nights: 6, total_nights: 58 })), '6/58');
});

test('一次性收入沒有晚數，不印 0/0', () => {
  assert.equal(nightsText(r({ month_nights: 0, total_nights: 0 })), '—');
});

test('均價用認列天數算，不是總天數', () => {
  // 拿總額除總天數會得到「整筆訂單的均價」，那在跨月的列上跟這一列無關
  assert.equal(nightlyRate(r({ month_amount: 5682, month_nights: 1, total_nights: 3 })), 5682);
});

test('沒有天數時均價是 null，不是 0', () => {
  // 0 的意思是「每晚 0 元」，null 是「算不出來」
  assert.equal(nightlyRate(r({ month_nights: 0, total_nights: 0 })), null);
});

// ── 跨月判斷 ──────────────────────────────────────

test('用天數判斷跨月，不用日期', () => {
  // 日期相同但天數不同代表認列被手動改過 —— 那正是最需要解釋的一種
  assert.equal(isSplit(r({ month_nights: 4, total_nights: 4 })), false);
  assert.equal(isSplit(r({ month_nights: 1, total_nights: 3 })), true);
});

test('沒有天數的（一次性收入）不算跨月', () => {
  assert.equal(isSplit(r({ month_nights: 0, total_nights: 0 })), false);
});
