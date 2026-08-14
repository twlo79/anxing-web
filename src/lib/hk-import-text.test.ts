import test from 'node:test';
import assert from 'node:assert/strict';
import { splitRecords } from './hk-import-text.ts';

/* ── 正常的一行一筆 ──────────────────────────── */

test('一行一筆', () => {
  const r = splitRecords('2026-08-01,退-A2-Martin,SHAO-YING HSIEH\n2026-08-01,B5-吳瑋茹-入住,月(Dianne)');
  assert.equal(r.length, 2);
  assert.deepEqual(r[1], { date: '2026-08-01', title: 'B5-吳瑋茹-入住', assignees: '月(Dianne)' });
});

/* ── 換行掉光的一整條（實際發生的） ──────────── */

const FLAT = '2026-08-01,退-A2-Martin Kossa（7/31退、7/31油漆矽利康）,SHAO-YING HSIEH '
  + '2026-08-01,退-開4-Nga Ki,SHAO-YING HSIEH '
  + '2026-08-01,14B3結尾/19B2地板/18B2擺備品鋪床檢查窗框縫,Ayu+劉姐 '
  + '2026-08-03,退-4B3-Betty(8/2),Ayu';

test('★★ 換行掉光也要切得開', () => {
  // 用 split(\n) 的話這整條是「一筆」,而那一筆的負責人欄是後面整個月 ——
  // 預覽會顯示「共 1 筆、未知人員 SHAO-YING HSIEH」,
  // 看起來像人員主檔的問題,其實解析從第一步就散了
  const r = splitRecords(FLAT);
  assert.equal(r.length, 4);
  assert.equal(r[0].title, '退-A2-Martin Kossa（7/31退、7/31油漆矽利康）');
  assert.equal(r[0].assignees, 'SHAO-YING HSIEH');
  assert.equal(r[2].assignees, 'Ayu+劉姐');
});

test('★★ 標題裡的日期不會被誤切', () => {
  // 「(8/2)」「8/3下午一點已退」不是 YYYY-MM-DD 格式;
  // 就算是,切點還要求後面接逗號
  const r = splitRecords('2026-08-04,退-14B1-James（8/3下午一點已退）,Ayu');
  assert.equal(r.length, 1);
  assert.equal(r[0].title, '退-14B1-James（8/3下午一點已退）');
});

test('★★ 沒排到人的那一筆:下一個日期直接接在逗號後面', () => {
  const r = splitRecords('2026-08-17,退-JPR整棟-Conrad Chan, 2026-08-18,U休,SHAO-YING HSIEH');
  assert.equal(r.length, 2);
  assert.equal(r[0].assignees, '', '那天真的沒排人 —— 要留成空的,預覽才算得進「未指派」');
  assert.equal(r[1].title, 'U休');
});

test('空白進來就是零筆,不是一筆空的', () => {
  assert.deepEqual(splitRecords('   '), []);
});

test('沒有日期開頭的雜訊整段丟掉', () => {
  assert.deepEqual(splitRecords('這是我複製錯的東西'), []);
});

/* ── 排程抓下來的 JSON ───────────────────────── */

test('★ 直接吃排程的 JSON —— 他手上就有那個檔', () => {
  const r = splitRecords(JSON.stringify({
    period: '2026-08', dryRun: false,
    records: [{ date: '2026-08-01', title: '退-開4-Nga Ki', assignees: ['SHAO-YING HSIEH'] }],
  }));
  assert.deepEqual(r, [{ date: '2026-08-01', title: '退-開4-Nga Ki', assignees: 'SHAO-YING HSIEH' }]);
});

test('負責人陣列接成一串', () => {
  const r = splitRecords(JSON.stringify([{ date: '2026-08-01', title: 'X', assignees: ['Ayu', '劉姐'] }]));
  assert.equal(r[0].assignees, 'Ayu、劉姐');
});

test('★ JSON 解不出來就當文字處理,不丟例外', () => {
  // 貼錯東西的人需要的是「看到 0 筆」,不是一個紅色的例外
  assert.deepEqual(splitRecords('{ 這不是 JSON'), []);
});

test('JSON 裡沒有日期的那幾筆丟掉', () => {
  const r = splitRecords(JSON.stringify({ records: [{ title: '沒有日期' }] }));
  assert.deepEqual(r, []);
});
