import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { extraDetails, hasExtraDetails, needsCrawlerDetail } from './sync-extra.ts';

describe('extraDetails', () => {
  test('★ 有什麼就列什麼 —— 不寫死鍵名', () => {
    // 爬蟲不在這個 repo,鍵名是猜不到的。
    // 猜錯的症狀是「畫面一片空白而且沒有線索」
    const d = extraDetails({ 'listing名稱': 'B8 時兆', '入住日': '2026-08-19', '房客': 'Max' });
    assert.deepEqual(d, [
      { label: 'listing名稱', value: 'B8 時兆' },
      { label: '入住日', value: '2026-08-19' },
      { label: '房客', value: 'Max' },
    ]);
  });

  test('★★ 空值整個丟掉,不要印「—」', () => {
    // 印「入住日：—」的話,跟「爬到了但是空的」長得一樣,
    // 而那兩件事要做的處理完全不同
    const d = extraDetails({ a: '', b: null, c: undefined, d: '  ', e: '有值' });
    assert.deepEqual(d, [{ label: 'e', value: '有值' }]);
  });

  test('數字與布林值也要看得到', () => {
    assert.deepEqual(extraDetails({ 晚數: 3, 已取消: false }), [
      { label: '晚數', value: '3' },
      { label: '已取消', value: '否' },
    ]);
  });

  test('★ 0 不能被當成空值丟掉', () => {
    // 用 `if (!v)` 判斷的話 0 會消失,而金額 0 是有意義的
    assert.deepEqual(extraDetails({ 金額: 0 }), [{ label: '金額', value: '0' }]);
  });

  test('陣列攤平', () => {
    assert.deepEqual(extraDetails({ 房源候選: ['B6', 'B8'] }),
      [{ label: '房源候選', value: 'B6、B8' }]);
  });

  test('★ 巢狀物件印 JSON,不是 [object Object]', () => {
    const d = extraDetails({ 原始: { id: 1 } });
    assert.equal(d[0].value, '{"id":1}');
    assert.ok(!d[0].value.includes('object Object'),
      '[object Object] 等於同時說「有東西」跟「你不能知道是什麼」');
  });

  test('★ 已經單獨顯示過的鍵不重複列', () => {
    assert.deepEqual(extraDetails({ 停用對照: 'A13', 其他: 'x' }),
      [{ label: '其他', value: 'x' }]);
  });

  test('空的 extra', () => {
    assert.deepEqual(extraDetails(null), []);
    assert.deepEqual(extraDetails(undefined), []);
    assert.deepEqual(extraDetails({}), []);
  });
});

describe('hasExtraDetails', () => {
  test('★★ 「沒有資料」與「有資料但沒顯示」要分得開', () => {
    // 留白的話,看的人會以為畫面壞了
    assert.equal(hasExtraDetails({ 房客: 'Max' }), true);
    assert.equal(hasExtraDetails({ 停用對照: 'A13' }), false, '只有已顯示過的鍵 = 沒有可補的細節');
    assert.equal(hasExtraDetails(null), false);
    assert.equal(hasExtraDetails({}), false);
  });
});

describe('needsCrawlerDetail', () => {
  test('★★ 用 field 不是 code —— 畫面上那個紅標籤就是 field', () => {
    // 我第一版寫成 it.code === '對不到房源',條件永遠不成立,
    // 那句提示一次都沒出現過而畫面看起來完全正常
    assert.equal(needsCrawlerDetail('對不到房源'), true);
    assert.equal(needsCrawlerDetail('房源'), true);
    assert.equal(needsCrawlerDetail('房源名稱查不到'), true);
  });

  test('★ 其他類別不需要 —— from_val / to_val 已經夠判斷', () => {
    for (const f of ['金額', '住宿起訖', '房客姓名', '待人工判斷', '在 Airbnb 找不到']) {
      assert.equal(needsCrawlerDetail(f), false, f);
    }
  });

  test('空值', () => {
    assert.equal(needsCrawlerDetail(null), false);
    assert.equal(needsCrawlerDetail(undefined), false);
    assert.equal(needsCrawlerDetail(''), false);
  });
});
