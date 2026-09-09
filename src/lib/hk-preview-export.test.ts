import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { previewExportText, type ExportLine } from './hk-preview-export.ts';
import type { PairResult } from './hk-pair-check.ts';

/**
 * 預覽導出。
 *
 * 【這支釘什麼】
 * 導出來的東西是拿去**對帳**的,所以三件事不能壞:
 *   ① 每一段都有小計 —— 沒有小計的話要自己加七十個數字
 *   ② 算不出金額的那幾份工要在裡面 —— 「不會產生」正是最該被看到的
 *   ③ 結論在最前面 —— 第一眼要看到有沒有問題，不是第一列是哪一間
 */

const OK: PairResult = {
  ok: true, expectCount: 2, actualCount: 2,
  expectAmount: 9730, actualAmount: 9730,
  cleanExpect: 2, cleanActual: 2, laborExpect: 0, laborActual: 0,
  issues: [],
};

const L = (o: Partial<ExportLine> = {}): ExportLine => ({
  date: '2026-08-01', estate: '時兆', room: 'A02', item: '房務清潔 A02',
  units: 1, price: 730, amount: 730, extra: '', ...o,
});

const base = {
  period: '2026-08', now: '2026-09-09', check: OK,
  clean: [L(), L({ date: '2026-08-02', room: 'A09', amount: 9000, price: 9000 })],
  labor: [], hour: [], income: [], unpriced: [],
};

describe('預覽導出', () => {
  test('★★ 結論在最前面 —— 前五行就要看得到通過與否', () => {
    const head = previewExportText(base).split('\n').slice(0, 5).join('\n');
    assert.match(head, /2026-08/);
    assert.match(head, /模擬檢查：✅ 通過/);
  });

  test('★ 導出時間要有 —— 一週後看到這段文字要知道它多舊', () => {
    assert.match(previewExportText(base), /導出於 2026-09-09/);
  });

  test('★★★ 每一段都有筆數與小計', () => {
    const t = previewExportText(base);
    assert.match(t, /## 清潔費支出（記在物業）\t?　2 筆　\$9,730/);
  });

  test('★★★ 沒過的時候要印出每一條問題', () => {
    const bad: PairResult = {
      ...OK, ok: false, actualCount: 1, actualAmount: 730,
      issues: [
        { level: 'error', text: '清潔費 2 筆，收入只有 1 筆。缺：2026-08-02 A09' },
        { level: 'warn', text: '有 1 筆人事費只有支出' },
      ],
    };
    const t = previewExportText({ ...base, check: bad });
    assert.match(t, /模擬檢查：❌ 沒過/);
    assert.match(t, /缺：2026-08-02 A09/);
    assert.match(t, /有 1 筆人事費只有支出/);
  });

  test('★★★ 算不出金額的那幾份工一定要在裡面', () => {
    /*
     * 它們不會產生任何東西 —— 而「不會產生」正是最需要有人看一眼的事:
     * 少一筆收入沒有人會發現，因為總額只是「比較小」。
     */
    const t = previewExportText({
      ...base,
      unpriced: [{ date: '2026-08-07', label: '正隆多間', units: 0.5, reason: '沒設單價' }],
    });
    assert.match(t, /算不出金額、不會產生的　1 筆/);
    assert.match(t, /正隆多間/);
    assert.match(t, /沒設單價/);
  });

  test('★★ 空的段落整段不印 —— 「（沒有）」的標題是雜訊', () => {
    const t = previewExportText(base);
    assert.equal(t.includes('人事費支出'), false);
    assert.equal(t.includes('時薪工資支出'), false);
  });

  test('★★ 人工指定金額的不印「0 × $0」—— 那是算不出答案的算式', () => {
    const t = previewExportText({
      ...base,
      clean: [L({ units: null, price: null, amount: 1500, item: '房務清潔 4B3' })],
    });
    const row = t.split('\n').find((x) => x.includes('4B3') && x.includes('1500'));
    assert.ok(row);
    assert.equal(row.includes('\t0\t'), false);
    // 間數與單價兩欄是空的，金額還在
    assert.deepEqual(row.split('\t').slice(4, 7), ['', '', '1500']);
  });

  test('欄位用 tab 分隔 —— 貼進 Excel 要能直接分欄', () => {
    const t = previewExportText(base);
    const header = t.split('\n').find((x) => x.startsWith('日期\t'));
    assert.ok(header);
    assert.deepEqual(header.split('\t'),
      ['日期', '物業', '房源', '項目', '間數', '單價', '金額', '附註']);
  });

  test('全部空的時候不炸，而且還看得出是哪個月', () => {
    const t = previewExportText({
      period: '2026-09', now: '2026-09-09', check: { ...OK, expectCount: 0, actualCount: 0, expectAmount: 0, actualAmount: 0, cleanExpect: 0, cleanActual: 0 },
      clean: [], labor: [], hour: [], income: [], unpriced: [],
    });
    assert.match(t, /2026-09/);
    assert.match(t, /支出合計 \$0/);
  });
});
