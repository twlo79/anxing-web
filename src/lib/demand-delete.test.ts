import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  itemDeleteBlocked, demandDeleteBlocked,
  itemDeleteConfirm, demandDeleteConfirm,
} from './demand-delete.ts';

/**
 * 刪採購需求單。
 *
 * ============================================================
 * 【這支在防什麼】
 *
 * 刪錯**不會報錯**:
 *
 *   ① 刪掉已被請款單領走的 → 那張請款單的錢照付，但「當初為了買什麼」
 *      不見了，而請款單那一頁完全看不出來
 *   ② 刪整張單時漏看某一項 → 同上，只是一次五項
 *   ③ 確認視窗沒寫刪幾項    → 使用者以為只刪一張單，五項一起消失
 *
 * 而這兩張表**沒有稽核觸發器** —— 回收桶是唯一的痕跡,
 * 而沒有人會想到去回收桶找一張請款單的來源。
 */

const item = (o: Partial<Parameters<typeof itemDeleteBlocked>[0]> = {}) => ({
  item_name: '衛生紙*1箱', status: 'pending', ...o,
});

describe('★★★ 單一項目：已被請款單領走的不給刪', () => {
  test('★★★ 有 request_item_id → 擋，而且要說是哪一張單', () => {
    const r = itemDeleteBlocked(item({
      status: 'requested', request_item_id: 'ri-1', request_no: 'PR-202609-003',
    }));
    assert.ok(r);
    // 不說是哪一張的話，人不知道要去哪裡退
    assert.match(r, /PR-202609-003/);
    assert.match(r, /衛生紙/);
  });

  test('沒有編號也要擋，只是訊息裡沒有單號', () => {
    const r = itemDeleteBlocked(item({ request_item_id: 'ri-1' }));
    assert.ok(r);
  });

  test('★★ 「已請款但接不到單」的孤兒可以刪', () => {
    /*
     * status 是 requested 但沒有 request_item_id —— 沒有任何東西指著它,
     * 而它卡在那裡永遠不會前進。刪掉正是清理它的辦法之一。
     */
    assert.equal(itemDeleteBlocked(item({ status: 'requested' })), null);
  });

  test('待採購、已詢價、已採購、已取消都刪得掉', () => {
    for (const status of ['pending', 'quoted', 'done', 'cancelled']) {
      assert.equal(itemDeleteBlocked(item({ status })), null, status);
    }
  });
});

describe('★★★ 整張單：一項被領走就不給整張刪', () => {
  test('★★★ 五項裡有一項被領走 → 擋整張', () => {
    /*
     * 刪整張會連子列一起帶走（trash_collect_children 照外鍵收）,
     * 「其他四項刪掉、那一項留著」在回收桶那套機制裡做不到。
     * 只看整張單的狀態是看不出來的 —— 狀態是彙總。
     */
    const r = demandDeleteBlocked([
      item(), item(), item(),
      item({ request_item_id: 'ri-1', request_no: 'PR-202609-003' }),
      item(),
    ]);
    assert.ok(r);
    assert.match(r, /1 項/);
    assert.match(r, /PR-202609-003/);
  });

  test('兩項被同一張請款單領走 → 單號不重複列', () => {
    const r = demandDeleteBlocked([
      item({ request_item_id: 'a', request_no: 'PR-1' }),
      item({ request_item_id: 'b', request_no: 'PR-1' }),
    ]);
    assert.ok(r);
    assert.match(r, /2 項/);
    assert.equal((r.match(/PR-1/g) ?? []).length, 1);
  });

  test('一項都沒被領走 → 可以刪', () => {
    assert.equal(demandDeleteBlocked([item(), item({ status: 'done' })]), null);
  });

  test('空的單也可以刪', () => {
    assert.equal(demandDeleteBlocked([]), null);
  });
});

describe('確認視窗要說清楚', () => {
  test('★★ 刪一項要寫是哪一項，還要寫進回收桶', () => {
    // 一張單五項長得很像,只說「確定刪除?」的話按下去才發現刪錯
    const s = itemDeleteConfirm(item({ item_name: '除霉劑*12瓶' }));
    assert.match(s, /除霉劑\*12瓶/);
    assert.match(s, /回收桶/);
  });

  test('★★★ 刪整張要寫「會連幾項一起刪」', () => {
    /*
     * 使用者按的是單頭那顆鍵,腦中想的是「這張單」——
     * 不寫項目數的話,五項一起消失會是個意外。
     */
    const s = demandDeleteConfirm('DM-202609-002', [
      item({ item_name: 'test*1' }), item({ item_name: 'test*2' }),
      item({ item_name: 'test*3' }),
    ]);
    assert.match(s, /DM-202609-002/);
    assert.match(s, /3 項/);
    assert.match(s, /test\*1/);
    assert.match(s, /回收桶/);
  });

  test('★ 項目多的時候只列前五項，但要說還有幾項', () => {
    const many = Array.from({ length: 9 }, (_, i) => item({ item_name: `項目${i}` }));
    const s = demandDeleteConfirm('DM-1', many);
    assert.match(s, /9 項/);
    assert.match(s, /還有 4 項/);
    assert.equal(s.includes('項目8'), false);
  });

  test('沒有編號的單也要說得出是哪一張', () => {
    assert.match(demandDeleteConfirm(null, [item()]), /未編號/);
  });
});
