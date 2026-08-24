import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { canEditOrders, orderDeleteBlockedReason, ORDER_EDIT_ROLES, ORDER_DELETE_ROLES } from './roles.ts';

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

/* ============================================================
 * 刪除訂單（migration_167）
 * ============================================================ */
describe('orderDeleteBlockedReason', () => {
  test('★ 管家刪得掉安幸的一般訂單', () => {
    assert.equal(orderDeleteBlockedReason('housekeeper', 'anxing', null), null);
    // 舊資料 book 是 null —— 當作安幸,不要突然刪不動
    assert.equal(orderDeleteBlockedReason('housekeeper', null, null), null);
    assert.equal(orderDeleteBlockedReason('housekeeper', undefined, null), null);
  });

  test('★★ 房務(cleaner)刪不掉 —— 跟 trash_can_delete 一致', () => {
    // RLS 分不出 cleaner 與管家,但回收桶那支分得出來。前端要跟上,
    // 否則房務會看到一顆按下去只會跳「沒有權限」的按鈕。
    assert.ok(orderDeleteBlockedReason('cleaner', 'anxing', null)?.includes('沒有刪除訂單的權限'));
  });

  test('★★ 管家刪不掉愛皮／洪鯊的收入', () => {
    for (const b of ['aipi', 'hongsha']) {
      assert.ok(orderDeleteBlockedReason('housekeeper', b, null)?.includes('其他收支帳'),
        `${b} 應該擋下來`);
    }
    // 會計可以 —— 那一頁本來就是給他的
    assert.equal(orderDeleteBlockedReason('accountant', 'aipi', null), null);
  });

  test('★★ 已退押金的訂單:管家擋、會計放行', () => {
    const r = '這筆訂單的押金已退款';
    assert.ok(orderDeleteBlockedReason('housekeeper', 'anxing', r)?.includes('請洽會計'));
    assert.ok(orderDeleteBlockedReason('manager', 'anxing', r)?.includes('請洽會計'));
    // trg_orders_lock_guard 只放行這兩個 —— 前端要一模一樣
    assert.equal(orderDeleteBlockedReason('accountant', 'anxing', r), null);
    assert.equal(orderDeleteBlockedReason('super_admin', 'anxing', r), null);
  });

  test('角色還沒載入 —— 擋住,而且說「正在確認」不是「沒有權限」', () => {
    for (const v of [null, undefined, '']) {
      const msg = orderDeleteBlockedReason(v, 'anxing', null);
      assert.ok(msg);
      assert.ok(!msg.includes('沒有'), '載入中不該說沒有權限 —— 會讓人以為被降權');
    }
  });

  test('★ 清單:四個角色,沒有多也沒有少', () => {
    assert.deepEqual([...ORDER_DELETE_ROLES].sort(),
      ['accountant', 'housekeeper', 'manager', 'super_admin']);
  });
});
