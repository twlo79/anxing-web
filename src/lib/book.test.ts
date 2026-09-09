import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  BOOKS, OTHER_BOOKS, DEFAULT_BOOK, BOOK_LABEL, toBook, isOtherBook, bookLabel,
  OTHER_BIZ_SOURCE, OTHER_BIZ_PURPOSE,
  incomeFieldsHidden, incomePartyLabel,
  checkIncomeBook, misbookedItems, allowedPurposes, withBook, hasDeposit, newItemPurpose,
  needsManagerVote,
  canLend, lendFor,
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

describe('押金這一欄該不該顯示', () => {
  /*
   * ★★★ 2026-09-01 起 Airbnb 例外（migration_194，寵物押金）。
   *   房費是平台收的，但寵物押金是我們當場收的 —— 錢在我們手上，
   *   所以要進暫收付管理才退得出去。
   */
  test('★★ Airbnb 現在可以收押金（寵物押金）', () => {
    assert.equal(hasDeposit('airbnb'), true);
  });

  /*
   * ★★★ 這一條是護欄:使用者只要求開放 Airbnb。
   *   哪天有人把 DEPOSIT_OK_PLATFORMS 改成整個 PLATFORM_SOURCES，
   *   Agoda 會多出一欄永遠空白的押金，而畫面上沒有任何跡象。
   */
  test('★★★ Agoda 與已取消的 Airbnb 維持鎖住', () => {
    for (const s of ['agoda', 'airbnb_cancelled']) {
      assert.equal(hasDeposit(s), false, s);
    }
  });

  test('★ 其他事業體也沒有', () => {
    assert.equal(hasDeposit(OTHER_BIZ_SOURCE), false);
  });

  test('私下與一次性收入有', () => {
    assert.equal(hasDeposit('private'), true);
    assert.equal(hasDeposit('oneoff'), true);
  });

  test('★ 認不出來的來源預設「有」—— 藏掉一個該填的欄位比多一行空白糟', () => {
    assert.equal(hasDeposit(null), true);
    assert.equal(hasDeposit('未來的新來源'), true);
  });
});

/*
 * ── 新增項目時繼承什麼（2026-08-25）──────────────────
 */
test('★ 其他事業體的單：新項目自動也是其他事業體', () => {
  assert.equal(newItemPurpose([{ purpose_type: OTHER_BIZ_PURPOSE }]).purpose_type, OTHER_BIZ_PURPOSE);
});

test('★★ 安幸的單：新項目不繼承物業 —— 填錯物業沒有人會發現', () => {
  const r = newItemPurpose([{ purpose_type: 'estate' }]);
  assert.equal(r.purpose_type, 'estate');
  assert.equal(r.estate_id, null);
  assert.equal(r.property_id, null);
});

test('辦公室的單：新項目回到未指定，不自動變成辦公室', () => {
  assert.equal(newItemPurpose([{ purpose_type: 'office' }]).purpose_type, 'estate');
});

test('第一張空單：跟以前一樣', () => {
  assert.equal(newItemPurpose([]).purpose_type, 'estate');
  assert.equal(newItemPurpose(null).purpose_type, 'estate');
  assert.equal(newItemPurpose(undefined).purpose_type, 'estate');
});

test('★ 看的是「有沒有任何一項是其他事業體」不是只看第一項', () => {
  // 第一項可能被刪掉了。一張單只能有一本帳,所以剩下的那些必然同一家
  assert.equal(
    newItemPurpose([{ purpose_type: 'estate' }, { purpose_type: OTHER_BIZ_PURPOSE }]).purpose_type,
    OTHER_BIZ_PURPOSE,
  );
});

/*
 * ── 主管那一票（2026-08-25）──────────────────────────
 */
test('★ 愛皮與洪鯊不用主管票（migration_160）', () => {
  for (const b of OTHER_BOOKS) assert.equal(needsManagerVote(b), false, b);
});

test('★ 安幸的單照樣要主管票', () => {
  assert.equal(needsManagerVote(DEFAULT_BOOK), true);
  assert.equal(needsManagerVote('anxing'), true);
});

test('★★ 沒帶 book 當成安幸 —— 要主管票（放行錯了等於繞過審核）', () => {
  assert.equal(needsManagerVote(null), true);
  assert.equal(needsManagerVote(undefined), true);
  assert.equal(needsManagerVote(''), true);
});

test('認不出來的值也當成安幸,寧可多一票', () => {
  assert.equal(needsManagerVote('不存在的帳本'), true);
});

// ── 安幸代墊（migration_236 / 237）────────────────────────

describe('★★★ 安幸代墊：advance_for_book 不可能跟 book 不一致', () => {
  test('★★★ 勾了就是這張單的帳本，不讓人自己挑', () => {
    /*
     * 挑錯的話「費用記在愛皮、錢要洪鯊還」——
     * 而兩邊的數字都看起來合理，只有結算時對不起來。
     */
    assert.equal(lendFor('aipi', true), 'aipi');
    assert.equal(lendFor('hongsha', true), 'hongsha');
  });

  test('★★★ 安幸自己的單勾不起來 —— 自己的錢不用跟自己借', () => {
    assert.equal(lendFor('anxing', true), null);
    assert.equal(lendFor(null, true), null);      // null 當成安幸
  });

  test('沒勾就是 null', () => {
    assert.equal(lendFor('aipi', false), null);
  });

  test('★★ canLend 跟 isOtherBook 是同一條規則 —— 不要各寫一份', () => {
    for (const b of ['aipi', 'hongsha']) assert.equal(canLend(b), true, b);
    assert.equal(canLend('anxing'), false);
    assert.equal(canLend(null), false);
    // 認不得的值當成安幸（跟 toBook 同一條規則）
    assert.equal(canLend('mystery'), false);
  });

  test('★★★ 勾起來之後，兩個欄位必定相等', () => {
    // 這是資料庫那條 raise 的前端版本：讓畫面沒有辦法造出不一致的組合
    for (const b of ['anxing', 'aipi', 'hongsha', null, 'mystery']) {
      const v = lendFor(b, true);
      if (v !== null) assert.equal(v, toBook(b), `${b} 的代墊帳本對不起來`);
    }
  });
});
