import { test } from 'node:test';
import assert from 'node:assert/strict';
import { visibleNav, currentNav, groupNav } from './nav.ts';

const NAV = [
  { href: '/attendance', roles: ['cleaner', 'housekeeper', 'accountant', 'manager', 'super_admin'] },
  { href: '/shortterm', roles: ['housekeeper', 'accountant', 'manager', 'super_admin'] },
  { href: '/revenues', roles: ['accountant', 'manager', 'super_admin'] },
  { href: '/otherbooks', roles: ['accountant', 'super_admin'] },
  { href: '/admin', roles: ['accountant', 'super_admin'] },
];

/*
 * ★★ 這一題是整支的重點。
 *   舊版寫 `!role || …`，載入中回的是**全部五項**。
 */
test('載入中一項都不給 —— 不是全開', () => {
  assert.deepEqual(visibleNav(NAV, null, true), []);
  // 就算角色已經有了，loading 還是 true 就先不給（換帳號的那一瞬間）
  assert.deepEqual(visibleNav(NAV, 'housekeeper', true), []);
});

test('查完了但沒有角色 —— 也是一項都不給', () => {
  assert.deepEqual(visibleNav(NAV, null, false), []);
});

test('管家看不到營收表、其他收支帳、權限管理', () => {
  const hrefs = visibleNav(NAV, 'housekeeper', false).map((n) => n.href);
  assert.deepEqual(hrefs, ['/attendance', '/shortterm']);
  for (const h of ['/revenues', '/otherbooks', '/admin']) {
    assert.ok(!hrefs.includes(h), `管家不該看到 ${h}`);
  }
});

test('房務只看得到出勤', () => {
  assert.deepEqual(visibleNav(NAV, 'cleaner', false).map((n) => n.href), ['/attendance']);
});

test('總管理員全部看得到', () => {
  assert.equal(visibleNav(NAV, 'super_admin', false).length, NAV.length);
});

/*
 * ★ 總經理看不到「其他收支帳」與「權限管理」——
 *   這兩項是會計＋總管理員。manager 不在裡面是刻意的（使用者指定）。
 */
test('總經理看不到其他收支帳與權限管理', () => {
  const hrefs = visibleNav(NAV, 'manager', false).map((n) => n.href);
  assert.ok(!hrefs.includes('/otherbooks'));
  assert.ok(!hrefs.includes('/admin'));
});

test('沒登記的角色字串 —— 一項都不給，不是全給', () => {
  assert.deepEqual(visibleNav(NAV, 'intern', false), []);
});

test('選取狀態只在看得到的項目裡找', () => {
  const vis = visibleNav(NAV, 'housekeeper', false);
  // 管家硬打 /revenues:側邊欄不該把「營收表」標成選取中
  assert.equal(currentNav(vis, '/revenues'), undefined);
  assert.equal(currentNav(vis, '/shortterm')?.href, '/shortterm');
  // 子路徑也算
  assert.equal(currentNav(vis, '/attendance/2026-08')?.href, '/attendance');
});


/* ══════════════ 分群（2026-08-28，17 項之後）══════════════ */

const G = [
  { href: '/attendance', roles: ['housekeeper', 'super_admin'], group: '每天' },
  { href: '/cleaning',   roles: ['housekeeper', 'super_admin'], group: '每天' },
  { href: '/shortterm',  roles: ['housekeeper', 'super_admin'], group: '收入' },
  { href: '/expenses',   roles: ['super_admin'],                group: '支出' },
  { href: '/accounts',   roles: ['super_admin'],                group: '支出' },
  { href: '/settings',   roles: ['housekeeper', 'super_admin'] },   // 無標題 = 分隔線
  { href: '/admin',      roles: ['super_admin'] },
];

test('★ 連續相同的分在一起，順序照陣列', () => {
  const g = groupNav(G);
  assert.deepEqual(g.map((x) => x.label), ['每天', '收入', '支出', '']);
  assert.deepEqual(g[0].items.map((i) => i.href), ['/attendance', '/cleaning']);
  assert.deepEqual(g[3].items.map((i) => i.href), ['/settings', '/admin']);
});

test('★★ 用「連續相同」而不是「收集同名」', () => {
  // 同一個名字出現兩段 → 兩群。順序完全由陣列決定,
  // 不會把下面那個偷偷搬到上面去
  const g = groupNav([
    { href: '/a', roles: [], group: 'X' },
    { href: '/b', roles: [], group: 'Y' },
    { href: '/c', roles: [], group: 'X' },
  ]);
  assert.equal(g.length, 3);
  assert.deepEqual(g.map((x) => x.label), ['X', 'Y', 'X']);
});

test('★★ 整群被權限篩空時，標題不會單獨留下來', () => {
  // 管家看不到 /expenses 與 /accounts —— 「支出」那個標題也不該出現。
  // 底下什麼都沒有的標題比不顯示更糟:它明說有這個東西,只是不給你。
  const g = groupNav(visibleNav(G, 'housekeeper', false));
  assert.deepEqual(g.map((x) => x.label), ['每天', '收入', '']);
});

test('沒填 group 的算同一群（空標題）', () => {
  const g = groupNav([{ href: '/a', roles: [] }, { href: '/b', roles: [] }]);
  assert.equal(g.length, 1);
  assert.equal(g[0].label, '');
});

test('空清單回空陣列，不要回一個空群', () => {
  // 回 [{label:'', items:[]}] 的話,畫面會多畫一條沒有意義的分隔線
  assert.deepEqual(groupNav([]), []);
});

test('★ 分群不會弄丟或重複任何一項', () => {
  const flat = groupNav(G).flatMap((x) => x.items);
  assert.deepEqual(flat.map((i) => i.href), G.map((i) => i.href));
});
