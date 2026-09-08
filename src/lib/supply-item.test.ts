import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { newItemError, needsInitTxn, type NewSupplyItem } from './supply-item.ts';

const ok = (o: Partial<NewSupplyItem> = {}): NewSupplyItem => ({
  on: '2026-09-07', name: '衛生紙', spec: '大包裝／12 卷',
  vendor: '', expire_on: '', init: '10', ...o,
});

describe('新增備品品項的必填', () => {
  test('填完整就過', () => {
    assert.equal(newItemError(ok()), null);
  });

  test('廠商與效期可以空白', () => {
    assert.equal(newItemError(ok({ vendor: '', expire_on: '' })), null);
  });

  test('★ 日期必填', () => {
    assert.match(newItemError(ok({ on: '' }))!, /日期/);
  });

  test('★ 物資名稱必填', () => {
    assert.match(newItemError(ok({ name: '   ' }))!, /物資名稱/);
  });

  test('★★ 規格型號必填 —— 唯一索引是「名稱＋規格」', () => {
    // 規格空白與規格「大包裝」是兩筆，於是清單上會出現兩個衛生紙
    assert.match(newItemError(ok({ spec: '' }))!, /規格/);
  });

  test('★★★ 初始庫存沒填要擋，不能被 Number(\'\') === 0 放過去', () => {
    /*
     * 先 Number() 再比 `>= 0` 的話，完全沒填會通過 ——
     * 而品項會建好、庫存是 0，填表的人卻記得自己填過數字。
     */
    assert.match(newItemError(ok({ init: '' }))!, /初始庫存/);
    assert.match(newItemError(ok({ init: '  ' }))!, /初始庫存/);
  });

  test('★★ 初始庫存填 0 是合法的 —— 那是「現在沒有」，是一個答案', () => {
    assert.equal(newItemError(ok({ init: '0' })), null);
  });

  test('負數與亂打要擋', () => {
    assert.match(newItemError(ok({ init: '-1' }))!, /0 或正數/);
    assert.match(newItemError(ok({ init: 'abc' }))!, /0 或正數/);
  });

  test('★ 訊息一次只講一項，照欄位由上到下', () => {
    // 一次列全部的話，使用者要在一句話裡找出自己漏了哪一格
    const s = newItemError({ on: '', name: '', spec: '', vendor: '', expire_on: '', init: '' });
    assert.match(s!, /日期/);
    assert.equal(/名稱/.test(s!), false);
  });
});

describe('初始庫存要不要寫流水', () => {
  test('★ 填 0 不寫 —— 數量 0 的流水只是雜訊', () => {
    assert.equal(needsInitTxn('0'), false);
  });
  test('填正數才寫', () => {
    assert.equal(needsInitTxn('10'), true);
    assert.equal(needsInitTxn('0.5'), true);
  });
  test('空白不寫', () => {
    assert.equal(needsInitTxn(''), false);
  });
});
