import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isExcluded, toggleExcl, exclLabel, newKeys } from './exclude.ts';

const ALL = ['zl', 'sz', 'kf', 'nj', 'ts', 'jp', 'am'];

test('預設全部都在 —— 空陣列不是「什麼都不看」', () => {
  assert.equal(isExcluded([], 'zl'), false);
  assert.equal(exclLabel([]), '全部物業');
});

test('點一下排除、再點一下放回來', () => {
  let e = toggleExcl([], 'am', ALL)!;
  assert.deepEqual(e, ['am']);
  assert.equal(isExcluded(e, 'am'), true);
  e = toggleExcl(e, 'am', ALL)!;
  assert.deepEqual(e, []);
});

test('★ 順序照物業清單，不是照點擊順序', () => {
  let e = toggleExcl([], 'am', ALL)!;
  e = toggleExcl(e, 'zl', ALL)!;
  assert.deepEqual(e, ['zl', 'am']);          // 不是 ['am','zl']
});

test('★★★ 不准把全部都排除掉 —— 回 null，畫面才講得出為什麼按不動', () => {
  let e: string[] = [];
  for (const k of ALL.slice(0, 6)) e = toggleExcl(e, k, ALL)!;
  assert.equal(e.length, 6);
  // 第七個會把全部排光 → 擋住
  assert.equal(toggleExcl(e, ALL[6], ALL), null);
  // 但「放回來」永遠可以
  assert.deepEqual(toggleExcl(e, ALL[0], ALL), ALL.slice(1, 6));
});

test('排除狀態的字：兩個以內寫名字，三個以上寫數量', () => {
  assert.equal(exclLabel(['亞曼尼']), '排除 亞曼尼');
  assert.equal(exclLabel(['亞曼尼', 'JPR']), '排除 亞曼尼、JPR');
  assert.equal(exclLabel(['亞曼尼', 'JPR', '台視']), '排除 3 個物業');
});

/* ── newKeys（「排除新增項目」的底層，還沒接畫面）── */

test('★★ 新增項目 ＝ 上一期 0、這一期有數字', () => {
  const cur = { a: 100, b: 0, c: 50, d: 80 };
  const prev = { a: 90, b: 0, c: 0 };            // d 連 key 都沒有
  assert.deepEqual(newKeys(cur, prev), ['c', 'd']);
});

test('★ 這一期也是 0 的不算新增（它兩期都沒有）', () => {
  assert.deepEqual(newKeys({ a: 0 }, { a: 0 }), []);
});

test('★ 負數（折讓）也算有數字 —— 它一樣會讓環比變成除以 0', () => {
  assert.deepEqual(newKeys({ a: -5 }, {}), ['a']);
});

test('空的不要爆', () => {
  assert.deepEqual(newKeys({}, {}), []);
});
