import { test } from 'node:test';
import assert from 'node:assert/strict';
import { visibleNav, currentNav } from './nav.ts';

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
