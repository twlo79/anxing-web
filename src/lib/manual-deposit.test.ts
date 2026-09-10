import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  manualDepositMissing, manualDepositMissingAll, manualDepositError,
} from './manual-deposit.ts';

const ok = { estate_id: 'e1', room: '14B5', guest_name: 'Lilian', amount: 30000, kind: 'deposit' };

test('全部填好 → 沒有缺的', () => {
  assert.deepEqual(manualDepositMissing(ok), []);
  assert.equal(manualDepositError(ok), null);
});

test('物業空著要擋 —— 空著的話物業篩選看不到它', () => {
  assert.deepEqual(manualDepositMissing({ ...ok, estate_id: null }), ['物業']);
});

test('只填房源不填姓名要擋（舊規則會放行）', () => {
  assert.deepEqual(manualDepositMissing({ ...ok, guest_name: '' }), ['姓名']);
});

test('只填姓名不填房源要擋（舊規則會放行）', () => {
  assert.deepEqual(manualDepositMissing({ ...ok, room: '   ' }), ['房源']);
});

test('缺的順序＝畫面由上到下', () => {
  assert.deepEqual(
    manualDepositMissing({ amount: 1, kind: 'deposit' }),
    ['物業', '房源', '姓名'],
  );
});

test('★ 一次講完缺哪些，不是一次擋一個', () => {
  assert.equal(
    manualDepositError({ kind: 'deposit' }),
    '請填：物業、房源、姓名、金額',
  );
});

test('金額 0 或負數要擋', () => {
  assert.equal(manualDepositError({ ...ok, amount: 0 }), '請填：金額');
  assert.equal(manualDepositError({ ...ok, amount: -1 }), '請填：金額');
});

test('金額是字串也算得出來（MoneyInput 有時給字串）', () => {
  assert.equal(manualDepositError({ ...ok, amount: '30000' }), null);
});

test('★ 種類沒帶會存成押金而且不報錯 —— 所以要擋', () => {
  assert.equal(manualDepositError({ ...ok, kind: undefined }), '請選種類（押金或訂金）');
  assert.equal(manualDepositError({ ...ok, kind: '' }), '請選種類（押金或訂金）');
  assert.equal(manualDepositError({ ...ok, kind: 'earnest' }), null);
});

test('種類是不認識的值也要擋（dep_kind_chk 會擋，但錯誤訊息看不懂）', () => {
  assert.equal(manualDepositError({ ...ok, kind: 'earnest_in' }), '請選種類（押金或訂金）');
});

test('空白字元不算填了', () => {
  assert.deepEqual(manualDepositMissing({ estate_id: ' ', room: '\t', guest_name: '\n' }),
    ['物業', '房源', '姓名']);
});

// ── 含金額的完整清單（2026-09-10）──────────────────────────

describe('★★ manualDepositMissingAll —— 畫面要畫紅框，就得拿得到完整清單', () => {
  test('金額 0 也算缺', () => {
    /*
     * ★★★ 原本「金額」只在 manualDepositError() 裡被 push，
     *   那份完整清單只活在區域變數裡 —— 畫面拿不到，
     *   所以金額欄永遠畫不出紅框:按了存不了，而那一格看起來很正常。
     */
    assert.deepEqual(
      manualDepositMissingAll({ estate_id: 'e1', room: '14B5', guest_name: '王', amount: 0 }),
      ['金額']);
  });

  test('全部沒填 → 四個都列出來，順序照畫面', () =>
    assert.deepEqual(manualDepositMissingAll({}), ['物業', '房源', '姓名', '金額']));

  test('填齊了回空陣列', () =>
    assert.deepEqual(
      manualDepositMissingAll(
        { estate_id: 'e1', room: '14B5', guest_name: '王', amount: 20000 }),
      []));

  test('★ 跟 manualDepositError 的答案要一致 —— 兩邊各算一次就會漂', () => {
    const d = { estate_id: '', room: '14B5', guest_name: '王', amount: 0, kind: 'deposit' };
    const miss = manualDepositMissingAll(d);
    const msg = manualDepositError(d)!;
    for (const m of miss) assert.match(msg, new RegExp(m));
  });
});
