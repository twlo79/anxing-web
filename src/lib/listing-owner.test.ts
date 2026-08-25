import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { findListingOwner, listingOwnerHint } from './listing-owner.ts';

const P = (id: string, name: string, lid: string | null, active = true) =>
  ({ id, name, airbnb_listing_id: lid, active });
const L = (listing_id: string, property_id: string, is_current = false) =>
  ({ listing_id, property_id, is_current });

describe('findListingOwner', () => {
  test('★★ 39687807 的真實情況 —— 掛在停用房源上', () => {
    // 畫面說「沒有任何對照」,實際上 properties.airbnb_listing_id 就有,
    // 只是那間房停用了。使用者為了這句不精確的訊息跑了三輪查詢
    const props = [P('p1', '舊-未知(7807)', '39687807', false), P('p2', 'B08', '111', true)];
    const o = findListingOwner('39687807', props, []);
    assert.deepEqual(o, { name: '舊-未知(7807)', active: false, via: '主編號' });
  });

  test('★ 舊編號對照表也要找', () => {
    const props = [P('p1', 'B08', '999', true)];
    const o = findListingOwner('39687807', props, [L('39687807', 'p1')]);
    assert.deepEqual(o, { name: 'B08', active: true, via: '舊編號' });
  });

  test('★ 主編號優先於舊編號', () => {
    const props = [P('p1', '主', '39687807', true), P('p2', '舊', '000', true)];
    const o = findListingOwner('39687807', props, [L('39687807', 'p2')]);
    assert.equal(o?.via, '主編號');
    assert.equal(o?.name, '主');
  });

  test('真的沒有 → null', () => {
    assert.equal(findListingOwner('39687807', [P('p1', 'B08', '111')], []), null);
  });

  test('★ 舊編號指向不存在的房源 —— 當成沒有,不要回半個結果', () => {
    // 房源被硬刪掉的話 link 還在。回一個 name 是 undefined 的物件
    // 會讓畫面印出「掛在 undefined 上」
    assert.equal(findListingOwner('39687807', [], [L('39687807', '不存在')]), null);
  });

  test('空值', () => {
    assert.equal(findListingOwner(null, [], []), null);
    assert.equal(findListingOwner('', [], []), null);
  });
});

describe('listingOwnerHint', () => {
  test('★★ 停用房源 —— 要說出房名,而且說「已停用」', () => {
    const h = listingOwnerHint({ name: '舊-未知(7807)', active: false, via: '主編號' }, '39687807');
    assert.match(h, /舊-未知\(7807\)/, '要說出是哪一間房');
    assert.match(h, /停用/);
    assert.ok(!h.includes('沒有任何'), '不能再說「沒有任何對照」—— 那是假的');
  });

  test('★★ 真的沒對照 —— 才可以叫人回 Airbnb 後台查', () => {
    const h = listingOwnerHint(null, '39687807');
    assert.match(h, /Airbnb 後台/);
    assert.match(h, /39687807/, '要把編號印出來,他要拿去查');
  });

  test('★ 對到啟用房源 —— 要說「原因不在對照表」', () => {
    const h = listingOwnerHint({ name: 'B08', active: true, via: '主編號' }, '39687807');
    assert.match(h, /B08/);
    assert.ok(!h.includes('停用'));
    assert.match(h, /別的方向|不在對照表/);
  });

  test('★ 三種講法互不相同 —— 混成一句的話會害人做錯事', () => {
    const a = listingOwnerHint({ name: 'X', active: false, via: '主編號' }, '1');
    const b = listingOwnerHint({ name: 'X', active: true, via: '主編號' }, '1');
    const c = listingOwnerHint(null, '1');
    assert.equal(new Set([a, b, c]).size, 3);
  });
});

test('★★ active 是 null / undefined 當成啟用中', () => {
  // 資料庫是 boolean not null default true。轉錯方向不會報錯,
  // 只會讓畫面說反話 —— 停用的說成啟用中,或反過來
  const a = findListingOwner('1', [P('p1', 'X', '1', null as any)], []);
  assert.equal(a?.active, true);
  const b = findListingOwner('1', [{ id: 'p1', name: 'X', airbnb_listing_id: '1' } as any], []);
  assert.equal(b?.active, true);
  const c = findListingOwner('1', [P('p1', 'X', '1', false)], []);
  assert.equal(c?.active, false, '明確是 false 才算停用');
});
