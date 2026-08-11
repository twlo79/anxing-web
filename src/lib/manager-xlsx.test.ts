import test from 'node:test';
import assert from 'node:assert/strict';
import {
  pct, periodTitle, summarySheet, detailSheet, safeSheetName, xlsxFilename,
  SUMMARY_HEADER, DETAIL_HEADER, type DetailRow,
} from './manager-xlsx.ts';

const mgrs = [
  { manager: '唐', avg_rating: 4.86, s5: 519, s4: 38, s3: 12, s2: 6, s1: 0, total: 575 },
  { manager: '月', avg_rating: 4.97, s5: 176, s4: 2, s3: 2, s2: 0, s1: 0, total: 180 },
  { manager: '花', avg_rating: 5.00, s5: 5, s4: 0, s3: 0, s2: 0, s1: 0, total: 5 },
];

// ── 占比與期間 ─────────────────────────────────────

test('占比一位小數', () => {
  assert.equal(pct(519, 575), '90.3%');
  assert.equal(pct(575, 575), '100.0%');
});

test('★ 分母 0 不能變成 NaN%', () => {
  assert.equal(pct(0, 0), '0%');
});

test('★ 沒選期間要寫「全部期間」,不是留白', () => {
  // 留白的話,這份檔案存三個月後沒有人知道是哪一段時間的數字
  assert.equal(periodTitle('', ''), '全部期間');
  assert.equal(periodTitle('2026-01-01', ''), '2026-01-01 起');
  assert.equal(periodTitle('', '2026-06-30'), '迄 2026-06-30');
});

// ── 總表 ───────────────────────────────────────────

test('第一行標題、第三行欄位名', () => {
  const s = summarySheet(mgrs, '2026-01-01', '2026-06-30');
  assert.equal(s[0][0], '管家評價　2026-01-01 ~ 2026-06-30');
  assert.deepEqual(s[2], SUMMARY_HEADER);
});

test('★ 數量與占比是分開的兩欄', () => {
  // 塞在同一格的話,在 Excel 裡是文字 —— 排不了序、加不了總、畫不了圖,
  // 而人下載這個檔就是為了做這三件事
  const r = summarySheet(mgrs, '', '')[3];
  assert.equal(r[0], '唐');
  assert.equal(r[2], 519);
  assert.equal(r[3], '90.3%');
  assert.equal(r[12], 575);
});

test('★ 數值欄位是數字型別，不是字串', () => {
  // 存成字串的話 Excel 右下角不會顯示加總,也畫不出圖
  const r = summarySheet(mgrs, '', '')[3];
  assert.equal(typeof r[1], 'number', '平均評價');
  assert.equal(typeof r[2], 'number', '5 星數量');
  assert.equal(typeof r[12], 'number', '總評價數');
});

test('★ 合計的平均要加權', () => {
  // 只有 5 則評價的「花」跟 575 則的「唐」一樣重的話,那個數字沒有意義
  const s = summarySheet(mgrs, '', '');
  const last = s[s.length - 1];
  assert.equal(last[0], '合計');
  assert.equal(last[12], 760);
  assert.equal(last[1], 4.89);
  assert.notEqual(last[1], 4.94, '把三個平均再平均會得到 4.94');
});

test('只有一位管家時不加合計列', () => {
  assert.equal(summarySheet([mgrs[0]], '', '').length, 4);
});

// ── 明細 ───────────────────────────────────────────

const d = (rating: number, guest: string, checkout: string, comment = ''): DetailRow =>
  ({ manager: '唐', guest, estate: '開封', property: '1F-1', rating, comment, checkout });

test('明細的欄位就是姓名/物業/房源/星等/留言', () => {
  const s = detailSheet('唐', [d(5, 'A', '2026-03-01')], '', '');
  assert.deepEqual(s[2], DETAIL_HEADER);
  assert.deepEqual(s[3], ['A', '開封', '1F-1', 5, '']);
});

test('★ 姓名是房客不是管家', () => {
  // 管家已經是分頁名了,同一個分頁裡每一列都一樣 —— 再開一欄只是重複
  const s = detailSheet('唐', [d(5, '王小明', '2026-03-01')], '', '');
  assert.equal(s[3][0], '王小明');
  assert.notEqual(s[3][0], '唐');
});

test('★ 星等低的排前面 —— 那是打開這個檔案的原因', () => {
  // 照時間排的話,575 則的人要捲到第四百列才看得到那則兩星
  const s = detailSheet('唐', [
    d(5, '五星客', '2026-03-01'),
    d(2, '兩星客', '2026-01-05'),
    d(4, '四星客', '2026-02-01'),
  ], '', '');
  assert.deepEqual(s.slice(3).map((r) => r[0]), ['兩星客', '四星客', '五星客']);
});

test('同星等內照退房日新到舊', () => {
  const s = detailSheet('唐', [
    d(5, '舊', '2026-01-01'),
    d(5, '新', '2026-06-01'),
  ], '', '');
  assert.deepEqual(s.slice(3).map((r) => r[0]), ['新', '舊']);
});

test('★ 沒有留言時寫空字串,不是 null', () => {
  const s = detailSheet('唐', [{ ...d(5, 'A', '2026-01-01'), comment: null as any }], '', '');
  assert.equal(s[3][4], '');
});

test('★ 星等存數字,不是星星符號', () => {
  // 存成 ★★★★★ 的話排不了序也算不了平均
  const s = detailSheet('唐', [d(3, 'A', '2026-01-01')], '', '');
  assert.equal(s[3][3], 3);
});

test('沒有評價時給一列說明,不是空白分頁', () => {
  const s = detailSheet('花', [], '2026-01-01', '2026-06-30');
  assert.match(String(s[0][0]), /共 0 則/);
  assert.match(String(s[3][0]), /沒有評價/);
});

test('標題帶管家名、期間與筆數', () => {
  const s = detailSheet('唐', [d(5, 'A', '2026-01-01')], '2026-01-01', '2026-06-30');
  assert.equal(s[0][0], '唐　評價明細　2026-01-01 ~ 2026-06-30　共 1 則');
});

// ── 分頁名 ─────────────────────────────────────────

test('★ 分頁名要擋掉 Excel 不接受的字元', () => {
  // 違反的話 SheetJS 直接丟例外,使用者只看到「匯出失敗」
  const used = new Set<string>();
  assert.equal(safeSheetName('開封/1F', used), '開封1F');
  assert.equal(safeSheetName('王[大]明', used), '王大明');
});

test('★ 重名要自動編號', () => {
  const used = new Set<string>();
  assert.equal(safeSheetName('唐', used), '唐');
  assert.equal(safeSheetName('唐', used), '唐_2');
  assert.equal(safeSheetName('唐', used), '唐_3');
});

test('超過 31 字要截斷', () => {
  const used = new Set<string>();
  assert.equal(safeSheetName('あ'.repeat(40), used).length, 31);
});

test('空名稱不會產生空分頁名', () => {
  const used = new Set<string>();
  assert.equal(safeSheetName('', used), '未命名');
});

// ── 檔名 ───────────────────────────────────────────

test('★ 檔名帶「資料期間」而不是匯出日', () => {
  assert.equal(xlsxFilename('2026-01-01', '2026-06-30'), '管家評價_20260101-20260630.xlsx');
  assert.equal(xlsxFilename('', ''), '管家評價_全部.xlsx');
});

// ── 樣式 ───────────────────────────────────────────

import { colName, cellRef, styleSheet, STYLE } from './manager-xlsx.ts';

test('欄名的邊界：A / Z / AA / AZ', () => {
  assert.equal(colName(0), 'A');
  assert.equal(colName(25), 'Z');
  assert.equal(colName(26), 'AA');
  assert.equal(colName(51), 'AZ');
  assert.equal(cellRef(0, 0), 'A1');
  assert.equal(cellRef(2, 12), 'M3');
});

test('表頭套 header、資料列套 cell、合計列套 total', () => {
  const ws: Record<string, any> = {
    A1: { t: 's', v: '標題' },
    A3: { t: 's', v: '名稱' }, B3: { t: 's', v: '平均' },
    A4: { t: 's', v: '唐' }, B4: { t: 'n', v: 4.86 },
    A5: { t: 's', v: '合計' }, B5: { t: 'n', v: 4.9 },
  };
  styleSheet(ws, { headerRow: 2, lastRow: 4, cols: 2, totalRow: 4 });
  assert.equal(ws.A1.s, STYLE.title);
  assert.equal(ws.A3.s, STYLE.header);
  assert.equal(ws.B3.s, STYLE.header);
  assert.equal(ws.A4.s, STYLE.cell);
  assert.equal(ws.A5.s, STYLE.total);
});

test('★ 空格也要建出來，否則框線會缺一角', () => {
  // aoa_to_sheet 不替空格建物件,沒有物件就套不上框線 ——
  // 表格右邊會缺角,看起來像沒畫完
  const ws: Record<string, any> = { A3: { t: 's', v: '名稱' } };
  styleSheet(ws, { headerRow: 2, lastRow: 3, cols: 3 });
  assert.ok(ws.C3, '表頭最右邊那格是空的,也要有框線');
  assert.equal(ws.C3.v, '');
  assert.equal(ws.C3.s, STYLE.header);
  assert.equal(ws.A4.s, STYLE.cell);
});

test('沒有合計列時不會有任何一格套到 total', () => {
  const ws: Record<string, any> = {};
  styleSheet(ws, { headerRow: 2, lastRow: 5, cols: 2, totalRow: -1 });
  for (let r = 2; r <= 5; r++) {
    for (let c = 0; c < 2; c++) assert.notEqual(ws[cellRef(r, c)].s, STYLE.total);
  }
});

test('表頭是粗體、有底色、有框線', () => {
  assert.equal(STYLE.header.font.bold, true);
  assert.ok(STYLE.header.fill.fgColor.rgb);
  assert.ok(STYLE.header.border.bottom.style);
});
