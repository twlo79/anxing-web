import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  DASH_TABS, DEFAULT_TAB, parseTab, tabLabel,
  pillsApply, whyPillsOff, sourcePills, perf,
  COMBO_MODES, parseComboMode, effectiveComboMode, monthsBetween,
  comboRow, occSegments, moneyTop, textWidth, fitLabel, axisLabels,
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

  /* ★ 膠囊的開關與篩選改成複選了，測試搬到 `rev-occ.test.ts`
       （`toggleSrc` / `applySrcPicks`）。 */
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
    const shown = ROWS.filter((r) => (String(r.source ?? '').trim() || 'other') === 'airbnb');
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

/* ══════════════════════════════════════════════════════════
 * 營收與住房率合圖（2026-09-18）
 * ══════════════════════════════════════════════════════════ */

const OCC = (rate: number, days = 30) => ({ rate, days, used: Math.round(rate * days), rooms: 1 });

test('模式：認得 estate，其餘一律回 time', () => {
  assert.equal(parseComboMode('estate'), 'estate');
  assert.equal(parseComboMode('time'), 'time');
  assert.equal(parseComboMode(''), 'time');
  assert.equal(parseComboMode(null), 'time');
  assert.equal(parseComboMode('亂打'), 'time');
});

test('comboRow：金額收成整數', () => {
  assert.equal(comboRow('a', 'A', 1234.6, null).rev, 1235);
  assert.equal(comboRow('a', 'A', NaN, null).rev, 0);
});

test('★★★ days 是 0 的住房率當成「沒有」 —— 不是 0%', () => {
  assert.equal(comboRow('a', 'A', 100, OCC(0, 0)).occ, null);
  assert.equal(comboRow('a', 'A', 100, undefined).occ, null);
});

test('★★ 真的全空（days 有、rate 0）要留著 —— 那是要處理的事實', () => {
  const r = comboRow('a', 'A', 0, OCC(0, 30));
  assert.notEqual(r.occ, null);
  assert.equal(r.occ?.rate, 0);
});

test('★★★ 折線遇到沒有資料的那一格要斷開', () => {
  const rows = [
    comboRow('1', '1月', 10, OCC(0.5)),
    comboRow('2', '2月', 10, OCC(0.6)),
    comboRow('3', '3月', 10, undefined),
    comboRow('4', '4月', 10, OCC(0.7)),
  ];
  assert.deepEqual(occSegments(rows), [[0, 1], [3]]);
});

test('全部都有資料 → 一整段', () => {
  const rows = [comboRow('1', '1', 1, OCC(0.5)), comboRow('2', '2', 1, OCC(0.6))];
  assert.deepEqual(occSegments(rows), [[0, 1]]);
});

test('一個都沒有 → 沒有任何一段（折線整條不畫）', () => {
  assert.deepEqual(occSegments([comboRow('1', '1', 1, undefined)]), []);
  assert.deepEqual(occSegments([]), []);
});

test('★ 只有一個點的段也要回 —— 丟掉的話單月區間折線會整條消失', () => {
  assert.deepEqual(occSegments([comboRow('1', '1', 1, OCC(0.5))]), [[0]]);
});

test('頭尾都是空格', () => {
  const rows = [
    comboRow('0', '0', 1, undefined),
    comboRow('1', '1', 1, OCC(0.5)),
    comboRow('2', '2', 1, undefined),
  ];
  assert.deepEqual(occSegments(rows), [[1]]);
});

test('moneyTop：取到四等分好讀的刻度', () => {
  assert.equal(moneyTop(9889954), 10000000);   // 每格 250 萬
  assert.equal(moneyTop(8069028), 10000000);   // ★ 不是 850 萬（那樣一格是 212.5 萬）
  assert.equal(moneyTop(120000), 200000);      // 每格 5 萬
});

test('★★ 四等分之後每一格都好讀（不會出現 212.5 萬這種刻度）', () => {
  const nice = (v: number) => {
    const s = String(v / Math.pow(10, Math.floor(Math.log10(v))));
    return ['1', '2', '2.5', '5', '10'].includes(s);
  };
  for (const v of [8069028, 9889954, 120000, 63, 4321, 777777]) {
    assert.ok(nice(moneyTop(v) / 4), `${v} → 一格 ${moneyTop(v) / 4}`);
  }
});

test('★ moneyTop(0) 回 1 不是 0 —— 0 當分母會讓整張圖不見', () => {
  assert.equal(moneyTop(0), 1);
  assert.equal(moneyTop(-5), 1);
  assert.equal(moneyTop(NaN), 1);
});

test('moneyTop 一定 >= max（長條不會頂出格線外）', () => {
  for (const v of [1, 9, 10, 99, 100, 4999, 5000, 5001, 123456, 8069028]) {
    assert.ok(moneyTop(v) >= v, `${v} → ${moneyTop(v)}`);
  }
});

test('模式清單只有兩個，第一個是預設', () => {
  assert.equal(COMBO_MODES.length, 2);
  assert.equal(COMBO_MODES[0].key, parseComboMode(undefined));
});

test('★★★ 沒按過而且只有一個月 → 自己切到各物業（一根長條的趨勢圖沒有意義）', () => {
  assert.equal(effectiveComboMode(null, 1), 'estate');
  assert.equal(effectiveComboMode(null, 0), 'estate');
  assert.equal(effectiveComboMode(null, 2), 'time');
  assert.equal(effectiveComboMode(null, 12), 'time');
});

test('★★ 按過就以他按的為準 —— 圖不會自己跳掉', () => {
  assert.equal(effectiveComboMode('time', 1), 'time');
  assert.equal(effectiveComboMode('estate', 12), 'estate');
});

test('monthsBetween：含頭含尾', () => {
  assert.deepEqual(monthsBetween('2026-07-15', '2026-09-18'), ['2026-07', '2026-08', '2026-09']);
  assert.deepEqual(monthsBetween('2026-09-01', '2026-09-30'), ['2026-09']);
});

test('monthsBetween：跨年', () => {
  assert.deepEqual(monthsBetween('2025-11-20', '2026-02-03'),
    ['2025-11', '2025-12', '2026-01', '2026-02']);
});

test('monthsBetween：起迄顛倒或空的回空陣列', () => {
  assert.deepEqual(monthsBetween('2026-09-30', '2026-09-01'), ['2026-09']);  // 同一個月
  assert.deepEqual(monthsBetween('2026-10-01', '2026-09-01'), []);
  assert.deepEqual(monthsBetween('', ''), []);
  assert.deepEqual(monthsBetween('亂打', '2026-09-01'), []);
});

test('textWidth：中文一個字比數字寬（量出來的比例）', () => {
  assert.ok(textWidth('未指定物業') > textWidth('10月'));
  assert.ok(Math.abs(textWidth('未指定物業') - 55) < 3);
  assert.ok(Math.abs(textWidth('10月') - 25) < 3);
});

test('fitLabel：放得下就原樣', () => {
  assert.equal(fitLabel('正隆', 41), '正隆');
});

test('fitLabel：放不下就截短加省略號', () => {
  assert.equal(fitLabel('未指定物業', 41), '未指…');
});

test('★★ 連兩個字都塞不下就回空字串（硬塞一個字分不出是哪一棟）', () => {
  assert.equal(fitLabel('未指定物業', 13), '');
  assert.equal(fitLabel('', 100), '');
});

test('★★★ 物業模式:每一格都印，長的截短', () => {
  const rows = [{ label: '正隆' }, { label: '時兆' }, { label: '未指定物業' }];
  const a = axisLabels(rows, 47);
  assert.equal(a.stride, 1);
  assert.deepEqual(a.labels, ['正隆', '時兆', '未指…']);
});

test('★★★ 月份模式:截短認不出來，改成隔幾個印一個完整的', () => {
  const rows = Array.from({ length: 12 }, (_, i) => ({ label: `${i + 1}月` }));
  const a = axisLabels(rows, 19);
  assert.ok(a.stride >= 2);
  assert.deepEqual(a.labels, rows.map((r) => r.label));   // 印的是完整標籤
});

test('寬螢幕：全部完整印，stride 1', () => {
  const rows = [{ label: '正隆' }, { label: '未指定物業' }];
  const a = axisLabels(rows, 157);
  assert.equal(a.stride, 1);
  assert.deepEqual(a.labels, ['正隆', '未指定物業']);
});

test('step 是 0 也不會當掉（量測還沒完成的那一瞬間）', () => {
  const a = axisLabels([{ label: '正隆' }], 0);
  assert.ok(a.stride >= 1);
  assert.ok(Number.isFinite(a.stride));
});

test('comboRow：partial 預設是 false', () => {
  assert.equal(comboRow('a', 'A', 1, null).partial, false);
  assert.equal(comboRow('a', 'A', 1, null, true).partial, true);
});
