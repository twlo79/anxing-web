import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { canSeeRequestReceipt, receiptHint, RECEIPT_ALL_ROLES } from './receipt-visibility.ts';

describe('canSeeRequestReceipt', () => {
  test('★ 會計以上不管誰送的都看得到', () => {
    for (const r of ['accountant', 'manager', 'super_admin']) {
      assert.equal(canSeeRequestReceipt(r, false), true, `${r} 應該看得到別人的單`);
      assert.equal(canSeeRequestReceipt(r, true), true);
    }
  });

  test('★★ 管家看得到所有單 —— migration_171 開放的', () => {
    // 170 實測是 0 / 1（看不到別人的）。171 把 pr/ 開給 housekeeper 之後，
    // 這裡跟著改 —— 前端比 RLS 窄的話,他看得到圖而畫面說「你沒有權限」
    assert.equal(canSeeRequestReceipt('housekeeper', false), true);
    assert.equal(canSeeRequestReceipt('housekeeper', true), true);
  });

  test('★★ 房務 cleaner 沒有跟著開 —— 171 只放行 housekeeper', () => {
    assert.equal(canSeeRequestReceipt('cleaner', false), false);
  });

  test('房務只看得到自己送的單', () => {
    assert.equal(canSeeRequestReceipt('cleaner', false), false);
    assert.equal(canSeeRequestReceipt('cleaner', true), true);
  });

  test('角色還沒載入 —— 一律當作看不到', () => {
    for (const v of [null, undefined, '']) {
      assert.equal(canSeeRequestReceipt(v, true), false, '載入中不要下結論');
    }
  });

  test('★ 清單:四個角色,沒有多也沒有少（要跟 can_see_receipt 對 pr/ 的放行一致）', () => {
    // cleaner 不在裡面 —— migration_171 只放行 housekeeper 這個字串。
    // 多放一個進來等於悄悄開了權限,而且畫面會說「有圖」但一張都載不到。
    assert.deepEqual([...RECEIPT_ALL_ROLES].sort(),
      ['accountant', 'housekeeper', 'manager', 'super_admin']);
  });
});

describe('receiptHint', () => {
  test('有圖就不說話', () => {
    assert.equal(receiptHint('accountant', false, 1), null);
    assert.equal(receiptHint('cleaner', false, 3), null);
  });

  test('★ 沒圖而且看得到 → 說「還沒上傳」,可以去催', () => {
    assert.equal(receiptHint('accountant', false, 0), '還沒上傳共同憑證圖片');
    // 171 之後管家看得到所有單,所以他看到的也是「還沒上傳」—— 那是真的
    assert.equal(receiptHint('housekeeper', false, 0), '還沒上傳共同憑證圖片');
    assert.equal(receiptHint('cleaner', true, 0), '還沒上傳共同憑證圖片');
  });

  test('★★ 沒圖而且看不到 → 不准說「還沒上傳」', () => {
    // 圖傳了、他只是沒權限看。說「還沒上傳」的話,
    // 他會去催一個已經把發票傳好的人。
    // 171 之後管家已經看得到了,所以這一題改用房務當例子
    const h = receiptHint('cleaner', false, 0);
    assert.ok(h);
    assert.ok(!h.includes('還沒上傳'), '不能說還沒上傳 —— 那是假的');
    assert.ok(h.includes('權限') || h.includes('看得到'), '要講出真正的原因');
  });

  test('角色還沒載入 —— 也不准說「還沒上傳」', () => {
    const h = receiptHint(null, true, 0);
    assert.ok(h && !h.includes('還沒上傳'));
  });
});
