import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { planItemSave, receiptsAtRisk } from './pr-items-save.ts';

type Row = { id?: string | null; item_name: string };
const r = (item_name: string, id?: string): Row => (id ? { id, item_name } : { item_name });

describe('planItemSave', () => {
  test('★ 全新的單 —— 全部 insert，一個都不刪', () => {
    const p = planItemSave([r('A'), r('B')], []);
    assert.deepEqual(p.deleteIds, []);
    assert.equal(p.update.length, 0);
    assert.equal(p.insert.length, 2);
  });

  test('★★ 原封不動存一次 —— 全部走 update，id 不變', () => {
    // 這一題就是這支存在的理由。舊版會 delete 兩列再 insert 兩列,
    // id 全換 —— 掛在上面的憑證圖就消失了
    const p = planItemSave([r('A', 'a1'), r('B', 'a2')], ['a1', 'a2']);
    assert.deepEqual(p.deleteIds, [], '不該刪任何東西');
    assert.equal(p.insert.length, 0, '不該新增任何東西');
    assert.deepEqual(p.update.map((u) => u.id), ['a1', 'a2']);
  });

  test('★ 刪掉中間一項', () => {
    const p = planItemSave([r('A', 'a1'), r('C', 'a3')], ['a1', 'a2', 'a3']);
    assert.deepEqual(p.deleteIds, ['a2']);
    assert.deepEqual(p.update.map((u) => u.id), ['a1', 'a3']);
    assert.equal(p.insert.length, 0);
  });

  test('★ 中間插一項新的', () => {
    const p = planItemSave([r('A', 'a1'), r('新'), r('B', 'a2')], ['a1', 'a2']);
    assert.deepEqual(p.deleteIds, []);
    assert.equal(p.insert.length, 1);
    // 舊的兩列 id 不能變
    assert.deepEqual(p.update.map((u) => u.id), ['a1', 'a2']);
  });

  test('★★ sort 照畫面順序，不是照原本的順序', () => {
    // 使用者把 B 拖到最前面
    const p = planItemSave([r('B', 'a2'), r('A', 'a1')], ['a1', 'a2']);
    const byId = Object.fromEntries(p.update.map((u) => [u.id, u.sort]));
    assert.equal(byId.a2, 0);
    assert.equal(byId.a1, 1);
  });

  test('★★ sort 在 update 與 insert 之間是連續的', () => {
    // 各自從 0 開始編號的話，會出現兩個 sort=0，清單順序就爛了
    const p = planItemSave([r('A', 'a1'), r('新'), r('C', 'a3')], ['a1', 'a3']);
    const all = [...p.update.map((u) => u.sort), ...p.insert.map((i) => i.sort)].sort();
    assert.deepEqual(all, [0, 1, 2]);
  });

  test('★★ 畫面上的 id 在資料庫裡不存在 —— 當成新增,不要 update', () => {
    // update 一個不存在的 id 會影響 0 列,而 PostgREST 回成功。
    // 當成新增的話寧可多一列,也不要「畫面說存好了、資料庫什麼都沒有」
    const p = planItemSave([r('A', '不存在的id')], ['a1']);
    assert.equal(p.update.length, 0);
    assert.equal(p.insert.length, 1);
    assert.deepEqual(p.deleteIds, ['a1']);
  });

  test('★ insert 的列不帶 id —— PostgREST 批次會取欄位聯集', () => {
    const p = planItemSave([r('新')], []);
    assert.ok(!('id' in p.insert[0]), 'insert 不能帶 id 欄位');
  });

  test('全部清空 —— 全刪', () => {
    const p = planItemSave([], ['a1', 'a2']);
    assert.deepEqual(p.deleteIds, ['a1', 'a2']);
  });

  test('id 是 null 或空字串 —— 當成新增', () => {
    const p = planItemSave([{ id: null, item_name: 'A' }, { id: '', item_name: 'B' }], ['a1']);
    assert.equal(p.insert.length, 2);
    assert.deepEqual(p.deleteIds, ['a1']);
  });
});

describe('receiptsAtRisk', () => {
  test('★★ 要刪的項目有圖 —— 講出來', () => {
    assert.deepEqual(receiptsAtRisk(['a1', 'a2'], { a1: 2, a2: 0 }), ['a1']);
  });

  test('沒有圖就不用囉唆', () => {
    assert.deepEqual(receiptsAtRisk(['a1'], {}), []);
    assert.deepEqual(receiptsAtRisk(['a1'], { a1: 0 }), []);
  });

  test('沒有要刪的東西', () => {
    assert.deepEqual(receiptsAtRisk([], { a1: 5 }), []);
  });
});
