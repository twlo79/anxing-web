import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { keyBase, isKeyOf, onlyKeyOf, isLtKeyOf, ltPrefix } from './ltKey.ts';

/**
 * 月租單鍵的測試。跑法:npm test
 *
 * 這支釘住兩件會靜靜出錯的事:
 *   1. LIKE 的萬用字元 —— `LT_2F-1_%` 會撈到 2F-10~2F-19
 *   2. 房號空的契約要用契約 id 當鍵,不能組出 `LT__202601` 這種會亂撞的東西
 *
 * 兩種錯都不會報錯。第 1 種曾經把 2F-1/2F-2/2F-3 的收款記錄整批清空;
 * 第 2 種是 2026-08 的狀況 —— 公司登記的契約沒有房號,月租單完全產不出來,
 * 畫面只顯示「應收 $0」,看起來像金額算錯。
 */

const CID = '11111111-2222-3333-4444-555555555555';

describe('鍵基底', () => {
  test('有房號用房號', () => {
    assert.equal(keyBase({ id: CID, room: '2F-19' }), 'LT_2F-19_');
  });

  test('沒房號用契約 id', () => {
    assert.equal(keyBase({ id: CID, room: null }), `LTC_${CID}_`);
    assert.equal(keyBase({ id: CID, room: '' }), `LTC_${CID}_`);
  });

  test('房號空字串也算沒有 —— 下拉留白送過來是 \'\' 不是 null', () => {
    assert.equal(keyBase({ id: CID, room: '' }), keyBase({ id: CID, room: null }));
  });

  test('兩種鍵不會互相誤判', () => {
    const roomBase = keyBase({ id: CID, room: '2F-19' });
    const idBase = keyBase({ id: CID, room: null });
    assert.ok(!isKeyOf(idBase + '202601', roomBase));
    assert.ok(!isKeyOf(roomBase + '202601', idBase));
  });
});

describe('精確比對 —— LIKE 的萬用字元擋不住', () => {
  test('2F-1 不能撈到 2F-10 ~ 2F-19', () => {
    // SQL 那邊 `LT_2F-1_%` 會全部撈回來,所以 JS 端一定要再篩一次
    const rows = [
      { order_key: 'LT_2F-1_202601' },
      { order_key: 'LT_2F-10_202601' },
      { order_key: 'LT_2F-19_202601' },
    ];
    const kept = onlyKeyOf(rows, ltPrefix('2F-1'));
    assert.deepEqual(kept.map((r) => r.order_key), ['LT_2F-1_202601']);
  });

  test('結尾一定要是六位數年月', () => {
    assert.ok(isKeyOf('LT_A3_202601', 'LT_A3_'));
    assert.ok(!isKeyOf('LT_A3_2026', 'LT_A3_'), '四碼不算');
    assert.ok(!isKeyOf('LT_A3_20260101', 'LT_A3_'), '八碼不算');
    assert.ok(!isKeyOf('LT_A3_abc123', 'LT_A3_'));
  });

  test('房號含底線也不會誤判', () => {
    const rows = [{ order_key: 'LT_A_1_202601' }, { order_key: 'LT_AX1_202601' }];
    assert.deepEqual(onlyKeyOf(rows, ltPrefix('A_1')).map((r) => r.order_key), ['LT_A_1_202601']);
  });

  test('空房號不能比中任何東西 —— 否則會撈到全部的月租單', () => {
    assert.ok(!isLtKeyOf('LT_A3_202601', ''));
    assert.equal(onlyKeyOf([{ order_key: 'LTC__202601' }], 'LTC__').length, 0,
      '契約 id 也是空的時候不該比中');
  });
});
