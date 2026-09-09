import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  type RevRow, sum, classOf, skeleton, roomLines, reconcile,
  inEstateBlock, isOffice, isCompany, estateOf, ROOM_NONE, itemLabel, oneoffItems, ONEOFF_LABEL,
  isOneoffSource, rentOnly, oneoffLabel, isHkOffice, OFFICE_NAME,
} from './revenue-report.ts';

/**
 * 營收報表的測試。跑法:npm test
 *
 * 這支釘住兩件事:
 *   1. 三段(物業 / 辦公室 / 公司登記)相加必須等於總營收
 *   2. 列骨架取的是所有月份的聯集,不是單月各自長出來的
 *
 * 第 2 點是舊版總表最嚴重的問題:每個月各自展開標籤,月份之間的列會錯開,
 * 橫著讀同一列會拿到不同科目的數字。而且不會報錯。
 */

const r = (o: Partial<RevRow>): RevRow => ({
  source: 'airbnb', estate_name: '時兆', property_raw: 'A3',
  guest_name: null, month_amount: 0, ...o,
});

describe('三段分法', () => {
  test('辦公室與公司登記不算在物業段', () => {
    const rows = [
      r({ source: 'airbnb', month_amount: 100 }),
      r({ source: 'longterm', month_amount: 200 }),
      r({ source: 'oneoff', month_amount: 50 }),
      r({ source: 'office', estate_name: null, guest_name: '○○公司', month_amount: 300 }),
      r({ source: 'company', estate_name: null, guest_name: '××科技', month_amount: 40 }),
    ];
    assert.equal(sum(rows, inEstateBlock), 350);
    assert.equal(sum(rows, isOffice), 300);
    assert.equal(sum(rows, isCompany), 40);
  });

  test('三段相加等於總營收 —— 內建的對帳點', () => {
    const rows = [
      r({ source: 'airbnb', month_amount: 100 }),
      r({ source: 'agoda', month_amount: 33 }),
      r({ source: 'private', month_amount: 7 }),
      r({ source: 'longterm', month_amount: 200 }),
      r({ source: 'oneoff', month_amount: 50 }),
      r({ source: 'other', month_amount: 1 }),
      r({ source: 'office', month_amount: 300 }),
      r({ source: 'company', month_amount: 40 }),
    ];
    assert.equal(reconcile(rows), null, '沒有任何來源可以掉出三段之外');
    assert.equal(sum(rows), 731);
  });

  test('新增一種來源時對帳會失敗,不會安靜地少算', () => {
    // inEstateBlock 是「扣掉 office 與 company 的其餘全部」,
    // 寫成白名單的話,將來多一種來源就會從三段之間掉出去而沒人發現。
    const rows = [r({ source: '未來才有的來源', month_amount: 999 })];
    assert.equal(reconcile(rows), null);
    assert.equal(sum(rows, inEstateBlock), 999);
  });
});

describe('金額', () => {
  test('numeric 從 Supabase 回來是字串,也要能加', () => {
    const rows = [r({ month_amount: '1200.4' }), r({ month_amount: '800.6' })];
    assert.equal(sum(rows), 2001);
  });

  test('空值當 0,不要變成 NaN 汙染整欄', () => {
    const rows = [r({ month_amount: 100 }), r({ month_amount: null as any })];
    assert.equal(sum(rows), 100);
  });
});

describe('列骨架取所有月份的聯集', () => {
  const eSort = (a: string, b: string) => a.localeCompare(b);

  test('某個月沒有的物業,骨架裡仍然要有', () => {
    // 7 月有亞曼尼、8 月沒有。舊版 8 月那一欄不會長出亞曼尼這一列,
    // 底下所有列往上推一格,跟 7 月就對不齊了。
    const july = [r({ estate_name: '時兆', month_amount: 100 }), r({ estate_name: '亞曼尼', month_amount: 50 })];
    const aug = [r({ estate_name: '時兆', month_amount: 120 })];
    const sk = skeleton([...july, ...aug], eSort);
    assert.deepEqual(sk.estates, ['亞曼尼', '時兆']);
    // 8 月的亞曼尼是 0,不是「這一列不存在」
    assert.equal(sum(aug, (x) => inEstateBlock(x) && estateOf(x) === '亞曼尼'), 0);
  });

  test('沒有物業的列歸到「無物業」,不能消失', () => {
    const sk = skeleton([r({ estate_name: null, month_amount: 10 })], eSort);
    assert.deepEqual(sk.estates, ['無物業']);
  });

  test('辦公室與公司登記依客戶展開,各自成段', () => {
    const rows = [
      r({ source: 'office', guest_name: 'B 工作室', month_amount: 1 }),
      r({ source: 'office', guest_name: 'A 公司', month_amount: 2 }),
      r({ source: 'company', guest_name: 'C 科技', month_amount: 3 }),
    ];
    const sk = skeleton(rows, eSort);
    assert.deepEqual(sk.offices, ['A 公司', 'B 工作室']);
    assert.deepEqual(sk.companies, ['C 科技']);
    assert.deepEqual(sk.estates, [], '這三筆都不該進物業段');
  });
});

describe('房源分類', () => {
  test('短租是三個平台的小計', () => {
    assert.equal(classOf(r({ source: 'airbnb' })), '短租');
    assert.equal(classOf(r({ source: 'agoda' })), '短租');
    assert.equal(classOf(r({ source: 'private' })), '短租');
    assert.equal(classOf(r({ source: 'longterm' })), '長租');
    assert.equal(classOf(r({ source: 'oneoff' })), ONEOFF_LABEL);
    assert.equal(classOf(r({ source: 'other' })), '其他');
  });

  test('同一間房同月有長租又有一次性,要拆成兩列', () => {
    const rows = [
      r({ estate_name: '時兆', property_raw: 'A8', source: 'longterm', month_amount: 38000 }),
      r({ estate_name: '時兆', property_raw: 'A8', source: 'oneoff', month_amount: 1200 }),
    ];
    const lines = roomLines(rows, '時兆');
    assert.equal(lines.length, 2, '合成一列就看不出組成');
    // ★ 2026-09-02 起「項目沒填」不再補破折號 —— 科目沒填才寫 —
    assert.deepEqual(lines.map((l) => l.cls).sort(), [`${ONEOFF_LABEL}・—`, '長租']);
  });

  test('一次性收入依項目再拆一層', () => {
    // 洗衣機、烘衣機、垃圾代收費的會計科目都是「清潔費」。
    // 不依項目拆的話,報表上就是一格清潔費,看不出哪一項在賺。
    const rows = [
      r({ estate_name: '時兆', property_raw: null, source: 'oneoff', fee_type: '清潔費', item_name: '洗衣機', month_amount: 2150 }),
      r({ estate_name: '時兆', property_raw: null, source: 'oneoff', fee_type: '清潔費', item_name: '烘衣機', month_amount: 3550 }),
      r({ estate_name: '時兆', property_raw: null, source: 'oneoff', fee_type: '清潔費', item_name: '垃圾代收費', month_amount: 5070 }),
    ];
    const lines = roomLines(rows, '時兆');
    assert.equal(lines.length, 3, '三個項目要各自成列');
    assert.deepEqual(lines.map((l) => l.cls).sort(),
      [`${ONEOFF_LABEL}・清潔費・垃圾代收費`, `${ONEOFF_LABEL}・清潔費・洗衣機`,
       `${ONEOFF_LABEL}・清潔費・烘衣機`].sort());
  });

  /*
   * ★★ 2026-09-02 使用者:「一次性費用 為何後面有空」。
   *
   *   原本項目沒填也補一個破折號，於是多數列長成「其他收入・管理費・—」——
   *   而那個破折號不帶訊息:管理費本來就沒有細項。
   *
   * ★ 但**科目**沒填還是要寫 —— 那是異常（一次性收入沒有會計科目），
   *   跟「項目沒填」的意義不一樣。下面兩條就是在釘這個差別。
   */
  test('項目沒填不補破折號,科目沒填要補', () => {
    assert.equal(itemLabel(r({ source: 'oneoff', fee_type: null, item_name: null })), `${ONEOFF_LABEL}・—`);
    assert.equal(itemLabel(r({ source: 'oneoff', fee_type: '清潔費', item_name: null })), `${ONEOFF_LABEL}・清潔費`);
    assert.equal(itemLabel(r({ source: 'oneoff', fee_type: '清潔費', item_name: '洗衣機' })), `${ONEOFF_LABEL}・清潔費・洗衣機`);
    // 科目與項目只對一次性有意義,其餘來源不該被加尾巴
    assert.equal(itemLabel(r({ source: 'longterm', fee_type: '清潔費', item_name: 'x' })), '長租');
  });

  test('依「科目・項目」彙總,金額大到小', () => {
    const rows = [
      r({ source: 'oneoff', fee_type: '清潔費', item_name: '洗衣機', month_amount: 100 }),
      r({ source: 'oneoff', fee_type: '清潔費', item_name: '洗衣機', month_amount: 50 }),
      r({ source: 'oneoff', fee_type: '清潔費', item_name: '垃圾代收費', month_amount: 5070 }),
      r({ source: 'oneoff', fee_type: null, item_name: null, month_amount: 7 }),
      r({ source: 'airbnb', fee_type: '清潔費', item_name: '不該被算到', month_amount: 9999 }),
    ];
    assert.deepEqual(oneoffItems(rows), [
      { item: '清潔費・垃圾代收費', amount: 5070 },
      { item: '清潔費・洗衣機', amount: 150 },
      { item: '—', amount: 7 },
    ]);
  });

  test('同科目不同項目不能被併在一起', () => {
    // 洗衣機與烘衣機的科目都是清潔費。只用科目分組會併成一格,
    // 那正是這一層存在的理由。
    const rows = [
      r({ source: 'oneoff', fee_type: '清潔費', item_name: '洗衣機', month_amount: 2150 }),
      r({ source: 'oneoff', fee_type: '清潔費', item_name: '烘衣機', month_amount: 3550 }),
    ];
    assert.equal(oneoffItems(rows).length, 2);
  });

  test('房號空白要單獨成一列,不能整筆不見', () => {
    // 空白有兩種意思:刻意算在整棟上,或真的漏填。分不出來,所以兩個都寫。
    const lines = roomLines([r({ property_raw: null, month_amount: 5 })], '時兆');
    assert.deepEqual(lines, [{ room: ROOM_NONE, cls: '短租' }]);
    assert.equal(ROOM_NONE, '—', '表格裡空值一律破折號');
  });
});

/*
 * ── 去除一次性收入（2026-08-25）──────────────────────
 */
test('isOneoffSource：oneoff 與 airbnb_cancelled 都算', () => {
  assert.equal(isOneoffSource('oneoff'), true);
  assert.equal(isOneoffSource('airbnb_cancelled'), true);
});

test('★ other 不算 —— 那是會計科目，不是來源', () => {
  assert.equal(isOneoffSource('other'), false);
});

test('房租那幾種都不算', () => {
  for (const s of ['longterm', 'airbnb', 'agoda', 'private', 'office', 'company']) {
    assert.equal(isOneoffSource(s), false, s);
  }
});

test('null / undefined / 空字串不算（不要把認不出來的當成一次性扣掉）', () => {
  assert.equal(isOneoffSource(null), false);
  assert.equal(isOneoffSource(undefined), false);
  assert.equal(isOneoffSource(''), false);
});

test('rentOnly：關閉時原封不動', () => {
  const rows = [{ source: 'oneoff' }, { source: 'longterm' }];
  assert.equal(rentOnly(rows, false), rows);
});

test('rentOnly：打開時濾掉一次性', () => {
  const rows = [{ source: 'oneoff' }, { source: 'longterm' }, { source: 'airbnb_cancelled' }];
  assert.deepEqual(rentOnly(rows, true), [{ source: 'longterm' }]);
});

test('rentOnly：全部都是一次性時回空陣列，不是 undefined', () => {
  assert.deepEqual(rentOnly([{ source: 'oneoff' }], true), []);
});


// ── 一次性收入的標籤：科目與項目不要重複（2026-09-09）────────

describe('oneoffLabel —— 項目本身就以科目開頭時不重印', () => {
  const R = (fee: string | null, item: string | null) =>
    ({ source: 'oneoff', fee_type: fee, item_name: item } as unknown as RevRow);

  test('★★★ 房務清潔：項目已經帶科目，不要變成「房務清潔・房務清潔 14B3」', () => {
    assert.equal(oneoffLabel(R('房務清潔', '房務清潔 14B3')), '房務清潔 14B3');
  });

  test('★★ 人事費同理', () => {
    assert.equal(oneoffLabel(R('人事費', '人事費 正隆')), '人事費 正隆');
  });

  test('項目跟科目一模一樣時只印一次', () => {
    assert.equal(oneoffLabel(R('房務清潔', '房務清潔')), '房務清潔');
  });

  test('★ 一般的一次性收入照舊拼「科目・項目」', () => {
    assert.equal(oneoffLabel(R('清潔費', '洗衣機')), '清潔費・洗衣機');
  });

  test('★★ 只是開頭幾個字剛好相同不算 —— 要整個詞加空白才算', () => {
    // 「清潔費用分攤」不是以「清潔費 」開頭，該照舊拼
    assert.equal(oneoffLabel(R('清潔費', '清潔費用分攤')), '清潔費・清潔費用分攤');
  });

  test('沒有項目時只印科目，不留「・」的尾巴', () => {
    assert.equal(oneoffLabel(R('管理費', null)), '管理費');
    assert.equal(oneoffLabel(R('管理費', '   ')), '管理費');
  });
});

// ── 收入的「用途」軸（migration_235）─────────────────────

describe('★★★ purpose_type：這筆收入掛不掛物業', () => {
  const R = (o: Partial<RevRow>): RevRow => ({
    source: 'oneoff', estate_name: null, property_raw: null, guest_name: '時兆',
    month_amount: 730, ...o,
  } as RevRow);

  test('★★★ 有 purpose_type 就看它，不再列舉 source', () => {
    assert.equal(inEstateBlock(R({ purpose_type: 'estate' })), true);
    assert.equal(inEstateBlock(R({ purpose_type: 'office' })), false);
  });

  test('★★★ 沒有 purpose_type 的舊資料退回舊判斷，答案一樣', () => {
    /*
     * 前端先上線、migration 還沒跑的那幾分鐘會走這條路。
     * 兩條路對既有資料必須算出同一個答案，否則兩種環境的營收會不同。
     */
    assert.equal(inEstateBlock(R({ source: 'airbnb' })), true);
    assert.equal(inEstateBlock(R({ source: 'office' })), false);
    assert.equal(inEstateBlock(R({ source: 'company' })), false);
    assert.equal(inEstateBlock(R({ source: 'oneoff' })), true);   // 舊行為
  });

  test('★★★ 辦公室出租與房務收入是兩個東西 —— 只有後者算房務', () => {
    /*
     * source='office'（辦公室出租）跟 purpose_type='office'（安幸辦公室）
     * 名字撞在一起。兩者的 purpose_type 都是 office（都不掛物業），
     * 但區塊要分開，不然同一筆錢會被算進兩段。
     */
    assert.equal(isHkOffice(R({ source: 'oneoff', purpose_type: 'office' })), true);
    assert.equal(isHkOffice(R({ source: 'office', purpose_type: 'office' })), false);
    assert.equal(isHkOffice(R({ source: 'company', purpose_type: 'office' })), false);
  });

  test('★★★ 四段相加要等於總營收 —— 房務收入不補進去會差一截', () => {
    const rows = [
      R({ source: 'airbnb', purpose_type: 'estate', estate_name: '正隆', month_amount: 1000 }),
      R({ source: 'office', purpose_type: 'office', month_amount: 200 }),
      R({ source: 'company', purpose_type: 'office', month_amount: 300 }),
      R({ source: 'oneoff', purpose_type: 'office', month_amount: 730 }),   // 房務收入
    ];
    assert.equal(reconcile(rows), null, '四段沒蓋滿 —— 對帳會出現差額');
  });

  test('★★ 安幸辦公室的物業欄寫「安幸辦公室」，不是「無物業」', () => {
    // 它有明確的歸屬，只是那個歸屬不是一棟樓。寫「無物業」看起來像漏填
    assert.equal(estateOf(R({ purpose_type: 'office' })), OFFICE_NAME);
    assert.equal(estateOf(R({ purpose_type: 'estate' })), '無物業');
  });

  test('★★ 房務收入依付錢的物業分列（客戶欄）', () => {
    const sk = skeleton([
      R({ source: 'oneoff', purpose_type: 'office', guest_name: '正隆' }),
      R({ source: 'oneoff', purpose_type: 'office', guest_name: '時兆' }),
      R({ source: 'airbnb', purpose_type: 'estate', estate_name: '正隆' }),
    ], (a, b) => a.localeCompare(b));
    assert.deepEqual(sk.hkPayers, ['時兆', '正隆'].sort((a, b) => a.localeCompare(b)));
    // ★ 房務那幾筆不可以同時出現在物業段
    assert.deepEqual(sk.estates, ['正隆']);
  });
});
