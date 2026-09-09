import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  isFilled, isComplete, validateDemand, estateIdToSave, newItemRow,
  type DemandItemLike, type DemandItemDraft,
} from './demand.ts';

const estate = (name = '衛生紙', id = 'e1'): DemandItemLike =>
  ({ item_name: name, purpose_type: 'estate', estate_id: id });
const office = (name = '碳粉匣'): DemandItemLike =>
  ({ item_name: name, purpose_type: 'office', estate_id: '' });
const blank: DemandItemLike = { item_name: '', purpose_type: 'estate', estate_id: '' };

describe('isFilled', () => {
  test('全空的算沒填', () => assert.equal(isFilled(blank), false));
  test('只有空白字元也算沒填', () =>
    assert.equal(isFilled({ ...blank, item_name: '   ' }), false));
  test('只打了品名就算有填', () =>
    assert.equal(isFilled({ ...blank, item_name: '衛生紙' }), true));
  test('只選了物業就算有填', () =>
    assert.equal(isFilled({ ...blank, estate_id: 'e1' }), true));

  test('★★★ 只選了安幸辦公室也算有填', () => {
    /*
     * 這一條是這支檔案存在的理由之一。
     * 舊的判斷只看 estate_id,而 office 的 estate_id 永遠是空字串 ——
     * 那一列會被當成空白列**默默丟掉**,而使用者以為自己填了。
     */
    assert.equal(isFilled({ ...blank, purpose_type: 'office' }), true);
  });
});

describe('isComplete', () => {
  test('物業:品名 ＋ 物業都有才算完整', () => {
    assert.equal(isComplete(estate()), true);
    assert.equal(isComplete({ ...estate(), estate_id: '' }), false);
    assert.equal(isComplete({ ...estate(), item_name: '' }), false);
  });

  test('★★★ 辦公室:不用選物業', () => {
    // 沿用舊的 `!estate_id` 判斷的話,選了辦公室永遠過不了
    assert.equal(isComplete(office()), true);
  });

  test('辦公室還是要有品名', () =>
    assert.equal(isComplete({ ...office(), item_name: '' }), false));

  test('品名只有空白不算', () =>
    assert.equal(isComplete({ ...office(), item_name: '  ' }), false));
});

describe('validateDemand', () => {
  test('一切正常回 null', () =>
    assert.equal(validateDemand([estate()], '正隆'), null));

  test('全是空白列 → 至少要填一個', () =>
    assert.match(validateDemand([blank, blank], '正隆')!, /至少要填一個/));

  test('沒有任何列 → 同上', () =>
    assert.match(validateDemand([], '正隆')!, /至少要填一個/));

  test('空白列會被忽略，不算「沒填完」', () => {
    // 表單預設就會多留一列空的 —— 那一列不該擋住送出
    assert.equal(validateDemand([estate(), blank], '正隆'), null);
  });

  test('★ 錯誤訊息要帶第幾項', () => {
    const items = [estate('衛生紙'), { ...estate(), item_name: '', estate_id: 'e2' }];
    assert.match(validateDemand(items, '正隆')!, /第 2 項/);
  });

  test('★ 編號算的是「有填的第幾項」，不是原始索引', () => {
    // 中間夾空白列時，說「第 3 項」而畫面上只看得到兩項會很困惑
    const items = [estate('衛生紙'), blank, { ...estate(), item_name: '' }];
    assert.match(validateDemand(items, '正隆')!, /第 2 項/);
  });

  test('沒選寄送地點', () => {
    assert.match(validateDemand([estate()], '')!, /寄送地點/);
    assert.match(validateDemand([estate()], null)!, /寄送地點/);
  });

  test('★★ 品名沒填的錯誤要排在寄送地點之前', () => {
    // 兩個都缺時先講項目 —— 那是使用者正在打的地方
    assert.match(validateDemand([{ ...estate(), item_name: '' }], '')!, /第 1 項/);
  });

  describe('★★★ 安幸辦公室（migration_186）', () => {
    test('只有辦公室那一項也能送', () =>
      assert.equal(validateDemand([office()], '安幸辦公室'), null));

    test('辦公室 ＋ 物業混在同一張單', () =>
      assert.equal(validateDemand([office(), estate()], '正隆'), null));

    test('辦公室沒打品名一樣要擋', () =>
      assert.match(validateDemand([{ ...office(), item_name: '' }], '正隆')!, /第 1 項/));
  });
});

describe('estateIdToSave', () => {
  test('物業回那個 id', () => assert.equal(estateIdToSave(estate()), 'e1'));

  test('★★★ 辦公室回 null，不是空字串', () => {
    /*
     * 空字串會被 Postgres 當成「一個叫做空字串的 uuid」而報型別錯誤;
     * 更糟的是留著上一次選的物業 —— 那會通過型別檢查,
     * 只被互斥約束擋下來,而萬一哪天約束被拿掉,
     * 報表會把那一筆同時算進辦公室與那個物業。
     */
    assert.equal(estateIdToSave(office()), null);
  });

  test('★ 辦公室即使 estate_id 還留著也回 null', () => {
    const dirty: DemandItemLike = { item_name: 'x', purpose_type: 'office', estate_id: 'e1' };
    assert.equal(estateIdToSave(dirty), null);
  });
});

// ── 新增時寫進去的那一列（2026-09-09）────────────────────

describe('★★★ newItemRow —— 表單收的每一欄都要寫進去', () => {
  const D = (o: Partial<DemandItemDraft> = {}): DemandItemDraft => ({
    item_name: ' 冷氣檔板 ', purpose_type: 'office', estate_id: '',
    spec: ' 2個 ', buy_link: ' https://www.momoshop.com.tw/abc ', ...o,
  });

  test('★★★ buy_link 要寫進去 —— 它從上線到現在一次都沒存過', () => {
    /*
     * 表單有輸入框、列表也有顯示「建議連結」的程式碼，
     * 中間的 insert 少寫了一行 —— 於是連結永遠是空的，
     * 而畫面上只是「沒有連結」，看起來像使用者沒填。
     * 2026-09-09 使用者:「沒顯示連結」。
     */
    assert.equal(newItemRow(D(), 'd1').buy_link, 'https://www.momoshop.com.tw/abc');
  });

  test('★★★ 表單收的四欄一個都不能少', () => {
    // 下次再加一欄，這一條會提醒你這裡也要加
    const r = newItemRow(D(), 'd1');
    for (const k of ['item_name', 'spec', 'buy_link', 'purpose_type', 'estate_id', 'demand_id']) {
      assert.ok(k in r, `少了 ${k}`);
    }
  });

  test('★★ 空字串一律寫 null —— 「沒填」只能有一種形狀', () => {
    const r = newItemRow(D({ spec: '   ', buy_link: '' }), 'd1');
    assert.equal(r.spec, null);
    assert.equal(r.buy_link, null);
  });

  test('★ 前後空白要去掉 —— 貼上網址常常帶一個空格', () => {
    assert.equal(newItemRow(D(), 'd1').item_name, '冷氣檔板');
    assert.equal(newItemRow(D(), 'd1').spec, '2個');
  });

  test('★★★ 安幸辦公室的 estate_id 一定是 null', () => {
    assert.equal(newItemRow(D({ purpose_type: 'office', estate_id: 'e1' }), 'd1').estate_id, null);
  });

  test('★★ 物業的 estate_id 照寫', () => {
    assert.equal(newItemRow(D({ purpose_type: 'estate', estate_id: 'e1' }), 'd1').estate_id, 'e1');
  });

  test('demand_id 要帶上', () => {
    assert.equal(newItemRow(D(), 'd-99').demand_id, 'd-99');
  });
});
