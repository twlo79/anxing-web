import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { canCollect, collectDeniedMsg, COLLECT_ROLES } from './collect-perm.ts';

describe('canCollect —— 只有會計與總管理員', () => {
  test('會計可以', () => assert.equal(canCollect('accountant'), true));
  test('總管理員可以', () => assert.equal(canCollect('super_admin'), true));

  /*
   * ★★★ 這兩條是這次的重點（2026-09-02 使用者:「把管家與主管的權限關掉」）。
   *   主管以前可以，管家是 migration_154 開的 —— 兩個都收回來。
   */
  test('★★★ 主管不行', () => assert.equal(canCollect('manager'), false));
  test('★★★ 管家不行', () => assert.equal(canCollect('housekeeper'), false));

  // ★ 沒登入／角色還沒載到時一律不給 —— 預設關比預設開安全
  test('★ 空的與沒見過的角色一律不給', () => {
    assert.equal(canCollect(null), false);
    assert.equal(canCollect(undefined), false);
    assert.equal(canCollect(''), false);
    assert.equal(canCollect('未來新增的角色'), false);
  });

  test('清單就是那兩個', () => {
    assert.deepEqual([...COLLECT_ROLES], ['accountant', 'super_admin']);
  });
});

describe('collectDeniedMsg —— 要說得出找誰', () => {
  /*
   * ★ 只說「權限不足」的話，使用者只會再按一次或放棄。
   *   訊息要回答「那我該怎麼辦」。
   */
  test('★ 訊息裡有「會計」', () => {
    assert.match(collectDeniedMsg(), /會計/);
  });
  test('帶得進在收什麼', () => {
    assert.match(collectDeniedMsg('這一期的租金'), /這一期的租金/);
  });
  test('沒帶就用通稱,不會出現 undefined', () => {
    assert.match(collectDeniedMsg(), /款項/);
    assert.equal(collectDeniedMsg().includes('undefined'), false);
  });
});
