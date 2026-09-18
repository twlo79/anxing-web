import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  DASH_TABS, DEFAULT_TAB, parseTab, tabLabel,
  pillsApply, whyPillsOff, sourcePills, applyPill, togglePill, perf,
} from './dash.ts';

const R = (source: string | null, amt: number) => ({ source, month_amount: amt });
const ROWS = [
  R('longterm', 5000000), R('longterm', 3069028),
  R('airbnb', 800000), R('airbnb', 465904),
  R('private', 394508),
  R('oneoff', 52444),
  R(null, 36070),          // 空的來源
];

describe('分頁', () => {
  test('四個分頁，順序跟使用者講的一樣', () => {
    assert.deepEqual(DASH_TABS.map((t) => t.label),
      ['營收分析', '財報比較', '支出分析', '其他']);
  });

  test('★★★ 不認得的值一律回預設,不要讓畫面空著', () => {
    /*
     * 舊書籤、打錯的網址、之後改掉的代號都會走到這裡。
     * 一個什麼都不顯示的儀表板看起來像壞掉。
     */
    assert.equal(parseTab('expense'), 'expense');
    assert.equal(parseTab('沒見過的'), DEFAULT_TAB);
    assert.equal(parseTab(''), DEFAULT_TAB);
    assert.equal(parseTab(null), DEFAULT_TAB);
    assert.equal(parseTab(undefined), DEFAULT_TAB);
  });

  test('預設是營收分析', () => {
    assert.equal(DEFAULT_TAB, 'revenue');
    assert.equal(tabLabel(DEFAULT_TAB), '營收分析');
    assert.equal(tabLabel('沒有這個'), '');
  });
});

describe('★★★ 膠囊只有營收分析能用', () => {
  test('營收分析:能用', () => {
    assert.equal(pillsApply('revenue'), true);
    assert.equal(whyPillsOff('revenue'), null);
  });

  test('★★★ 財報比較:不能用,而且理由講的是**淨額會算錯**', () => {
    /*
     * 支出沒有「來源」這個欄位,篩不動。
     * 只篩營收的話「淨額 = 營收 − 支出」會變成
     * 「長租的營收 − 全部的支出」—— 一個看起來很正常的負數,
     * 而畫面上沒有任何地方會說它是錯的。
     */
    assert.equal(pillsApply('compare'), false);
    assert.match(whyPillsOff('compare') ?? '', /淨額/);
  });

  test('支出分析與其他:不能用,而且說得出原因', () => {
    for (const t of ['expense', 'other']) {
      assert.equal(pillsApply(t), false);
      assert.ok((whyPillsOff(t) ?? '').length > 0, t);
    }
  });

  test('不認得的分頁 → 當成預設(營收分析)→ 能用', () => {
    assert.equal(pillsApply('亂打'), true);
  });
});

describe('膠囊本身', () => {
  test('金額大到小', () => {
    const ps = sourcePills(ROWS);
    assert.deepEqual(ps.map((p) => p.key),
      ['longterm', 'airbnb', 'private', 'oneoff', 'other']);
    assert.equal(ps[0].amount, 8069028);
    assert.equal(ps[0].count, 2);
  });

  test('★★ 空的來源當成 other,不可以丟掉', () => {
    /*
     * 丟掉的話膠囊的合計會跟總額對不上,
     * 而對不上的總額是最難查的一種(沒有人會想到是某一列的欄位空的)。
     */
    const ps = sourcePills(ROWS);
    const sum = ps.reduce((s, p) => s + p.amount, 0);
    assert.equal(sum, 9817954);
    assert.equal(sum, ROWS.reduce((s, r) => s + r.month_amount, 0));
    assert.ok(ps.some((p) => p.key === 'other'));
  });

  test('沒有資料 → 空陣列,不會爆', () => {
    assert.deepEqual(sourcePills([]), []);
  });

  test('★★★ 再點一下＝清除（不用另外做一顆「全部」）', () => {
    assert.equal(togglePill(null, 'airbnb'), 'airbnb');
    assert.equal(togglePill('airbnb', 'airbnb'), null);
    assert.equal(togglePill('airbnb', 'longterm'), 'longterm');
  });

  test('套上膠囊', () => {
    assert.equal(applyPill(ROWS, 'airbnb').length, 2);
    assert.equal(applyPill(ROWS, 'other').length, 1);
    assert.equal(applyPill(ROWS, null).length, ROWS.length);
    assert.equal(applyPill(ROWS, '').length, ROWS.length);
  });

  test('★★ 選了一個這段期間沒有的來源 → 空陣列（畫面要講出來）', () => {
    assert.deepEqual(applyPill(ROWS, 'agoda'), []);
  });
});

describe('★★★ 營收表現那一排大數字', () => {
  test('沒篩:營收、筆數、平均單價', () => {
    const p = perf(ROWS, ROWS, false);
    assert.equal(p.revenue, 9817954);
    assert.equal(p.count, 7);
    assert.equal(p.avg, Math.round(9817954 / 7));
    assert.equal(p.shareRev, null);
    assert.equal(p.shareCnt, null);
  });

  test('篩了 Airbnb:單價要是 Airbnb 自己的', () => {
    const shown = applyPill(ROWS, 'airbnb');
    const p = perf(shown, ROWS, true);
    assert.equal(p.revenue, 1265904);
    assert.equal(p.count, 2);
    assert.equal(p.avg, 632952);
    assert.ok(p.shareRev !== null && Math.abs(p.shareRev - 1265904 / 9817954) < 1e-9);
  });

  test('★★★ 筆數 0 時平均單價是 0 不是 NaN', () => {
    /*
     * NaN 在畫面上會印成「NT$NaN」—— 使用者看到的是壞掉,
     * 而不是「這段期間沒有東西」。
     */
    const p = perf([], ROWS, true);
    assert.equal(p.avg, 0);
    assert.equal(Number.isNaN(p.avg), false);
    assert.equal(p.revenue, 0);
    assert.equal(p.count, 0);
  });

  test('★★ 全部都是 0 時,佔比回 null 不是 0/0', () => {
    const p = perf([], [], true);
    assert.equal(p.shareRev, null);
    assert.equal(p.shareCnt, null);
  });

  test('金額是字串也算得出來（PostgREST 的 numeric 回字串）', () => {
    const rows = [{ source: 'a', month_amount: '100.4' }, { source: 'a', month_amount: '99.6' }];
    assert.equal(perf(rows, rows, false).revenue, 200);
  });
});
