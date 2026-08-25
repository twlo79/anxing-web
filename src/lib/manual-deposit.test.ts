import { test } from 'node:test';
import assert from 'node:assert/strict';
import { manualDepositMissing, manualDepositError } from './manual-deposit.ts';

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
