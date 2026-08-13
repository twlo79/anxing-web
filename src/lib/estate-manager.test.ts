import test from 'node:test';
import assert from 'node:assert/strict';
import {
  covers, managerIdOn, overlaps, checkTenure, handoverPatch, tenureLabel,
  type Tenure,
} from './estate-manager.ts';

const t = (p: Partial<Tenure> = {}): Tenure => ({
  id: 't1', estate_id: 'e1', staff_id: '小美',
  start_date: '2026-01-01', end_date: '2026-06-30', ...p,
});

/* ── 涵蓋 ────────────────────────────────────── */

test('起訖含頭含尾', () => {
  const x = t();
  assert.equal(covers(x, '2026-01-01'), true, '起日當天算');
  assert.equal(covers(x, '2026-06-30'), true, '迄日當天算');
  assert.equal(covers(x, '2025-12-31'), false);
  assert.equal(covers(x, '2026-07-01'), false);
});

test('迄日是 null 代表至今', () => {
  const x = t({ end_date: null });
  assert.equal(covers(x, '2030-01-01'), true);
  assert.equal(covers(x, '2025-12-31'), false, '起日之前還是不算');
});

/* ── 那天是誰 ────────────────────────────────── */

const 小美 = t({ id: 'a', staff_id: '小美', start_date: '2026-01-01', end_date: '2026-06-30' });
const 阿華 = t({ id: 'b', staff_id: '阿華', start_date: '2026-07-01', end_date: null });

test('★★ 換手前後查到不同的人 —— 這就是整件事的目的', () => {
  // 改管家不能動到歷史:小美 1~6 月的評價永遠是小美的
  const all = [小美, 阿華];
  assert.equal(managerIdOn(all, 'e1', '2026-06-20'), '小美');
  assert.equal(managerIdOn(all, 'e1', '2026-07-10'), '阿華');
});

test('★ 交接當天只有一個人', () => {
  const all = [小美, 阿華];
  assert.equal(managerIdOn(all, 'e1', '2026-06-30'), '小美', '前任的最後一天');
  assert.equal(managerIdOn(all, 'e1', '2026-07-01'), '阿華', '新任的第一天');
});

test('★ 登記之前查不到人,而且不能退回現任', () => {
  // 退回現任等於把歷史又算到他頭上 —— 那正是這整件事要解決的問題
  assert.equal(managerIdOn([小美, 阿華], 'e1', '2025-01-01'), null);
});

test('別的物業不會被查到', () => {
  assert.equal(managerIdOn([小美], 'e2', '2026-03-01'), null);
});

test('沒有物業或沒有日期時回 null,不要爆掉', () => {
  assert.equal(managerIdOn([小美], null, '2026-03-01'), null);
  assert.equal(managerIdOn([小美], 'e1', null), null);
});

/* ── 重疊 ────────────────────────────────────── */

test('★ 正常交接不算重疊', () => {
  // 前一段迄日 6/30、後一段起日 7/1。算成重疊的話,
  // 每一次正常的交接都會被擋下來 —— 那等於這個功能不能用
  assert.equal(overlaps(小美, 阿華), false);
});

test('★★ 同一天有兩個人就是重疊', () => {
  const 重疊 = t({ id: 'c', staff_id: '阿華', start_date: '2026-06-30', end_date: null });
  assert.equal(overlaps(小美, 重疊), true);
});

test('包含在裡面的也算重疊', () => {
  const 中間 = t({ id: 'c', start_date: '2026-03-01', end_date: '2026-04-01' });
  assert.equal(overlaps(小美, 中間), true);
});

test('兩段都「至今」一定重疊', () => {
  const a = t({ id: 'a', start_date: '2020-01-01', end_date: null });
  const b = t({ id: 'b', start_date: '2026-01-01', end_date: null });
  assert.equal(overlaps(a, b), true);
});

/* ── 存檔前的檢查 ────────────────────────────── */

test('填齊而且沒有重疊就過', () => {
  assert.equal(checkTenure(
    { staff_id: '阿華', start_date: '2026-07-01', end_date: null }, [小美]), null);
});

test('沒選管家、沒填起日都要擋', () => {
  assert.match(checkTenure({ staff_id: '', start_date: '2026-07-01', end_date: null }, [])!, /管家/);
  assert.match(checkTenure({ staff_id: '阿華', start_date: '', end_date: null }, [])!, /起日/);
});

test('迄日早於起日要擋', () => {
  const e = checkTenure(
    { staff_id: '阿華', start_date: '2026-07-01', end_date: '2026-06-01' }, []);
  assert.match(e!, /填反/);
});

test('★ 重疊時要講出該怎麼做,不是只說不行', () => {
  // 只說「重疊」的話,使用者不知道下一步 —— 他會一直改日期試
  const e = checkTenure(
    { staff_id: '阿華', start_date: '2026-06-15', end_date: null }, [小美]);
  assert.ok(e);
  assert.match(e!, /前一段的迄日/);
});

/* ── 接手時自動補前一段的迄日 ────────────────── */

test('★★ 接手日的前一天 —— 這個減一天最容易錯', () => {
  // 讓使用者自己算的話:填成同一天就重疊,填成兩天前就有一天沒人管,
  // 兩種都不會被發現
  const p = handoverPatch([t({ id: 'open', end_date: null, start_date: '2026-01-01' })],
    'e1', '2026-07-01');
  assert.deepEqual(p, { id: 'open', end_date: '2026-06-30' });
});

test('跨月與跨年的減一天都要對', () => {
  const open = [t({ id: 'open', end_date: null, start_date: '2020-01-01' })];
  assert.equal(handoverPatch(open, 'e1', '2026-03-01')?.end_date, '2026-02-28');
  assert.equal(handoverPatch(open, 'e1', '2026-01-01')?.end_date, '2025-12-31');
});

test('沒有現任就沒有東西要補', () => {
  assert.equal(handoverPatch([小美], 'e1', '2026-07-01'), null);
});

test('接手日比前一段起日還早時不亂補,交給檢查擋', () => {
  const open = [t({ id: 'open', end_date: null, start_date: '2026-05-01' })];
  assert.equal(handoverPatch(open, 'e1', '2026-01-01'), null);
});

test('顯示文字', () => {
  assert.equal(tenureLabel(小美), '2026-01-01 ~ 2026-06-30');
  assert.equal(tenureLabel(阿華), '2026-07-01 ~ 至今');
});
