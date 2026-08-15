import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPnl, estateColumns, pnlBalances, incomeLabel, accrualAmount,
  type PnlRev, type PnlExp,
} from './pnl.ts';

const rev = (p: Partial<PnlRev> = {}): PnlRev => ({
  source: 'airbnb', estate_id: 'E1', month_amount: 1000, ...p,
});
const exp = (p: Partial<PnlExp> = {}): PnlExp => ({
  spent_on: '2026-08-01', amount: 100, account_code: 'CLEAN',
  purpose_type: 'estate', estate_id: 'E1', ...p,
});
const NAME: Record<string, string> = { CLEAN: '清潔費', RENT: '租金支出', UTIL: '水電瓦斯' };
const nameOf = (c: string | null) => (c ? NAME[c] ?? c : '未分類');

/* ── 三段結構 ────────────────────────────────── */

test('★★ 物業毛利 = 收入 − 物業成本;辦公室費用不進去', () => {
  const p = buildPnl(
    [rev({ month_amount: 1000 })],
    [exp({ amount: 300 }), exp({ amount: 200, purpose_type: 'office', estate_id: null })],
    nameOf);
  assert.equal(p.gross.total, 700, '毛利只扣物業成本');
  assert.equal(p.opex.total, 200);
  assert.equal(p.net, 500, '本期損益才扣營業費用');
});

test('★★ 辦公室費用不會被攤到任何一棟', () => {
  // 攤下去的話「E1」那一欄會出現一筆它從來沒花過的錢,
  // 而看報表的人不知道那是算出來的還是真的花掉的
  const p = buildPnl(
    [rev({ estate_id: 'E1', month_amount: 1000 })],
    [exp({ amount: 500, purpose_type: 'office', estate_id: null })],
    nameOf);
  assert.equal(p.gross.by.get('E1'), 1000, 'E1 的毛利不受辦公室費用影響');
  assert.equal(p.cost.total, 0);
});

test('★★ 毛利逐欄算 —— 只有收入沒有成本的那一棟不能消失', () => {
  // 用總數相減再攤回去的話,E2 會不見
  const p = buildPnl(
    [rev({ estate_id: 'E1' }), rev({ estate_id: 'E2', month_amount: 500 })],
    [exp({ estate_id: 'E1', amount: 200 })],
    nameOf);
  assert.equal(p.gross.by.get('E1'), 800);
  assert.equal(p.gross.by.get('E2'), 500);
});

test('★ 只有成本沒有收入的那一棟要看得到（那正是要發現的）', () => {
  const p = buildPnl([], [exp({ estate_id: 'E9', amount: 400 })], nameOf);
  assert.equal(p.gross.by.get('E9'), -400);
  assert.ok(estateColumns(p).includes('E9'));
});

/* ── 遞延 ────────────────────────────────────── */

test('★★ 遞延用認列金額,不用實付總額', () => {
  // 用 gross_amount 的話,一筆付一年的保險費會整包砸在某個月 ——
  // 那個月憑空虧損,後面十一個月憑空獲利
  const parent = exp({ amount: 1000, deferred: true, gross_amount: 12000 });
  assert.equal(accrualAmount(parent), 1000);
});

test('★★ 母單與子單各算各的期,不會重複算', () => {
  // 兩邊的 amount 都是「這一期認列多少」。母單改用 gross_amount 的話
  // 就會變成 12000 + 子單們,整個爆掉
  const p = buildPnl([], [
    exp({ amount: 1000, deferred: true, gross_amount: 12000 }),
    exp({ amount: 1000, parent_expense_id: 'x' }),
  ], nameOf);
  assert.equal(p.cost.total, 2000);
});

/* ── 科目 ────────────────────────────────────── */

test('★ 一次性收入拆到 fee_type,不要全部擠成「其他收入」', () => {
  // 擠成一列的話,看報表的人要再去營收頁翻一次才知道那三十萬是什麼
  assert.equal(incomeLabel(rev({ source: 'oneoff', fee_type: '垃圾代收費' })), '垃圾代收費');
});

test('一次性但沒填 fee_type 的落回「其他收入」', () => {
  assert.equal(incomeLabel(rev({ source: 'oneoff', fee_type: null })), '其他收入');
});

test('★ 科目查不到就顯示代碼,不要空白', () => {
  const p = buildPnl([], [exp({ account_code: 'ZZZ' })], nameOf);
  assert.equal(p.cost.lines[0].label, 'ZZZ');
});

test('沒有科目的支出落在「未分類」—— 那是要去補的,不是消失', () => {
  const p = buildPnl([], [exp({ account_code: null })], nameOf);
  assert.equal(p.cost.lines[0].label, '未分類');
  assert.equal(p.cost.total, 100);
});

/* ── 排序與欄位 ──────────────────────────────── */

test('★ 科目依金額由大到小 —— 不是字母序', () => {
  // 損益表是拿來找「哪一項特別大」的,字母序會把最大的藏在中間
  const p = buildPnl([], [
    exp({ account_code: 'CLEAN', amount: 100 }),
    exp({ account_code: 'RENT', amount: 900 }),
    exp({ account_code: 'UTIL', amount: 300 }),
  ], nameOf);
  assert.deepEqual(p.cost.lines.map((l) => l.label), ['租金支出', '水電瓦斯', '清潔費']);
});

test('★★ 負數金額按絕對值排 —— 折讓不該沉到最底下', () => {
  const p = buildPnl([], [
    exp({ account_code: 'CLEAN', amount: 100 }),
    exp({ account_code: 'RENT', amount: -900 }),
  ], nameOf);
  assert.equal(p.cost.lines[0].label, '租金支出');
});

test('★★ 這段期間沒有數字的物業不佔一欄', () => {
  // 二十欄裡有十二欄是 0 的時候,人會停止橫向捲動
  const p = buildPnl([rev({ estate_id: 'E1' })], [], nameOf);
  assert.deepEqual(estateColumns(p), ['E1']);
});

test('★ 沒掛物業的收入（辦公室租賃、公司登記）排最後一欄', () => {
  const p = buildPnl([
    rev({ estate_id: 'E1' }),
    rev({ estate_id: null, source: 'office', month_amount: 5000 }),
  ], [], nameOf);
  assert.deepEqual(estateColumns(p), ['E1', '']);
});

test('沒有無物業收入時就不出現那一欄', () => {
  const p = buildPnl([rev({ estate_id: 'E1' })], [exp({ estate_id: 'E1' })], nameOf);
  assert.equal(estateColumns(p).includes(''), false);
});

test('★ 物業欄依毛利由大到小 —— 賠最多的排最右邊看得到', () => {
  const p = buildPnl([
    rev({ estate_id: 'A', month_amount: 100 }),
    rev({ estate_id: 'B', month_amount: 900 }),
  ], [], nameOf);
  assert.deepEqual(estateColumns(p), ['B', 'A']);
});

/* ── 對帳 ────────────────────────────────────── */

test('★★ 三段相加等於本期損益', () => {
  const p = buildPnl(
    [rev({ month_amount: 12345 })],
    [exp({ amount: 2345 }), exp({ amount: 1000, purpose_type: 'office', estate_id: null })],
    nameOf);
  assert.ok(pnlBalances(p));
  assert.equal(p.net, 9000);
});

test('空資料不會爆,而且是 0 不是 NaN', () => {
  const p = buildPnl([], [], nameOf);
  assert.equal(p.net, 0);
  assert.deepEqual(estateColumns(p), []);
  assert.ok(pnlBalances(p));
});

test('金額是字串也要算得出來 —— PostgREST 的 numeric 會回字串', () => {
  const p = buildPnl([rev({ month_amount: '1000.50' })], [exp({ amount: '0.50' })], nameOf);
  assert.equal(p.income.total, 1000.5);
  assert.equal(p.gross.total, 1000);
});
