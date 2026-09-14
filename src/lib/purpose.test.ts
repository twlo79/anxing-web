import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { contractPurpose, purposeLockedByType, isOfficePurpose } from './purpose.ts';

describe('契約用途（migration_247）', () => {
  test('長租契約照勾選框走', () => {
    assert.equal(contractPurpose({ type: 'longterm', purpose_type: 'estate' }), 'estate');
    assert.equal(contractPurpose({ type: 'longterm', purpose_type: 'office' }), 'office');
  });

  test('沒填就是 estate —— 不留 null 給資料庫猜', () => {
    assert.equal(contractPurpose({ type: 'longterm' }), 'estate');
    assert.equal(contractPurpose({ type: null, purpose_type: null }), 'estate');
    assert.equal(contractPurpose({}), 'estate');
  });

  /*
   * ★★★ 這兩條釘住的是 migration_247 第 ③ 步那支觸發器。
   *   前端算出 estate、資料庫存成 office 的話，
   *   使用者打開契約會看到勾選框是空的 —— 而報表算的是 office。
   */
  test('辦公室登記與公司登記：勾不勾都是 office', () => {
    assert.equal(contractPurpose({ type: 'office', purpose_type: 'estate' }), 'office');
    assert.equal(contractPurpose({ type: 'company', purpose_type: 'estate' }), 'office');
    assert.equal(contractPurpose({ type: 'office' }), 'office');
    assert.equal(contractPurpose({ type: 'company', purpose_type: 'office' }), 'office');
  });

  test('那兩種類別的勾選框是鎖住的，長租不是', () => {
    assert.equal(purposeLockedByType('office'), true);
    assert.equal(purposeLockedByType('company'), true);
    assert.equal(purposeLockedByType('longterm'), false);
    assert.equal(purposeLockedByType(null), false);
    assert.equal(purposeLockedByType(undefined), false);
  });

  test('isOfficePurpose 跟 contractPurpose 不會各說各話', () => {
    for (const type of ['longterm', 'office', 'company', null]) {
      for (const pt of ['estate', 'office', null]) {
        const c = { type, purpose_type: pt };
        assert.equal(isOfficePurpose(c), contractPurpose(c) === 'office');
      }
    }
  });
});
