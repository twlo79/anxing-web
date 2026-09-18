import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_IG_PHOTOS, addPhotos, movePhoto, removePhoto,
  whyCannotAdd, addMessage, stepPhoto, clampIndex, RESET_INDEX,
} from './social-carousel.ts';

const nPhotos = (n: number) => Array.from({ length: n }, (_, i) => `p${i + 1}`);

describe('加照片', () => {
  test('一般情況就是接在後面', () => {
    const r = addPhotos(['a', 'b'], ['c', 'd']);
    assert.deepEqual(r.next, ['a', 'b', 'c', 'd']);
    assert.equal(r.dropped, 0);
  });

  test('★★★ 超過上限：收下能收的，**並且說丟了幾張**', () => {
    /*
     * 整批拒絕的話,選了 12 張結果一張都沒進去;
     * 安靜吃掉的話,他以為 12 張都在,發佈時才發現少兩張。
     */
    const r = addPhotos(nPhotos(8), ['x1', 'x2', 'x3', 'x4']);
    assert.equal(r.next.length, MAX_IG_PHOTOS);
    assert.deepEqual(r.next.slice(8), ['x1', 'x2']);
    assert.equal(r.dropped, 2);
    assert.match(addMessage(r) ?? '', /2 張沒收下/);
  });

  test('已經滿了 → 一張都不收，而且講得出來', () => {
    const r = addPhotos(nPhotos(MAX_IG_PHOTOS), ['x']);
    assert.equal(r.next.length, MAX_IG_PHOTOS);
    assert.equal(r.dropped, 1);
    assert.equal(whyCannotAdd(r.next) !== null, true);
  });

  test('★ 沒滿的時候不要跳訊息', () => {
    assert.equal(addMessage(addPhotos(['a'], ['b'])), null);
    assert.equal(whyCannotAdd(['a']), null);
    assert.equal(whyCannotAdd([]), null);
  });

  test('空值不會爆，而且不會混進空字串', () => {
    assert.deepEqual(addPhotos([], []).next, []);
    assert.deepEqual(addPhotos(['a', ''], ['', 'b']).next, ['a', 'b']);
  });
});

describe('換順序 / 拿掉', () => {
  test('往前往後', () => {
    assert.deepEqual(movePhoto(['a', 'b', 'c'], 1, -1), ['b', 'a', 'c']);
    assert.deepEqual(movePhoto(['a', 'b', 'c'], 1, 1), ['a', 'c', 'b']);
  });

  test('★★ 第一張往前、最後一張往後 → 原樣（不要繞回去）', () => {
    assert.deepEqual(movePhoto(['a', 'b', 'c'], 0, -1), ['a', 'b', 'c']);
    assert.deepEqual(movePhoto(['a', 'b', 'c'], 2, 1), ['a', 'b', 'c']);
  });

  test('★ 動不了的時候內容一樣（畫面可以據此不存檔）', () => {
    assert.deepEqual(movePhoto(['a'], 0, -1), ['a']);
    assert.deepEqual(movePhoto([], 0, 1), []);
    assert.deepEqual(movePhoto(['a', 'b'], 9, 1), ['a', 'b']);
  });

  test('拿掉', () => {
    assert.deepEqual(removePhoto(['a', 'b', 'c'], 1), ['a', 'c']);
    assert.deepEqual(removePhoto(['a'], 0), []);
  });

  test('★★★ 拿掉第一張 → 第二張變封面', () => {
    /*
     * 封面就是第 0 張（九宮格上顯示的那一張）。
     * 拿掉封面之後不遞補的話，九宮格會變空的。
     */
    const after = removePhoto(['cover', 'b', 'c'], 0);
    assert.equal(after[0], 'b');
  });

  test('索引超出範圍 → 原樣，不要少掉一張', () => {
    assert.deepEqual(removePhoto(['a', 'b'], 5), ['a', 'b']);
    assert.deepEqual(removePhoto(['a', 'b'], -1), ['a', 'b']);
  });
});

describe('★★★ 輪播的位置', () => {
  test('到頭就停，不繞回去', () => {
    assert.equal(stepPhoto(0, -1, 3), 0);
    assert.equal(stepPhoto(2, 1, 3), 2);
    assert.equal(stepPhoto(1, 1, 3), 2);
    assert.equal(stepPhoto(1, -1, 3), 0);
  });

  test('★★ 這一點跟「換一則」相反 —— 換一則是循環的', () => {
    /*
     * 輪播繞回去的話，看的人以為自己按到別的東西。IG 本身也是到頭就停。
     * 這一條釘住它，免得哪天有人「順手統一」成循環。
     */
    assert.notEqual(stepPhoto(2, 1, 3), 0);
  });

  test('只有一張時哪邊都不動', () => {
    assert.equal(stepPhoto(0, 1, 1), 0);
    assert.equal(stepPhoto(0, -1, 1), 0);
  });

  test('★★ 換一則之後回到第一張', () => {
    assert.equal(RESET_INDEX, 0);
  });

  test('clampIndex：張數變少時不會停在不存在的那一張', () => {
    /* 拿掉最後一張時，index 還指著它 —— 沒夾的話畫面會是空的 */
    assert.equal(clampIndex(4, 3), 2);
    assert.equal(clampIndex(-1, 3), 0);
    assert.equal(clampIndex(0, 0), 0);
    assert.equal(clampIndex(7, 0), 0);
  });
});
