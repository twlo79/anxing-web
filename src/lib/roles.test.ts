import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { canEditOrders, ORDER_EDIT_ROLES } from './roles.ts';

/**
 * 這裡判斷錯**不會報錯**，只會讓某個角色看到一顆按了沒用的按鈕
 * （PostgREST 遇到 RLS 擋下的寫入是回成功、影響 0 列），
 * 或是看不到本來該有的按鈕。兩種都要等有人抱怨才會發現。
 */

describe('誰能編輯訂單與契約', () => {
  test('★★ 管家可以 —— 2026-08-21 開放，對應 migration_154', () => {
    assert.equal(canEditOrders('housekeeper'), true);
  });

  test('會計、主管、總經理維持可以', () => {
    assert.equal(canEditOrders('accountant'), true);
    assert.equal(canEditOrders('manager'), true);
    assert.equal(canEditOrders('super_admin'), true);
  });

  test('★ 清潔人員不行 —— 這支開放的是管家，不是所有人', () => {
    assert.equal(canEditOrders('cleaner'), false);
  });
});

describe('角色還沒載入', () => {
  test('★★ 空值一律 false', () => {
    /*
     * useProfile() 第一次 render 一定是空的。
     * 這裡如果回 true，按鈕會先閃出來再消失;
     * 更糟的是使用者剛好在那一瞬間按下去。
     */
    assert.equal(canEditOrders(null), false);
    assert.equal(canEditOrders(undefined), false);
    assert.equal(canEditOrders(''), false);
  });

  test('沒聽過的角色不行 —— 不認得就不給', () => {
    assert.equal(canEditOrders('admin'), false);
    assert.equal(canEditOrders('HOUSEKEEPER'), false);   // 大小寫不寬容
  });
});

describe('清單本身', () => {
  test('★ 四個角色，沒有多也沒有少', () => {
    // 多一個沒發現的話，等於悄悄開了權限給不該有的人。
    assert.deepEqual([...ORDER_EDIT_ROLES].sort(),
      ['accountant', 'housekeeper', 'manager', 'super_admin']);
  });
});
