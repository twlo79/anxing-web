import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STATUS_LABEL, STATUS_ORDER, STATUS_CLS, isOpen,
  tenderMissing, tenderError, fromFeed, afterImportTodo, feedKey,
  daysLeft, dueHint, type TenderStatus,
} from './tender.ts';

/**
 * 這一支釘的是「爬蟲給不出來的那兩個欄位」。
 *
 * 填錯截標日期的後果是**錯過投標** —— 而那正是沒有人會發現的那一種錯：
 * 清單上看起來已經填好了。
 */

/* ── 加星複製 ─────────────────────────────── */

const FEED = {
  id: 'f1',
  source: '政府採購網',
  title: '公告１１５年臺北市等２縣市４４宗不動產標租',
  url: 'https://web.pcc.gov.tw/xxx',
  agency: '政戰資訊服務網',
  posted_on: '2026-08-26',
};

test('★★ posted_on 絕對不能變成 due_on —— 那是公告日期不是截標日期', () => {
  const d = fromFeed(FEED);
  assert.equal(d.due_on, null);
  // 反過來也確認一次:不要哪天有人「順手補上」
  assert.notEqual(d.due_on, FEED.posted_on);
});

test('★★ 地址一律留空 —— 爬蟲沒有這個欄位', () => {
  assert.equal(fromFeed(FEED).address, null);
});

test('名稱、網址、狀態要帶過來', () => {
  const d = fromFeed(FEED);
  assert.equal(d.name, FEED.title);
  assert.equal(d.url, FEED.url);
  assert.equal(d.status, 'watching');
  assert.equal(d.feed_id, 'f1');
});

test('★ 來源優先用 agency（公告上的機關），沒有才退回爬蟲的來源名', () => {
  assert.equal(fromFeed(FEED).source, '政戰資訊服務網');
  assert.equal(fromFeed({ ...FEED, agency: null }).source, '政府採購網');
  assert.equal(fromFeed({ ...FEED, agency: '  ' }).source, '政府採購網');
});

test('★ url 是空字串要收成 null —— 郵局那種沒有各別頁的來源', () => {
  assert.equal(fromFeed({ ...FEED, url: '' }).url, null);
  assert.equal(fromFeed({ ...FEED, url: null }).url, null);
});

test('★★ 加星之後要講出還缺什麼', () => {
  const d = fromFeed(FEED);
  assert.deepEqual(afterImportTodo(d), ['地址', '截標日期']);
  assert.deepEqual(afterImportTodo({ ...d, address: '台北市中正區' }), ['截標日期']);
  assert.deepEqual(afterImportTodo({ ...d, address: 'x', due_on: '2026-09-10' }), []);
});

/* ── 必填 ─────────────────────────────────── */

test('★★ 只有標案名稱必填 —— 地址與截標日期設成必填的話，使用者會隨手填', () => {
  assert.deepEqual(tenderMissing({ name: 'A' }), []);
  assert.deepEqual(tenderMissing({}), ['標案名稱']);
  assert.deepEqual(tenderMissing({ name: '  ' }), ['標案名稱']);
});

test('狀態不在清單裡要擋', () => {
  assert.equal(tenderError({ name: 'A', status: 'watching' }), null);
  assert.match(tenderError({ name: 'A', status: '亂填' })!, /不在清單/);
});

test('截標日期格式不對要擋', () => {
  assert.equal(tenderError({ name: 'A', due_on: '2026-09-10' }), null);
  assert.equal(tenderError({ name: 'A', due_on: '' }), null);   // 空的是允許的
  assert.match(tenderError({ name: 'A', due_on: '2026/9/10' })!, /YYYY-MM-DD/);
});

/* ── 唯一鍵 ───────────────────────────────── */

test('★★ 同一個 url、不同標題要是不同的鍵（郵局那 83 筆）', () => {
  const a = feedKey({ source: '郵局', url: 'https://same/page', title: 'A案' });
  const b = feedKey({ source: '郵局', url: 'https://same/page', title: 'B案' });
  assert.notEqual(a, b);
});

test('完全相同的是同一個鍵', () => {
  assert.equal(
    feedKey({ source: '郵局', url: 'https://p', title: 'A' }),
    feedKey({ source: '郵局', url: 'https://p', title: 'A' }));
});

test('★ 沒有 url 的來源不會每一筆都被當成不同的', () => {
  assert.equal(
    feedKey({ source: 'X', url: null, title: 'A' }),
    feedKey({ source: 'X', url: '', title: 'A' }));
});

test('★ 不同來源同名不算重複 —— 「115年度不動產標租」很多機關都會用', () => {
  assert.notEqual(
    feedKey({ source: '台北市財政局', url: '', title: '115年度不動產標租' }),
    feedKey({ source: '新北市財政局', url: '', title: '115年度不動產標租' }));
});

/* ── 截標倒數 ─────────────────────────────── */

test('daysLeft 基本', () => {
  assert.equal(daysLeft('2026-09-10', '2026-09-01'), 9);
  assert.equal(daysLeft('2026-09-01', '2026-09-01'), 0);
  assert.equal(daysLeft('2026-08-30', '2026-09-01'), -2);
});

test('★ 跨月跨年都要對', () => {
  assert.equal(daysLeft('2027-01-01', '2026-12-31'), 1);
  assert.equal(daysLeft('2026-03-01', '2026-02-28'), 1);   // 2026 不是閏年
});

test('沒填或格式不對回 null，不要回 NaN', () => {
  assert.equal(daysLeft(null, '2026-09-01'), null);
  assert.equal(daysLeft('', '2026-09-01'), null);
  assert.equal(daysLeft('2026/09/10', '2026-09-01'), null);
});

test('★★ 沒填要說話，不能留空白', () => {
  // 空白跟「還很久」長得一樣,而它的意思是「沒有人知道什麼時候截止」
  const h = dueHint(null, '2026-09-01');
  assert.ok(h);
  assert.match(h!.text, /未填/);
});

test('★★ 三天內是紅的，一週內是琥珀', () => {
  assert.match(dueHint('2026-09-01', '2026-09-01')!.cls, /red/);
  assert.match(dueHint('2026-09-03', '2026-09-01')!.cls, /red/);
  assert.match(dueHint('2026-09-06', '2026-09-01')!.cls, /amber/);
  assert.match(dueHint('2026-09-20', '2026-09-01')!.cls, /gray/);
});

test('今天截標要講「今天」，不是「剩 0 天」', () => {
  assert.equal(dueHint('2026-09-01', '2026-09-01')!.text, '今天截標');
});

test('★ 已結束的案子不再提醒截標', () => {
  for (const s of ['won', 'lost', 'dropped']) {
    assert.equal(dueHint(null, '2026-09-01', s), null, s);
    assert.equal(dueHint('2026-08-01', '2026-09-01', s), null, s);
  }
});

test('★ 進行中的三種都要提醒', () => {
  for (const s of ['watching', 'preparing', 'submitted']) {
    assert.ok(dueHint(null, '2026-09-01', s), s);
  }
});

/* ── 狀態表的完整性 ───────────────────────── */

test('★★ 每一個狀態都要有標籤、顏色，而且順序表要蓋到全部', () => {
  // 漏一個的症狀是畫面上出現原始英文代碼,或那一格整個空白
  const keys = Object.keys(STATUS_LABEL) as TenderStatus[];
  for (const k of keys) {
    assert.ok(STATUS_LABEL[k], `${k} 沒有標籤`);
    assert.ok(STATUS_CLS[k], `${k} 沒有顏色`);
    assert.ok(STATUS_ORDER.includes(k), `${k} 不在順序表裡`);
  }
  assert.equal(STATUS_ORDER.length, keys.length);
});

test('★ 得標是綠、未得標是紅、放棄是灰 —— 跟全站色盤同一套語意', () => {
  assert.match(STATUS_CLS.won, /green/);
  assert.match(STATUS_CLS.lost, /red/);
  assert.match(STATUS_CLS.dropped, /gray/);
});

test('isOpen：三個進行中、三個結束', () => {
  assert.deepEqual(STATUS_ORDER.filter(isOpen), ['watching', 'preparing', 'submitted']);
});
