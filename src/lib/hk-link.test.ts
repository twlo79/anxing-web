import test from 'node:test';
import assert from 'node:assert/strict';
import { normKey, isSubseq, guessLink, rankNames } from './hk-link.ts';

/* ── 拉平 ────────────────────────────────────── */

test('全形數字與英文轉半形', () => {
  assert.equal(normKey('ＪＰＲ１'), 'JPR1');
});

test('空白不算', () => {
  assert.equal(normKey('開封 4F'), '開封4F');
  assert.equal(normKey('開封　4F'), '開封4F');   // 全形空白
});

/* ── 子序列 ──────────────────────────────────── */

test('★ 縮寫是原名的子序列', () => {
  assert.ok(isSubseq('開4', '開封4F'));
  assert.ok(isSubseq('JPR1', 'JPR1F'));
  assert.ok(isSubseq('開2-1', '開封2-1'));
});

test('順序反了就不算', () => {
  assert.equal(isSubseq('4開', '開封4F'), false);
});

test('空字串不算對上 —— 不然它會對上每一個', () => {
  assert.equal(isSubseq('', '開封4F'), false);
});

/* ── 唯一候選 ────────────────────────────────── */

const ERP = ['開封4F', '開封3F', '開封2-1', '開封2-2', '開封2F', '開封整棟',
  'JPR1F', 'JPR2F', 'JPR整棟', '時兆A15'];

test('★★ 唯一對得上的才給提示', () => {
  assert.equal(guessLink('開4', [], ERP), '開封4F');
  assert.equal(guessLink('JPR1', [], ERP), 'JPR1F');
});

test('★★ 不只一個對得上就不提示 —— 那正是人要看的', () => {
  // 「開2」同時像 開封2-1、開封2-2、開封2F。給一個看起來很有把握的錯誤提示,
  // 比什麼都不給更容易被按下去
  assert.equal(guessLink('開2', [], ERP), null);
});

test('★ 完全相同的優先,不受其他候選干擾', () => {
  assert.equal(guessLink('JPR整棟', [], ERP), 'JPR整棟');
});

test('別名一起試 —— 別名本來就是為了比對而存在的', () => {
  assert.equal(guessLink('開整棟', ['開封整棟'], ERP), '開封整棟');
});

test('對不到就回 null,不退而求其次', () => {
  assert.equal(guessLink('復興', [], ERP), null);
});

test('沒有代碼也沒有別名時不提示', () => {
  assert.equal(guessLink('', [], ERP), null);
});

/* ── 排序 ────────────────────────────────────── */

test('★ 對得上的排到選單最前面', () => {
  const r = rankNames('開4', [], ERP);
  assert.equal(r[0], '開封4F');
  assert.equal(r.length, ERP.length, '一個都不能少 —— 排序不是篩選');
});

test('對不上的維持原本順序', () => {
  const r = rankNames('完全不相干', [], ERP);
  assert.deepEqual(r, ERP);
});
