import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeError } from './flash-kind.ts';

describe('looksLikeError —— 錯誤訊息不可以自己消失', () => {
  const errors = [
    '儲存失敗:permission denied',
    '刪除失敗：boom',
    '無法儲存,前一段任期收尾失敗:x',
    '你的角色不能核可',
    '讀不到關帳紀錄：timeout',
    '回成功但沒寫進去 —— 可能是權限',
    '更新沒有改到任何一列 —— 多半是權限或關帳。請重新整理後確認。',
    '不夠：這次共 12 小時，只剩 8 小時。',
    '請填駁回原因',
    '請先選假別。',
    '找不到單號 PR-0031',
    '這張單已存在',
    '⚠ 已有 3 筆收款紀錄',
  ];
  for (const t of errors) test(`錯誤：「${t.slice(0, 22)}」`, () => assert.equal(looksLikeError(t), true));

  const oks = [
    '已儲存',
    '已核可',
    '已駁回',
    '已刪除延展(2028/11 起),迄日回到 2028-10-30,對應收租一併移除',
    '已展延 1 個月・新增 1 期待收款(月租 $10)',
    '摘要已更新',
    '已沒收，並產生一筆 NT$ 5,000 的「取消入住」收入',
    '已新增，同時重算了 3 筆餘額',
    '已停用',
  ];
  for (const t of oks) test(`提示：「${t.slice(0, 22)}」`, () => assert.equal(looksLikeError(t), false));

  test('空字串／null 不算錯誤', () => {
    assert.equal(looksLikeError(''), false);
    assert.equal(looksLikeError(null), false);
    assert.equal(looksLikeError(undefined), false);
  });
});
