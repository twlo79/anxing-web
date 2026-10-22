import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dayKind, nextKind, setDow, quoteStay, quotePlan, partsText, planText, quoteLine, priceWarn, parseBasePrice, DEFAULT_DOW,
} from './base-price.ts';

const A11 = { w: 1300, h: 1750, p: 2100 };
const A04 = { w: 1400, h: 2250, p: 1900 };
const A09 = { w: 1750, h: 2100, p: 2300 };

test('dayKind：時兆 日～四平日、五假日、六旺日（算住哪一晚）', () => {
  assert.equal(dayKind('2026-11-20', DEFAULT_DOW), 'h'); // 五
  assert.equal(dayKind('2026-11-21', DEFAULT_DOW), 'p'); // 六
  assert.equal(dayKind('2026-11-22', DEFAULT_DOW), 'w'); // 日
  assert.equal(dayKind('2026-11-20', 'bad'), 'h');       // 壞的設定用預設
});

test('nextKind / setDow', () => {
  assert.equal(nextKind('w'), 'p'); assert.equal(nextKind('p'), 'h'); assert.equal(nextKind('h'), 'w');
  assert.equal(setDow('wwwwwhp', 5, 'p'), 'wwwwwpp');
});

test('quoteStay：稿上的 A11 11/17～11/24 ＝ 10,350', () => {
  const q = quoteStay('2026-11-17', '2026-11-24', A11, DEFAULT_DOW)!;
  assert.equal(q.total, 10350);
  assert.equal(q.nights, 7);
  assert.equal(partsText(q.parts), '平日×5 $6,500 · 假日×1 $1,750 · 旺日×1 $2,100');
});

test('quoteStay：只有平日的不出現假日／旺日', () => {
  const q = quoteStay('2026-11-16', '2026-11-18', A11, DEFAULT_DOW)!;
  assert.equal(partsText(q.parts), '平日×2 $2,600');
});

test('quoteStay：用到的價沒填 → 不報價；沒用到的沒填 → 照算', () => {
  assert.equal(quoteStay('2026-11-20', '2026-11-21', { w: 1300, h: null, p: 2100 }, DEFAULT_DOW), null);
  assert.equal(quoteStay('2026-11-16', '2026-11-17', { w: 1300, h: null, p: null }, DEFAULT_DOW)!.total, 1300);
  assert.equal(quoteStay('2026-11-16', '2026-11-17', null, DEFAULT_DOW), null);
  assert.equal(quoteStay('2026-11-17', '2026-11-17', A11, DEFAULT_DOW), null);
});

test('quotePlan：稿上的拼房 A09 3 晚 → A04 4 晚 ＝ 12,200', () => {
  const segs = [{ room: 'A09', from: '2026-11-15', to: '2026-11-18' }, { room: 'A04', from: '2026-11-18', to: '2026-11-22' }];
  const r = quotePlan(segs, (n) => (n === 'A09' ? A09 : A04), DEFAULT_DOW)!;
  assert.equal(r.total, 12200);
  assert.deepEqual(r.segs.map((q) => q.total), [5250, 6950]);
  assert.equal(planText(segs, r.segs), 'A09 平日×3 $5,250 → A04 平日×2 $2,800 · 假日×1 $2,250 · 旺日×1 $1,900');
  assert.equal(quotePlan(segs, (n) => (n === 'A09' ? A09 : null), DEFAULT_DOW), null);
});

test('quoteLine', () => {
  assert.equal(quoteLine('時兆', 'A11', '2026-11-17', '2026-11-24', 7, 10350), '時兆 A11　11/17～11/24（7 晚）NT$ 10,350');
});

test('priceWarn：假日比旺日貴才提醒', () => {
  assert.equal(priceWarn(A04), true);
  assert.equal(priceWarn(A11), false);
  assert.equal(priceWarn({ w: 1, h: 3, p: null }), false);
});

test('parseBasePrice', () => {
  assert.deepEqual(parseBasePrice(''), { ok: true, value: null });
  assert.deepEqual(parseBasePrice('1,350'), { ok: true, value: 1350 });
  assert.equal(parseBasePrice('13.5').ok, false);
  assert.equal(parseBasePrice('0').ok, false);
  assert.equal(parseBasePrice('abc').ok, false);
});

test('清潔費（2026-10-22）：一次性、加在總價；David 對過的 A07 Nikolaos 45 晚 ＝ 76,200 ＋ 1,000', () => {
  const A07 = { w: 1500, h: 2050, p: 2400 };
  const q = quoteStay('2026-11-08', '2026-12-23', A07, DEFAULT_DOW, 1000)!;
  assert.equal(q.nights, 45);
  assert.equal(q.total - q.clean, 76200);
  assert.equal(q.total, 77200);
  assert.equal(partsText(q.parts, q.clean), '平日×33 $49,500 · 假日×6 $12,300 · 旺日×6 $14,400 · 清潔費 $1,000');
  assert.equal(quoteStay('2026-11-08', '2026-12-23', A07, DEFAULT_DOW, null)!.clean, 0);
});

test('清潔費：拼房整筆只收一次', () => {
  const segs = [{ room: 'A09', from: '2026-11-15', to: '2026-11-18' }, { room: 'A04', from: '2026-11-18', to: '2026-11-22' }];
  const r = quotePlan(segs, (n) => (n === 'A09' ? A09 : A04), DEFAULT_DOW, 1000)!;
  assert.equal(r.total, 13200);
  assert.equal(planText(segs, r.segs, r.clean), 'A09 平日×3 $5,250 → A04 平日×2 $2,800 · 假日×1 $2,250 · 旺日×1 $1,900 · 清潔費 $1,000');
});
