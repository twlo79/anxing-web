import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { settleLines, settleGrid, rocRange, SHORT_SOURCES, type SettleRow } from './revenue-settle.ts';
import { FEE_TYPES } from './fee-types.ts';

const R = (o: Partial<SettleRow> = {}): SettleRow => ({
  source: 'longterm', estate_name: '時兆', fee_type: null, month_amount: 1000, ...o,
});
const find = (ls: ReturnType<typeof settleLines>, label: string) =>
  ls.find((l) => l.label === label);

describe('settleLines —— 每個物業一塊', () => {
  test('長租與短租分開', () => {
    const ls = settleLines([
      R({ month_amount: 63222 }),
      R({ source: 'airbnb', month_amount: 500000 }),
      R({ source: 'agoda', month_amount: 100000 }),
      R({ source: 'private', month_amount: 69246 }),
    ]);
    assert.equal(find(ls, '長租')!.amount, 63222);
    assert.equal(find(ls, '短租')!.amount, 669246);
  });

  test('短租就是那三個平台', () => {
    assert.deepEqual([...SHORT_SOURCES], ['airbnb', 'agoda', 'private']);
  });

  /*
   * ★★★ 這是整支最重要的一條（2026-09-02 使用者選「系統裡全部都列」）。
   *
   *   只列有金額的話，八月 9 列、九月 7 列 —— 而這份表是拿來
   *   **橫向比對月份**的，同一個位置的兩個數字就不是同一個科目了。
   */
  test('★★★ 其他收入的每一個科目都列，沒金額的寫 0', () => {
    const ls = settleLines([R({ source: 'oneoff', fee_type: '管理費', month_amount: 4567 })]);
    const items = ls.filter((l) => l.label.startsWith('其他收入・'));
    assert.equal(items.length, FEE_TYPES.length, '科目數要跟 FEE_TYPES 一樣多');
    assert.equal(find(ls, '其他收入・管理費・—')!.amount, 4567);
    assert.equal(find(ls, '其他收入・修繕費・—')!.amount, 0);
  });

  // ★ 科目清單直接吃 lib/fee-types —— 今天才加的「稅費」要自動出現
  test('★ 新加的科目自動跟上（稅費）', () => {
    const ls = settleLines([R({ source: 'oneoff', fee_type: '稅費', month_amount: 88 })]);
    assert.equal(find(ls, '其他收入・稅費・—')!.amount, 88);
  });

  test('順序固定：長租 → 短租 → 其他收入照 FEE_TYPES', () => {
    const ls = settleLines([R()]);
    const labels = ls.filter((l) => l.kind === 'item').map((l) => l.label);
    assert.equal(labels[0], '長租');
    assert.equal(labels[1], '短租');
    assert.deepEqual(labels.slice(2), FEE_TYPES.map((f) => `其他收入・${f}・—`));
  });

  /*
   * ★★★ 小計用整個物業的總和算，不是把上面那幾列加起來 ——
   *   任何一種沒被列到的來源才浮得出來，而不是安靜地消失。
   */
  test('★★★ 小計 = 這個物業的全部，含沒被上面列到的來源', () => {
    const ls = settleLines([
      R({ month_amount: 100 }),
      R({ source: '某種還沒支援的來源', month_amount: 7 }),
    ]);
    assert.equal(find(ls, '小計')!.amount, 107);
    // 長租只有 100 —— 那 7 塊沒有出現在任何一個分類列上，但小計看得到
    assert.equal(find(ls, '長租')!.amount, 100);
  });

  test('★★ 認不得的科目有地方去，不會消失', () => {
    const ls = settleLines([
      R({ source: 'oneoff', fee_type: '古怪科目', month_amount: 55 }),
    ]);
    assert.equal(find(ls, '其他收入・（科目不在清單裡）・—')!.amount, 55);
    assert.equal(find(ls, '小計')!.amount, 55);
  });

  test('科目空的算成「其他」', () => {
    const ls = settleLines([R({ source: 'oneoff', fee_type: null, month_amount: 9 })]);
    assert.equal(find(ls, '其他收入・其他・—')!.amount, 9);
  });

  test('多個物業各一塊，照 sort 排', () => {
    const order = (e: string) => ({ 正隆: 0, 時兆: 1 } as Record<string, number>)[e] ?? 99;
    const ls = settleLines([
      R({ estate_name: '時兆', month_amount: 1 }),
      R({ estate_name: '正隆', month_amount: 2 }),
    ], order);
    assert.deepEqual(ls.filter((l) => l.kind === 'estate').map((l) => l.label), ['正隆', '時兆']);
  });

  test('沒有物業的歸「無物業」', () => {
    const ls = settleLines([R({ estate_name: null })]);
    assert.equal(ls.find((l) => l.kind === 'estate')!.label, '無物業');
  });

  /*
   * ★★ 辦公室租金與公司登記不掛物業，自成兩塊排最後 ——
   *   少了它們總計就跟畫面上的「當期營收總額」對不起來。
   */
  test('★★ 辦公室與公司登記自成一塊', () => {
    const ls = settleLines([
      R({ month_amount: 100 }),
      R({ source: 'office', estate_name: null, month_amount: 30 }),
      R({ source: 'company', estate_name: null, month_amount: 20 }),
    ]);
    assert.deepEqual(ls.filter((l) => l.kind === 'estate').map((l) => l.label),
      ['時兆', '辦公室租金', '公司登記']);
    assert.equal(find(ls, '總計')!.amount, 150);
  });

  test('沒有辦公室／公司登記時不長出空區塊', () => {
    const ls = settleLines([R()]);
    assert.equal(ls.filter((l) => l.kind === 'estate').length, 1);
  });

  test('★★★ 總計 = 全部列的總和', () => {
    const rows = [
      R({ month_amount: 100 }), R({ estate_name: '正隆', source: 'airbnb', month_amount: 200 }),
      R({ source: 'oneoff', fee_type: '清潔費', month_amount: 50 }),
      R({ source: 'office', estate_name: null, month_amount: 7 }),
    ];
    assert.equal(find(settleLines(rows), '總計')!.amount, 357);
  });

  test('金額是 null 當 0，不會變 NaN', () => {
    const ls = settleLines([R({ month_amount: null })]);
    assert.equal(find(ls, '小計')!.amount, 0);
  });

  // ★ 2026-09-02 每一列多了 estate 欄（settleMatrix 用它當鍵）
  test('空清單只回一列總計 0', () => {
    const ls = settleLines([]);
    assert.deepEqual(ls, [{ kind: 'total', label: '總計', amount: 0, estate: '' }]);
  });
});

describe('rocRange —— 民國年的表頭', () => {
  test('八月是 31 天', () => assert.equal(rocRange(2026, 8), '115年8月1日~115年8月31日'));
  test('九月是 30 天', () => assert.equal(rocRange(2026, 9), '115年9月1日~115年9月30日'));
  // ★ 閏年不自己判斷 —— Date.UTC(y, m, 0) 會處理
  test('二月與閏年', () => {
    assert.equal(rocRange(2026, 2), '115年2月1日~115年2月28日');
    assert.equal(rocRange(2024, 2), '113年2月1日~113年2月29日');
  });
  test('十二月不會跨年出錯', () => assert.equal(rocRange(2026, 12), '115年12月1日~115年12月31日'));
});

describe('settleGrid —— 一列一個分類、一欄一個物業', () => {
  const M = (o: Partial<SettleRow> = {}): SettleRow => ({
    source: 'longterm', estate_name: '時兆', fee_type: null, month_amount: 100, ...o,
  });
  const ord = (e: string) => ({ 正隆: 0, 時兆: 1, 開封: 2 } as Record<string, number>)[e] ?? 99;
  const row = (g: ReturnType<typeof settleGrid>, b: number, label: string) =>
    g.blocks[b].rows.find((r) => r.label === label)!;

  test('物業當欄，照 sort 排', () => {
    const g = settleGrid([{ label: '八月', rows: [
      M({ estate_name: '時兆' }), M({ estate_name: '正隆' }),
    ] }], ord);
    assert.deepEqual(g.estates, ['正隆', '時兆']);
    assert.deepEqual(row(g, 0, '長租').amounts, [100, 100]);
  });

  /*
   * ★★★ 欄位取所有月份的聯集 —— 八月有開封、七月沒有的話，
   *   七月那個區塊還是要有開封那一欄（寫 0）。
   *   不然兩個區塊的欄位錯開，同一欄上下兩個數字就不是同一棟。
   */
  test('★★★ 某個月沒有的物業，那一欄還是在，寫 0', () => {
    const g = settleGrid([
      { label: '八月', rows: [M({ estate_name: '時兆' }), M({ estate_name: '開封' })] },
      { label: '七月', rows: [M({ estate_name: '時兆' })] },
    ], ord);
    assert.deepEqual(g.estates, ['時兆', '開封']);
    assert.deepEqual(row(g, 1, '長租').amounts, [100, 0], '七月的開封要是 0 不是消失');
  });

  test('短租是三個平台合起來', () => {
    const g = settleGrid([{ label: '八月', rows: [
      M({ source: 'airbnb', month_amount: 10 }),
      M({ source: 'agoda', month_amount: 20 }),
      M({ source: 'private', month_amount: 30 }),
    ] }]);
    assert.equal(row(g, 0, '短租').total, 60);
  });

  test('★★ 其他收入每個科目都有一列，沒金額寫 0', () => {
    const g = settleGrid([{ label: '八月', rows: [
      M({ source: 'oneoff', fee_type: '管理費', month_amount: 4567 }),
    ] }]);
    const items = g.blocks[0].rows.filter((r) => r.label.startsWith('其他收入・'));
    assert.equal(items.length, FEE_TYPES.length);
    assert.equal(row(g, 0, '其他收入・管理費・—').total, 4567);
    assert.equal(row(g, 0, '其他收入・修繕費・—').total, 0);
  });

  /*
   * ★★ 辦公室租金與公司登記不掛物業 —— 各自一欄，金額放在「長租」那一列。
   *   總計必須含它們，不然跟畫面上的「當期營收總額」對不起來。
   */
  test('★★ 辦公室與公司登記各一欄，排在最後', () => {
    const g = settleGrid([{ label: '八月', rows: [
      M({ estate_name: '時兆', month_amount: 100 }),
      M({ source: 'office', estate_name: null, month_amount: 30 }),
      M({ source: 'company', estate_name: null, month_amount: 20 }),
    ] }], ord);
    assert.deepEqual(g.estates, ['時兆', '辦公室租金', '公司登記']);
    assert.deepEqual(row(g, 0, '長租').amounts, [100, 30, 20]);
    assert.equal(row(g, 0, '小計').total, 150);
  });

  test('沒有辦公室／公司登記時不長出那兩欄', () => {
    const g = settleGrid([{ label: '八月', rows: [M()] }]);
    assert.deepEqual(g.estates, ['時兆']);
  });

  /*
   * ★★★ 小計用每一欄的總和算，不是把上面那幾列加起來 ——
   *   沒被認到的來源才浮得出來，而不是安靜消失。
   */
  test('★★★ 小計含沒被任何分類列認到的來源', () => {
    const g = settleGrid([{ label: '八月', rows: [
      M({ month_amount: 100 }),
      M({ source: '某種還沒支援的來源', month_amount: 7 }),
    ] }]);
    assert.equal(row(g, 0, '長租').total, 100);
    assert.equal(row(g, 0, '小計').total, 107);
  });

  test('★ 認不得的科目只有真的出現時才加那一列', () => {
    const a = settleGrid([{ label: '八月', rows: [M()] }]);
    assert.equal(a.blocks[0].rows.some((r) => r.label.includes('不在清單裡')), false);
    const b = settleGrid([{ label: '八月', rows: [
      M({ source: 'oneoff', fee_type: '古怪科目', month_amount: 55 }),
    ] }]);
    assert.equal(row(b, 0, '其他收入・（科目不在清單裡）・—').total, 55);
  });

  test('每個月一個區塊，順序照傳進來的', () => {
    const g = settleGrid([
      { label: '八月', rows: [M({ month_amount: 100 })] },
      { label: '七月', rows: [M({ month_amount: 200 })] },
    ]);
    assert.deepEqual(g.blocks.map((b) => b.label), ['八月', '七月']);
    assert.equal(row(g, 1, '長租').total, 200);
  });

  test('每個區塊的列數一樣 —— 上下對得起來', () => {
    const g = settleGrid([
      { label: '八月', rows: [M({ source: 'oneoff', fee_type: '管理費' })] },
      { label: '七月', rows: [M()] },
    ]);
    assert.equal(g.blocks[0].rows.length, g.blocks[1].rows.length);
  });

  test('金額 null 當 0，不會變 NaN', () => {
    const g = settleGrid([{ label: '八月', rows: [M({ month_amount: null })] }]);
    assert.equal(row(g, 0, '小計').total, 0);
  });

  test('沒有月份時回空的', () => {
    assert.deepEqual(settleGrid([]), { estates: [], blocks: [] });
  });
});
