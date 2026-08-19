import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  FEE_TYPES, ONEOFF_FEE_TYPES, ONEOFF_ONLY_FEE_TYPES,
  FEE_DEFAULT, CONTRACT_FEE_PRESETS, ONEOFF_PRESETS, presetOf, feeLabel,
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

// ============================================================
// 電費／飲用水／其它（2026-08-19 使用者指定）
// ============================================================

describe('新加的三個項目', () => {
  const need = [
    { label: '電費',   fee_type: '水電瓦斯', item_name: '電費' },
    { label: '飲用水', fee_type: '管理費',   item_name: '飲用水' },
    { label: '其它',   fee_type: '其他',     item_name: '其它' },
  ];

  test('★★ 固定加費與一次性費用兩邊都要有', () => {
    // 使用者:「固定加費 一次性費用都加入喔」。
    // 只加一邊的話,同一種費用在兩張表裡會歸到不同科目 —— 而且不會報錯
    for (const n of need) {
      for (const [name, list] of [['固定加費', CONTRACT_FEE_PRESETS], ['一次性', ONEOFF_PRESETS]] as const) {
        const hit = list.find((p) => p.label === n.label);
        assert.ok(hit, `${name}缺少「${n.label}」`);
        assert.equal(hit.fee_type, n.fee_type, `${name}「${n.label}」的科目`);
        assert.equal(hit.item_name, n.item_name, `${name}「${n.label}」的項目`);
      }
    }
  });

  test('★★ 電費的科目是「水電瓦斯」不是「電費」', () => {
    // account_codes 裡只有 utility 水電瓦斯 —— 水電瓦斯在會計上是同一格。
    // 記成「電費」的話跟那張表對不起來
    assert.equal(presetOf('電費')?.fee_type, '水電瓦斯');
  });

  test('★ 科目要在 FEE_TYPES 裡，不然選單選不到', () => {
    for (const p of [...CONTRACT_FEE_PRESETS, ...ONEOFF_PRESETS]) {
      assert.ok(
        (FEE_TYPES as readonly string[]).includes(p.fee_type) ||
        (ONEOFF_ONLY_FEE_TYPES as readonly string[]).includes(p.fee_type),
        `「${p.label}」的科目「${p.fee_type}」不在清單裡`,
      );
    }
  });

  test('★ 「其它」永遠排最後 —— 它是保底不是分類', () => {
    assert.equal(CONTRACT_FEE_PRESETS[CONTRACT_FEE_PRESETS.length - 1].label, '其它');
    assert.equal(ONEOFF_PRESETS[ONEOFF_PRESETS.length - 1].label, '其它');
  });

  test('★ 一次性才有保證金，固定加費不可以有', () => {
    // 每個月自動產生的保證金在會計上講不通 —— 那個選項存在本身就是在邀請人填錯
    assert.ok(ONEOFF_PRESETS.some((p) => p.label === '保證金'));
    assert.ok(!CONTRACT_FEE_PRESETS.some((p) => p.label === '保證金'));
  });

  test('label 找不到就回 null，不要猜一個最像的', () => {
    assert.equal(presetOf('不存在的東西'), null);
  });

  test('★ label 不可以重複 —— 重複的話 presetOf 只會回第一個', () => {
    for (const list of [CONTRACT_FEE_PRESETS, ONEOFF_PRESETS]) {
      const labels = list.map((p) => p.label);
      assert.equal(new Set(labels).size, labels.length, `重複的 label：${labels}`);
    }
  });
});

describe('改用 presets 之後不可以少掉原本選得到的科目', () => {
  test('★★ FEE_TYPES 裡的每個科目，presets 都要有辦法選到', () => {
    /*
     * 短租加費原本是直接列 FEE_TYPES,改成 presets 之後
     * 沒有 preset 的科目就**選不到了** —— 那是功能倒退,
     * 而且不會報錯,只會讓人退而選一個最像的。
     *
     * 水費／電費／瓦斯費三個是刻意的例外:它們被水電瓦斯取代,
     * 舊資料還在用所以留在 FEE_TYPES,但不該再新增。
     */
    const 取代掉的 = ['水費', '電費', '瓦斯費', '網路費'];
    const 選得到 = new Set(ONEOFF_PRESETS.map((p) => p.fee_type));
    for (const t of FEE_TYPES) {
      if (取代掉的.includes(t)) continue;
      assert.ok(選得到.has(t), `科目「${t}」在 presets 裡選不到`);
    }
  });

  test('★ 清潔費與修繕費要有「沒有項目」的選項', () => {
    for (const t of ['清潔費', '修繕費']) {
      assert.ok(
        ONEOFF_PRESETS.some((p) => p.fee_type === t && p.item_name === null),
        `「${t}」少了不帶項目的選項`,
      );
    }
  });
});

describe('運費（2026-08-19 新增）', () => {
  test('★ 科目與預設都要有 —— 只加一邊會安靜地歸錯科目', () => {
    /*
     * 資料庫的 order_account_code() 也要有 '運費' → 'freight'（migration_148）。
     * 只加前端的話，那筆收入在營收報表上會掉進「其他」——
     * 金額對、名目對，只有分組錯，沒有人會發現。
     */
    assert.ok((FEE_TYPES as readonly string[]).includes('運費'));
    assert.deepEqual(presetOf('運費', CONTRACT_FEE_PRESETS), { fee_type: '運費', item_name: null });
    assert.deepEqual(presetOf('運費'), { fee_type: '運費', item_name: null });
  });

  test('「其他」還是排最後', () => {
    assert.equal(FEE_TYPES[FEE_TYPES.length - 1], '其他');
    assert.equal(ONEOFF_PRESETS[ONEOFF_PRESETS.length - 1].label, '其它');
  });
});
