import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { parseImportRows, toYmd, OVERTIME_KIND } from './leave-import.ts';

/**
 * 這裡對錯**不會報錯**：對錯人的話，假會記到別人頭上；種類對錯，補休會變成事假。
 * 畫面上只會看到「已匯入 12 筆」。
 */
const people = [
  { id: 'u1', name: 'Cindy' }, { id: 'u2', name: '芊' }, { id: 'u3', name: '王小明' }, { id: 'u4', name: '王小明' },
];
const kinds = [
  { code: 'annual', name: '年假（特休）' }, { code: 'comp', name: '補休' },
  { code: 'sick', name: '病假' }, { code: 'personal', name: '事假' },
];
const row = (o: Record<string, unknown>) => ({ 姓名: 'Cindy', 日期: '2026-03-12', 種類: '年假', 小時: '8', 備註: '', ...o });

describe('toYmd', () => {
  test('字串三種寫法', () => {
    assert.equal(toYmd('2026-03-12'), '2026-03-12');
    assert.equal(toYmd('2026/3/2'), '2026-03-02');
    assert.equal(toYmd('2026年3月2日'), '2026-03-02');
  });
  test('Excel 序號（1899-12-30 為 0）', () => {
    assert.equal(toYmd(46093), '2026-03-12');
    assert.equal(toYmd(45658), '2025-01-01');
  });
  test('Date 物件用本地年月日', () => assert.equal(toYmd(new Date(2026, 2, 12)), '2026-03-12'));
  test('看不懂回 null', () => {
    assert.equal(toYmd('3/12'), null);
    assert.equal(toYmd('2026-02-30'), null);
    assert.equal(toYmd(''), null);
    assert.equal(toYmd(8), null);
  });
});

describe('parseImportRows', () => {
  test('一列正常 → 對到人、假別代碼、時數', () => {
    const [r] = parseImportRows([row({})], people, kinds);
    assert.equal(r.ok, true);
    if (r.ok) assert.deepEqual(r.row, { user_id: 'u1', d: '2026-03-12', kind: 'annual', hours: 8, note: null });
  });
  test('列號從 2 起算（第 1 列是表頭）', () => {
    const rs = parseImportRows([row({}), row({ 日期: '2026-03-13' })], people, kinds);
    assert.deepEqual(rs.map((r) => r.i), [2, 3]);
  });
  test('姓名：去空白、不分大小寫', () => {
    const [r] = parseImportRows([row({ 姓名: ' cindy ' })], people, kinds);
    assert.equal(r.ok, true);
  });
  test('姓名：系統沒有 → error；兩個同名 → error', () => {
    const rs = parseImportRows([row({ 姓名: '阿明' }), row({ 姓名: '王小明' })], people, kinds);
    assert.equal(rs[0].ok, false); assert.match((rs[0] as { error: string }).error, /沒有這個人/);
    assert.equal(rs[1].ok, false); assert.match((rs[1] as { error: string }).error, /同名/);
  });
  test('種類：年假／特休／年假（特休）都對到 annual；加班對到 overtime；補休', () => {
    const rs = parseImportRows([
      row({ 種類: '年假' }), row({ 種類: '特休' }), row({ 種類: '年假(特休)', 日期: '2026-03-14' }),
      row({ 種類: '加班', 日期: '2026-03-15' }), row({ 種類: '補休', 日期: '2026-03-16' }),
    ], people, kinds);
    const codes = rs.map((r) => (r.ok ? r.row.kind : (r as { error: string }).error));
    // 前兩列同一人同一天同一種 → 第二列是「填了兩次」，那是對的
    assert.equal(codes[0], 'annual');
    assert.match(String(codes[1]), /兩次/);
    assert.equal(codes[2], 'annual');
    assert.equal(codes[3], OVERTIME_KIND.code);
    assert.equal(codes[4], 'comp');
  });
  test('種類打錯 → error，訊息列出可以填的', () => {
    const [r] = parseImportRows([row({ 種類: '特假' })], people, kinds);
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, /年假（特休）／補休／病假／事假／加班/);
  });
  test('小時：0、負的、文字、不是 0.5 倍數 → error；4.5 可以', () => {
    const rs = parseImportRows([
      row({ 小時: '0' }), row({ 小時: '-1' }), row({ 小時: '八' }), row({ 小時: '1.3' }), row({ 小時: '4.5' }),
    ], people, kinds);
    assert.deepEqual(rs.map((r) => r.ok), [false, false, false, false, true]);
  });
  test('小時是數字型別（Excel 存數字）也收', () => {
    const [r] = parseImportRows([row({ 小時: 8 })], people, kinds);
    assert.equal(r.ok, true);
  });
  test('日期是 Excel 序號也收', () => {
    const [r] = parseImportRows([row({ 日期: 46093 })], people, kinds);
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.row.d, '2026-03-12');
  });
  test('整列空白跳過、不算錯', () => {
    const rs = parseImportRows([row({}), { 姓名: '', 日期: '', 種類: '', 小時: '', 備註: '' }, {}], people, kinds);
    assert.equal(rs.length, 1);
  });
  test('備註留著，空的變 null', () => {
    const rs = parseImportRows([row({ 備註: ' 下午 ' }), row({ 日期: '2026-03-13', 備註: '' })], people, kinds);
    assert.equal(rs[0].ok && rs[0].row.note, '下午');
    assert.equal(rs[1].ok && rs[1].row.note, null);
  });
  test('同一人同一天不同種類可以（上午事假、晚上加班）', () => {
    const rs = parseImportRows([row({ 種類: '事假', 小時: '4' }), row({ 種類: '加班', 小時: '2' })], people, kinds);
    assert.deepEqual(rs.map((r) => r.ok), [true, true]);
  });
  test('範本的示範列（姓名是提示字）會被標紅，不會誤進', () => {
    const [r] = parseImportRows([row({ 姓名: '（填系統上的姓名）' })], people, kinds);
    assert.equal(r.ok, false);
  });
});
