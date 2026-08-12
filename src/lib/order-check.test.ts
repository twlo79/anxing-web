import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkDates, checkPrice, lookbackFrom,
  LOW_PRICE_RATIO, MIN_SAMPLE, type PastOrder,
} from './order-check.ts';

/* ── 日期 ────────────────────────────────────── */

test('正常的住宿訂單通過', () => {
  assert.equal(checkDates('private', '2026-08-01', '2026-08-03'), null);
});

test('★ 迄日早於起日要擋下來', () => {
  // 不擋的話 nights 會被 Math.max(0,…) 算成 0,訂單照樣存進去 ——
  // 營收攤提、入住天數、佔用率全錯,而且畫面上看不出異常
  const e = checkDates('private', '2026-08-10', '2026-08-01');
  assert.ok(e);
  assert.match(e!, /填反/);
});

test('★ 同一天（0 晚）要擋,並指出正確做法', () => {
  const e = checkDates('private', '2026-08-01', '2026-08-01');
  assert.ok(e);
  assert.match(e!, /一次性收入/, '要告訴他該怎麼做,不是只說不行');
});

test('★ 一次性收入只有一個日期欄位,不能要求迄日', () => {
  // 畫面上根本沒有迄日欄位。要求他填一個看不到的欄位,他只會卡住
  assert.equal(checkDates('oneoff', '2026-08-01', ''), null);
  assert.equal(checkDates('oneoff', '2026-08-01', '2026-08-01'), null);
});

test('沒填日期時講哪一個沒填', () => {
  assert.match(checkDates('private', '', '2026-08-03')!, /起日/);
  assert.match(checkDates('private', '2026-08-01', '')!, /迄日/);
});

/* ── 均價 ────────────────────────────────────── */

const p = (nights: number, amount: number): PastOrder =>
  ({ checkin: '2026-01-01', nights, amount });

test('★ 資料太少不提醒 —— 那不是異常,是資料不夠', () => {
  // 一兩筆算出來的「均價」只是那一兩筆本身,拿它當基準只會製造假警報
  const r = checkPrice(1000, 1, [p(1, 5000), p(1, 5000)]);
  assert.equal(r.low, false);
  assert.equal(r.avg, null);
  assert.match(r.message, /2 筆/, '要說明為什麼沒有比,不是靜靜跳過');
});

test('完全沒有歷史資料時不顯示任何訊息', () => {
  assert.equal(checkPrice(1000, 1, []).message, '');
});

test('★ 明顯偏低要提醒', () => {
  const past = [p(1, 3000), p(1, 3000), p(1, 3000)];
  const r = checkPrice(300, 1, past);           // 少打一個 0
  assert.equal(r.low, true);
  assert.equal(r.avg, 3000);
  assert.equal(r.nightly, 300);
  assert.match(r.message, /3,000/);
});

test('★ 正常折扣不提醒 —— 提醒的價值來自它很少出現', () => {
  // 門檻放太寬的話,平常議價讓一點就會跳,幾次之後就沒人看了 ——
  // 那時真正該攔的那筆（少打一個 0）也會被一起忽略
  const past = [p(1, 3000), p(1, 3000), p(1, 3000)];
  assert.equal(checkPrice(2700, 1, past).low, false, '9 成不該跳');
  assert.equal(checkPrice(2000, 1, past).low, false, '6.7 成不該跳（長住優惠）');
  assert.equal(checkPrice(1600, 1, past).low, false, '5.3 成不該跳');
  assert.equal(checkPrice(1400, 1, past).low, true, '低於 5 成才跳');
  assert.equal(checkPrice(300, 1, past).low, true, '少打一個 0 一定要跳');
});

test('★ 比的是每晚單價,不是總額', () => {
  // 比總額的話,住三晚的訂單每一筆都會跳 —— 而那是最常見的情況
  const past = [p(1, 3000), p(1, 3000), p(1, 3000)];
  const r = checkPrice(9000, 3, past);
  assert.equal(r.nightly, 3000);
  assert.equal(r.low, false);
});

test('★ 均價用總額÷總晚數,不是每筆單價再平均', () => {
  // 每筆再平均的話,一筆一晚跟一筆三十晚一樣重,
  // 而三十晚那筆通常是長住優惠價,會把均價整個拉歪
  const past = [p(30, 30000), p(1, 5000), p(1, 5000)];  // 總額 40000 / 32 晚 = 1250
  const r = checkPrice(1000, 1, past);
  assert.equal(r.avg, 1250);
  assert.notEqual(r.avg, 3000, '每筆平均會得到 (1000+5000+5000)/3');
});

test('★ 0 晚的一次性收入不能混進均價', () => {
  // 混進來會把均價拉低,而拉低的均價會讓真正該提醒的那筆通過
  const past = [p(1, 3000), p(1, 3000), p(1, 3000), p(0, 500), p(0, 500)];
  const r = checkPrice(500, 1, past);
  assert.equal(r.avg, 3000, '0 晚那兩筆混進來會把均價拉低');
  assert.equal(r.sample, 3);
  assert.equal(r.low, true);
});

test('金額或晚數是 0 時不比', () => {
  const past = [p(1, 3000), p(1, 3000), p(1, 3000)];
  assert.equal(checkPrice(0, 1, past).low, false);
  assert.equal(checkPrice(1000, 0, past).low, false);
});

test('負數金額（折讓）不比', () => {
  const past = [p(1, 3000), p(1, 3000), p(1, 3000)];
  assert.equal(checkPrice(-500, 1, past).low, false);
});

test('門檻與樣本數是使用者定的那組', () => {
  assert.equal(LOW_PRICE_RATIO, 0.5);
  assert.equal(MIN_SAMPLE, 3);
});

test('取樣起日是一年前', () => {
  assert.equal(lookbackFrom(new Date('2026-08-12T12:00:00Z')), '2025-08-12');
});
