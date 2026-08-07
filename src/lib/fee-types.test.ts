import test from 'node:test';
import assert from 'node:assert/strict';
import { FEE_TYPES, FEE_DEFAULT, CONTRACT_FEE_PRESETS, feeLabel } from './fee-types.ts';

test('新科目已加入,且「其他」永遠在最後', () => {
  assert.ok(FEE_TYPES.includes('停車費' as never));
  assert.ok(FEE_TYPES.includes('設備費' as never));
  assert.equal(FEE_TYPES[FEE_TYPES.length - 1], '其他');
});

test('預設值仍在清單裡 —— 不在的話下拉會選不到自己的預設', () => {
  assert.ok(FEE_TYPES.includes(FEE_DEFAULT as never));
});

test('每個預設用的科目都在 FEE_TYPES 裡', () => {
  // 不在的話,這筆加費的科目在營收報表會變成一個沒人認得的分組
  for (const p of CONTRACT_FEE_PRESETS) {
    assert.ok(FEE_TYPES.includes(p.fee_type as never), `${p.label} 的科目「${p.fee_type}」不在清單裡`);
  }
});

test('設備費三項共用同一個科目 —— 報表才答得出「設備費一共收多少」', () => {
  const eq = CONTRACT_FEE_PRESETS.filter((p) => p.fee_type === '設備費');
  assert.equal(eq.length, 3);
  assert.deepEqual(eq.map((p) => p.item_name), ['冰箱', '洗烘衣機', '電視']);
});

test('管理費與停車費沒有項目', () => {
  assert.equal(CONTRACT_FEE_PRESETS.find((p) => p.label === '管理費')?.item_name, null);
  assert.equal(CONTRACT_FEE_PRESETS.find((p) => p.label === '停車費')?.item_name, null);
});

test('預設的顯示名稱不重複 —— 下拉裡兩個一樣的選項沒人分得出來', () => {
  const labels = CONTRACT_FEE_PRESETS.map((p) => p.label);
  assert.equal(new Set(labels).size, labels.length);
});

test('feeLabel:對得上預設就用預設的名稱', () => {
  assert.equal(feeLabel('設備費', '冰箱'), '設備費－冰箱');
  assert.equal(feeLabel('管理費', null), '管理費');
});

test('feeLabel:管理費帶了項目時不能誤判成無項目的那個預設', () => {
  assert.equal(feeLabel('管理費', '公設'), '管理費－公設');
});

test('feeLabel:對不上預設就自己組,不要變成空白', () => {
  assert.equal(feeLabel('水費', null), '水費');
  assert.equal(feeLabel('設備費', '烤箱'), '設備費－烤箱');
  assert.equal(feeLabel(null, null), '其他');
});

test('feeLabel:空字串的項目視同沒有項目', () => {
  assert.equal(feeLabel('管理費', ''), '管理費');
});
