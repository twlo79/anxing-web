import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRoomsPrefs, serializeRoomsPrefs, shiftYm, type RoomsPrefs } from './rooms-prefs.ts';
import { airbnbUrl, airbnbLinks } from './airbnb-link.ts';

const V = ['any', 'short', 'free', 'dup'];
const P: RoomsPrefs = {
  estF: '正隆', mode: 'month', ym: '2026-11', from: '2026-10-01', to: '2026-10-31', kw: '王',
  view: 'short', showDup: true, showEnd: false, showOut: true, ewin: 45, owin: 7,
};

test('存進去讀得回來', () => {
  assert.deepEqual(parseRoomsPrefs(serializeRoomsPrefs(P), V), P);
});

test('沒有、壞掉 → null', () => {
  assert.equal(parseRoomsPrefs(null, V), null);
  assert.equal(parseRoomsPrefs('', V), null);
  assert.equal(parseRoomsPrefs('{oops', V), null);
  assert.equal(parseRoomsPrefs('[1,2]', V), null);
  assert.equal(parseRoomsPrefs('"x"', V), null);
});

test('壞掉的那一欄丟掉、其餘照用', () => {
  const r = parseRoomsPrefs(JSON.stringify({ ...P, ym: '2026-13', mode: 'week', view: 'nope', showDup: 'yes', ewin: 'x' }), V)!;
  assert.equal(r.ym, undefined);
  assert.equal(r.mode, undefined);
  assert.equal(r.view, undefined);
  assert.equal(r.showDup, undefined);
  assert.equal(r.ewin, undefined);
  assert.equal(r.estF, '正隆');
  assert.equal(r.kw, '王');
});

test('空字串的物業／藥丸是合法的（＝全部／沒選）', () => {
  const r = parseRoomsPrefs(JSON.stringify({ estF: '', view: '' }), V)!;
  assert.equal(r.estF, '');
  assert.equal(r.view, '');
});

test('shiftYm 跨年', () => {
  assert.equal(shiftYm('2026-10', 1), '2026-11');
  assert.equal(shiftYm('2026-12', 1), '2027-01');
  assert.equal(shiftYm('2026-01', -1), '2025-12');
  assert.equal(shiftYm('2026-03', -14), '2025-01');
});

test('airbnbUrl：只吃數字編號', () => {
  assert.equal(airbnbUrl('39687807'), 'https://www.airbnb.com/rooms/39687807');
  assert.equal(airbnbUrl(39687807), 'https://www.airbnb.com/rooms/39687807');
  assert.equal(airbnbUrl(' 123 '), 'https://www.airbnb.com/rooms/123');
  assert.equal(airbnbUrl(null), null);
  assert.equal(airbnbUrl(''), null);
  assert.equal(airbnbUrl('abc'), null);
});

test('airbnbLinks：主編號優先、其次 is_current', () => {
  const m = airbnbLinks(
    [{ id: 'a', airbnb_listing_id: '111' }, { id: 'b', airbnb_listing_id: null }, { id: 'c' }],
    [
      { listing_id: '999', property_id: 'a', is_current: true },
      { listing_id: '222', property_id: 'b', is_current: false },
      { listing_id: '333', property_id: 'b', is_current: true },
      { listing_id: 'bad', property_id: 'c' },
    ]);
  assert.deepEqual(m, {
    a: 'https://www.airbnb.com/rooms/111',
    b: 'https://www.airbnb.com/rooms/333',
  });
});
