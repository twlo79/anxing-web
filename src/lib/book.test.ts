import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  BOOKS, OTHER_BOOKS, DEFAULT_BOOK, BOOK_LABEL, toBook, isOtherBook, bookLabel,
  OTHER_BIZ_SOURCE, OTHER_BIZ_PURPOSE,
  incomeFieldsHidden, incomePartyLabel,
  checkIncomeBook, misbookedItems, allowedPurposes, withBook,
} from './book.ts';

/**
 * 這裡判斷錯的後果是**兩家公司的錢混進安幸的數字裡** ——
 * 而金額看起來完全正常，只有年底對帳時對不起來。
 */

describe('帳本清單', () => {
  test('★ 三本，沒有多也沒有少', () => {
    // 多一本沒發現的話，等於悄悄多了一個沒有人在看的帳
    assert.deepEqual([...BOOKS], ['anxing', 'aipi', 'hongsha']);
  });

  test('★ 其他收支帳不含安幸', () => {
    assert.deepEqual([...OTHER_BOOKS], ['aipi', 'hongsha']);
    assert.equal((OTHER_BOOKS as readonly string[]).includes('anxing'), false);
  });

  test('預設是安幸', () => {
    assert.equal(DEFAULT_BOOK, 'anxing');
  });

  test('每一本都有中文名', () => {
    for (const b of BOOKS) assert.ok(BOOK_LABEL[b].length > 0, b);
  });
});

describe('值怪掉的時候', () => {
  test('★★ 不認得的一律當安幸，不要讓那筆錢消失', () => {
    /*
     * 回 null 或丟錯的話，那一列會從所有報表上不見 ——
     * 而「少一筆」比「歸錯帳」更難發現:報表上沒有任何跡象。
     */
    assert.equal(toBook(null), 'anxing');
    assert.equal(toBook(undefined), 'anxing');
    assert.equal(toBook(''), 'anxing');
    assert.equal(toBook('AIPI'), 'anxing');       // 大小寫不寬容
    assert.equal(toBook('不存在的'), 'anxing');
  });

  test('認得的照原樣', () => {
    assert.equal(toBook('aipi'), 'aipi');
    assert.equal(toBook('hongsha'), 'hongsha');
  });

  test('isOtherBook / bookLabel', () => {
    assert.equal(isOtherBook('aipi'), true);
    assert.equal(isOtherBook('anxing'), false);
    assert.equal(isOtherBook(null), false);
    assert.equal(bookLabel('hongsha'), '洪鯊');
    assert.equal(bookLabel(null), '安幸');
  });
});

describe('收入表單', () => {
  test('★★ 選了其他事業體要藏押金 —— 這條最重要', () => {
    /*
     * 留著的話會有人誤填，而誤填的押金會跑進押金管理頁
     * 變成一筆「要退給誰」的錢 —— 而根本沒有人收過那筆錢。
     */
    const h = incomeFieldsHidden(OTHER_BIZ_SOURCE);
    assert.equal(h.deposit, true);
    assert.equal(h.property, true);    // 沒有房源
    assert.equal(h.dateRange, true);   // 一次性收入只要一個日期
  });

  test('★ 安幸的來源什麼都不藏', () => {
    for (const s of ['private', 'oneoff', 'airbnb', null]) {
      const h = incomeFieldsHidden(s);
      assert.deepEqual([h.property, h.deposit, h.dateRange], [false, false, false], String(s));
    }
  });

  test('右邊那欄的標籤會換', () => {
    assert.equal(incomePartyLabel(OTHER_BIZ_SOURCE), '事業體');
    assert.equal(incomePartyLabel('private'), '物業');
    assert.equal(incomePartyLabel(null), '物業');
  });
});

describe('來源與帳本要對得起來', () => {
  test('★★ 選了其他事業體卻沒選是哪一家 → 擋', () => {
    const r = checkIncomeBook(OTHER_BIZ_SOURCE, 'anxing');
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, /事業體/);
  });

  test('★★ 一般來源卻記到愛皮帳上 → 擋', () => {
    // 這種資料一旦存進去，那筆錢在兩張報表上都找不到合理的解釋
    assert.equal(checkIncomeBook('private', 'aipi').ok, false);
  });

  test('對得起來的兩種情況', () => {
    assert.equal(checkIncomeBook(OTHER_BIZ_SOURCE, 'aipi').ok, true);
    assert.equal(checkIncomeBook('private', 'anxing').ok, true);
    assert.equal(checkIncomeBook('private', null).ok, true);   // null 當安幸
  });
});

describe('一張請款單只能有一本帳', () => {
  const est = { item_name: '清潔用品', purpose_type: 'estate' };
  const off = { item_name: '文具', purpose_type: 'office' };
  const biz = { item_name: '機票款', purpose_type: OTHER_BIZ_PURPOSE };

  test('★★ 安幸的單混進一項其他事業體 → 要講出是哪一項', () => {
    /*
     * 十七個項目的單子上,「有項目不對」等於沒說 ——
     * 使用者得自己一個一個找,而找的過程中很容易就放棄。
     */
    assert.deepEqual(misbookedItems('anxing', [est, biz, off]), ['機票款']);
  });

  test('★★ 愛皮的單混進一項物業 → 也要擋', () => {
    assert.deepEqual(misbookedItems('aipi', [biz, est]), ['清潔用品']);
  });

  test('全部對齊回空陣列', () => {
    assert.deepEqual(misbookedItems('anxing', [est, off]), []);
    assert.deepEqual(misbookedItems('aipi', [biz, biz]), []);
  });

  test('項目沒有名字時要給得出位置', () => {
    assert.deepEqual(misbookedItems('anxing', [{ purpose_type: OTHER_BIZ_PURPOSE }]), ['第 1 項']);
  });

  test('★ 允許的用途:安幸兩種，其他事業體只有一種', () => {
    assert.deepEqual(allowedPurposes('anxing'), ['estate', 'office']);
    assert.deepEqual(allowedPurposes('aipi'), ['other_biz']);
    assert.deepEqual(allowedPurposes(null), ['estate', 'office']);
  });
});

describe('查詢加帳本條件', () => {
  test('★★ 不給 book 就是安幸 —— 既有查詢加上它之後行為不變', () => {
    /*
     * 這一條是「可以安心一支一支補」的保證。
     * 預設不是安幸的話，補到一半的那段時間報表會是錯的。
     */
    const calls: [string, string][] = [];
    const q = { eq(c: string, v: string) { calls.push([c, v]); return this; } };
    withBook(q);
    assert.deepEqual(calls, [['book', 'anxing']]);
  });

  test('指定帳本', () => {
    const calls: [string, string][] = [];
    const q = { eq(c: string, v: string) { calls.push([c, v]); return this; } };
    withBook(q, 'hongsha');
    assert.deepEqual(calls, [['book', 'hongsha']]);
  });
});
