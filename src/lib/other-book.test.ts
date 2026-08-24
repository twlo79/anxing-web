import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  signed, totals, pctChange, byMonth, byCode, unsettled,
  applyFilters, monthRange, prevMonth, type Entry,
} from './other-book.ts';

/**
 * 這裡每一條算式都是儀錶板上的數字。
 * 算錯不會報錯 —— 只會有一個看起來很合理但不對的數字。
 */

const e = (o: Partial<Entry>): Entry => ({
  id: 'x', kind: 'income', date: '2026-08-10', name: '團費',
  account_code: 'ap_tour', party: null, amount: 1000, note: null, settled: true,
  ...o,
});

describe('正負號與合計', () => {
  test('★ 收入為正、支出為負', () => {
    assert.equal(signed(e({ kind: 'income', amount: 1000 })), 1000);
    assert.equal(signed(e({ kind: 'expense', amount: 1000 })), -1000);
  });

  test('★★ 支出存的是正數，淨額才減 —— 存負數會被減兩次', () => {
    const t = totals([
      e({ kind: 'income', amount: 5000 }),
      e({ kind: 'expense', amount: 2000 }),
    ]);
    assert.deepEqual(t, { income: 5000, expense: 2000, net: 3000 });
  });

  test('空的回三個 0，不是 null', () => {
    assert.deepEqual(totals([]), { income: 0, expense: 0, net: 0 });
  });

  test('淨額可以是負的 —— 不要夾在 0 以上', () => {
    // 夾住的話「這個月虧錢」會顯示成「打平」
    assert.equal(totals([e({ kind: 'expense', amount: 500 })]).net, -500);
  });
});

describe('跟上月比', () => {
  test('★★ 上個月是 0 要回 null，不要回 100% 或 Infinity', () => {
    /*
     * 「從 0 變成 5 萬」不是成長 100%，是「上個月沒有資料」——
     * 印一個百分比等於編一個看起來很有意義的數字。
     */
    assert.equal(pctChange(50000, 0), null);
    assert.equal(pctChange(0, 0), null);
  });

  test('正常增減', () => {
    assert.equal(pctChange(110, 100), 10);
    assert.equal(pctChange(90, 100), -10);
  });

  test('★ 上月是負數時用絕對值當分母', () => {
    // 不取絕對值的話，虧損縮小會顯示成負成長
    assert.equal(pctChange(-50, -100), 50);
  });
});

describe('按月分組', () => {
  test('★★ 沒有資料的月份要補 0，不能跳過', () => {
    /*
     * 跳過的話長條圖上 3 月接著 7 月，看起來像連續的四個月 ——
     * 而中間那三個月的「沒有生意」正是最該看到的訊息。
     */
    const m = byMonth([e({ date: '2026-08-05' })], '2026-08', 3);
    assert.deepEqual(m.map((x) => x.ym), ['2026-06', '2026-07', '2026-08']);
    assert.deepEqual(m.map((x) => x.income), [0, 0, 1000]);
  });

  test('★ 跨年要退到 12 月', () => {
    const m = byMonth([], '2026-01', 3);
    assert.deepEqual(m.map((x) => x.ym), ['2025-11', '2025-12', '2026-01']);
  });

  test('收入與支出分開累加', () => {
    const m = byMonth([
      e({ date: '2026-08-01', kind: 'income', amount: 300 }),
      e({ date: '2026-08-02', kind: 'expense', amount: 100 }),
    ], '2026-08', 1);
    assert.deepEqual(m[0], { ym: '2026-08', income: 300, expense: 100 });
  });
});

describe('按科目分組', () => {
  const nameOf = (c: string | null) => ({ a: '團費', b: '佣金', c: '簽證' }[c ?? ''] ?? '未分類');

  test('金額由大到小', () => {
    const r = byCode([
      e({ account_code: 'a', amount: 100 }),
      e({ account_code: 'b', amount: 300 }),
    ], 'income', nameOf);
    assert.deepEqual(r.map((x) => x.name), ['佣金', '團費']);
  });

  test('★ 超過 top 的併成「其他 N 項」', () => {
    // 列十七個科目的話前三名反而被淹沒
    const rows = ['a', 'b', 'c', 'd', 'e'].map((c, i) => e({ account_code: c, amount: (5 - i) * 100 }));
    const r = byCode(rows, 'income', () => 'x', 2);
    assert.equal(r.length, 3);
    assert.equal(r[2].name, '其他 3 項');
    assert.equal(r[2].amount, 300 + 200 + 100);
  });

  test('★ 只算指定的那一種', () => {
    const r = byCode([
      e({ kind: 'income', amount: 100 }),
      e({ kind: 'expense', amount: 999 }),
    ], 'income', nameOf);
    assert.equal(r.reduce((a, x) => a + x.amount, 0), 100);
  });

  test('科目是 null 的歸「未分類」，不要丟掉', () => {
    const r = byCode([e({ account_code: null, amount: 50 })], 'income', nameOf);
    assert.deepEqual(r, [{ name: '未分類', amount: 50 }]);
  });
});

describe('還沒收的錢', () => {
  test('★★ 只算收入 —— 支出是錢出去之後才產生的紀錄', () => {
    const r = unsettled([
      e({ kind: 'income', settled: false, amount: 3000 }),
      e({ kind: 'income', settled: true, amount: 9999 }),
      e({ kind: 'expense', settled: false, amount: 8888 }),
    ]);
    assert.deepEqual(r, { n: 1, amount: 3000 });
  });

  test('都收齊了回 0', () => {
    assert.deepEqual(unsettled([e({ settled: true })]), { n: 0, amount: 0 });
  });
});

describe('篩選', () => {
  const rows = [
    e({ id: '1', kind: 'income', name: '東京團', party: '王先生', account_code: 'a' }),
    e({ id: '2', kind: 'expense', name: '機票款', note: '長榮', account_code: 'b' }),
  ];

  test('類型', () => {
    assert.deepEqual(applyFilters(rows, { kind: 'income' }).map((x) => x.id), ['1']);
  });

  test('科目', () => {
    assert.deepEqual(applyFilters(rows, { code: 'b' }).map((x) => x.id), ['2']);
  });

  test('★★ 關鍵字要比對項目、對象、備註三欄', () => {
    /*
     * 只比項目名的話，使用者記得的常常是廠商名字
     * 而不是當初怎麼寫的品項。
     */
    assert.deepEqual(applyFilters(rows, { kw: '王先生' }).map((x) => x.id), ['1']);   // 對象
    assert.deepEqual(applyFilters(rows, { kw: '長榮' }).map((x) => x.id), ['2']);     // 備註
    assert.deepEqual(applyFilters(rows, { kw: '東京' }).map((x) => x.id), ['1']);     // 項目
  });

  test('沒有條件就全部回', () => {
    assert.equal(applyFilters(rows, {}).length, 2);
  });

  test('日期範圍（含頭尾）', () => {
    const r = applyFilters([e({ date: '2026-08-01' }), e({ date: '2026-08-31' })],
      { from: '2026-08-01', to: '2026-08-31' });
    assert.equal(r.length, 2);
  });
});

describe('月份工具', () => {
  test('★ 月底要對 —— 2 月與 31 天的月份都不能算錯', () => {
    assert.deepEqual(monthRange('2026-02'), { from: '2026-02-01', to: '2026-02-28' });
    assert.deepEqual(monthRange('2026-08'), { from: '2026-08-01', to: '2026-08-31' });
    assert.deepEqual(monthRange('2026-04'), { from: '2026-04-01', to: '2026-04-30' });
  });

  test('★ 閏年', () => {
    assert.equal(monthRange('2028-02').to, '2028-02-29');
  });

  test('★ 上個月跨年', () => {
    assert.equal(prevMonth('2026-01'), '2025-12');
    assert.equal(prevMonth('2026-08'), '2026-07');
  });
});
