import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { deleteMatches, whyDeleteBlocked, DELETE_READY } from './confirm-delete.ts';

const T = '愛皮-115年7-8月 401';

describe('★★★ 打字確認', () => {
  test('一個字不差才算對', () => {
    assert.equal(deleteMatches(T, T), true);
  });

  test('前後空白不算（複製貼上常常多一個）', () => {
    assert.equal(deleteMatches('  ' + T + '  ', T), true);
    assert.equal(deleteMatches(T, '  ' + T), true);
  });

  test('★★ 中間的空白、少一個字、多一個字 —— 都不算對', () => {
    assert.equal(deleteMatches('愛皮-115年7-8月401', T), false);      // 少中間那個空白
    assert.equal(deleteMatches('愛皮-115年7-8月 40', T), false);      // 少一個字
    assert.equal(deleteMatches('愛皮-115年7-8月 4011', T), false);    // 多一個字
    assert.equal(deleteMatches('愛皮115年7-8月 401', T), false);      // 少一個橫線
  });

  test('★★★ 目標是空的 → 一律不給刪', () => {
    /*
     * 空 === 空 會回 true —— 那樣沒打任何字就按得下去，
     * 而「標題是空的」那幾筆正是最該小心的（看不出是哪一筆）。
     */
    assert.equal(deleteMatches('', ''), false);
    assert.equal(deleteMatches('', null), false);
    assert.equal(deleteMatches('隨便', '   '), false);
    assert.equal(deleteMatches(null, undefined), false);
  });

  test('沒打字就是沒打字', () => {
    assert.equal(deleteMatches('', T), false);
    assert.equal(deleteMatches('   ', T), false);
    assert.equal(deleteMatches(null, T), false);
  });
});

describe('★★ 灰掉要說得出為什麼', () => {
  test('沒打字 / 打錯 / 打對', () => {
    assert.equal(whyDeleteBlocked('', T), '打對了才按得下去');
    assert.equal(whyDeleteBlocked('亂打', T), '跟上面那一行不一樣');
    assert.equal(whyDeleteBlocked(T, T), null);
  });

  test('★★★ 「按得下去」與「算對」永遠一致', () => {
    /*
     * 兩支各寫一次規則的話，遲早會出現
     * 「按鈕亮了但按下去說不對」或反過來 —— 這一條把它們釘在一起。
     */
    for (const s of ['', '  ', '亂打', T, ' ' + T + ' ', '愛皮-115年7-8月401']) {
      assert.equal(whyDeleteBlocked(s, T) === null, deleteMatches(s, T), s);
    }
  });

  test('標題是空的 → 講出來要先去填標題', () => {
    assert.match(whyDeleteBlocked('', '') ?? '', /沒有標題/);
    assert.match(whyDeleteBlocked('隨便', null) ?? '', /沒有標題/);
  });

  test('打對之後底下那句話', () => {
    assert.equal(DELETE_READY, '按下去就真的不見了');
  });
});
