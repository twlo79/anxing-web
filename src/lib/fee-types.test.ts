import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FEE_TYPES, ONEOFF_FEE_TYPES, ONEOFF_ONLY_FEE_TYPES,
  FEE_DEFAULT, CONTRACT_FEE_PRESETS, feeLabel,
} from './fee-types.ts';

test('★★ 保證金只出現在一次性收入,不在共用清單裡', () => {
  // 共用清單是「會重複發生的費用」:加費、契約固定加費、定期收費。
  // 保證金是一次性事件（違約沒收、履約保證金轉列收入）——
  // 讓它出現在「每月自動產生」的選單上,那個選項存在本身就是在邀請人填錯
  assert.ok(!FEE_TYPES.includes('保證金' as never), '加費與定期收費不該選得到');
  assert.ok(ONEOFF_FEE_TYPES.includes('保證金' as never), '一次性收入要選得到');
});

test('★ 一次性收入的清單包含共用的全部科目', () => {
  // 少一個的話,那個科目在一次性收入就填不了 —— 而它們本來都填得了
  for (const t of FEE_TYPES) {
    assert.ok(ONEOFF_FEE_TYPES.includes(t as never), `${t} 不見了`);
  }
});

test('★ 兩份清單的「其他」都在最後', () => {
  assert.equal(FEE_TYPES[FEE_TYPES.length - 1], '其他');
  assert.equal(ONEOFF_FEE_TYPES[ONEOFF_FEE_TYPES.length - 1], '其他');
});

test('保證金沒有重複出現', () => {
  assert.equal(ONEOFF_FEE_TYPES.filter((t) => t === '保證金').length, 1);
  assert.equal(ONEOFF_ONLY_FEE_TYPES.length, 1);
});

test('★ 只有一次性收入才有的科目,不能出現在契約固定加費的預設裡', () => {
  // 契約固定加費是每期自動產生的,選了保證金會變成「每個月沒收一次保證金」
  for (const p of CONTRACT_FEE_PRESETS) {
    assert.ok(!ONEOFF_ONLY_FEE_TYPES.includes(p.fee_type as never),
      `${p.label} 用了只屬於一次性收入的科目`);
  }
});

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
  // 電費沒有做成預設,走的是自己組那條路
  assert.equal(feeLabel('電費', null), '電費');
  assert.equal(feeLabel('設備費', '烤箱'), '設備費－烤箱');
  assert.equal(feeLabel(null, null), '其他');
});

test('★ 垃圾代收的科目是清潔費,不是自成一格', () => {
  // 另立科目的話,資料庫的 order_account_code 沒有對應規則,
  // 會靜靜地掉進「其他」—— 報表上看起來正常,分類卻是錯的
  const t = CONTRACT_FEE_PRESETS.find((p) => p.label === '垃圾代收');
  assert.equal(t?.fee_type, '清潔費');
  assert.equal(t?.item_name, '垃圾代收');
  assert.equal(feeLabel('清潔費', '垃圾代收'), '垃圾代收');
});

test('水費是預設項目,而且沒有細目', () => {
  assert.equal(CONTRACT_FEE_PRESETS.find((p) => p.label === '水費')?.item_name, null);
  assert.equal(feeLabel('水費', null), '水費');
});

test('feeLabel:空字串的項目視同沒有項目', () => {
  assert.equal(feeLabel('管理費', ''), '管理費');
});
