import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { savedState, pinnedHint, hasAnyFilter, SAVED_TTL_MS } from './just-saved.ts';

const T0 = 1_700_000_000_000;

describe('savedState', () => {
  test('沒存過東西 —— 什麼都不標', () => {
    assert.equal(savedState(null, ['a', 'b'], T0), 'none');
  });

  test('★ 那筆就在這一頁 → 高亮', () => {
    assert.equal(savedState({ id: 'b', at: T0 }, ['a', 'b'], T0 + 1000), 'inline');
  });

  test('★★ 那筆不在這一頁 → 置頂另畫一列', () => {
    // 這是整支的重點:補登去年的訂單會落在第 5 頁,
    // 不另外畫的話畫面上一筆都沒變,使用者會以為沒存進去
    assert.equal(savedState({ id: 'z', at: T0 }, ['a', 'b'], T0 + 1000), 'pinned');
  });

  test('★ 清單是空的（篩選把它排除了）→ 也要置頂', () => {
    assert.equal(savedState({ id: 'z', at: T0 }, [], T0 + 1000), 'pinned');
  });

  test('★ 過期就收掉 —— 不然隔天打開還寫著「剛剛儲存」', () => {
    assert.equal(savedState({ id: 'b', at: T0 }, ['b'], T0 + SAVED_TTL_MS - 1), 'inline');
    assert.equal(savedState({ id: 'b', at: T0 }, ['b'], T0 + SAVED_TTL_MS), 'none');
    assert.equal(savedState({ id: 'b', at: T0 }, ['b'], T0 + SAVED_TTL_MS + 1), 'none');
    // 不在清單裡的也一樣會過期
    assert.equal(savedState({ id: 'z', at: T0 }, ['b'], T0 + SAVED_TTL_MS), 'none');
  });

  test('TTL 可以覆寫 —— 測試不必真的等 45 秒', () => {
    assert.equal(savedState({ id: 'b', at: T0 }, ['b'], T0 + 50, 100), 'inline');
    assert.equal(savedState({ id: 'b', at: T0 }, ['b'], T0 + 150, 100), 'none');
  });
});

describe('pinnedHint', () => {
  test('★ 不猜原因 —— 只講確定的事', () => {
    for (const h of [pinnedHint(true), pinnedHint(false)]) {
      assert.ok(h.includes('已儲存'), '第一件事要先講「存好了」');
      // 篩選與分頁都在伺服器端,前端分不出是哪一個。猜錯會害人往錯的方向調
      assert.ok(!h.includes('第 '), '不要講「在第幾頁」—— 前端算不出來');
    }
  });

  test('有篩選時要提到篩選,沒有時不要亂提', () => {
    assert.ok(pinnedHint(true).includes('篩選'));
    assert.ok(!pinnedHint(false).includes('篩選'));
  });
});

describe('hasAnyFilter', () => {
  test('全空 → false', () => {
    assert.equal(hasAnyFilter({ kw: '', est: 'all', from: null, to: undefined }), false);
  });

  test('★ 任何一個有值 → true', () => {
    assert.equal(hasAnyFilter({ kw: '王', est: 'all' }), true);
    assert.equal(hasAnyFilter({ kw: '', est: 'e1' }), true);
    assert.equal(hasAnyFilter({ kw: '', est: 'all', from: '2026-08-01' }), true);
  });

  test("'all' 當作沒篩選 —— 那是下拉選單的預設值", () => {
    assert.equal(hasAnyFilter({ payF: 'all', feeF: 'all' }), false);
  });

  test('0 算有值 —— 不要被 falsy 騙了', () => {
    // 用 `!v` 判斷的話 0 會被當成沒填,而金額 0 是合法的篩選條件
    assert.equal(hasAnyFilter({ amount: 0 }), true);
  });
});
