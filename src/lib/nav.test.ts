import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  visibleNav, currentNav, groupNav, groupOpen, toggleGroup, parseCollapsed,
} from './nav.ts';

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

/* ══════════════ 群組收合（2026-08-28）══════════════ */

const INCOME = {
  label: '收入',
  items: [{ href: '/shortterm', roles: [] }, { href: '/contracts', roles: [] }],
};

test('沒被收起來就是開的', () => {
  assert.equal(groupOpen(INCOME, [], '/attendance'), true);
});

test('被收起來就是關的', () => {
  assert.equal(groupOpen(INCOME, ['收入'], '/attendance'), false);
});

test('★★ 收起來了，但目前這一頁在裡面 → 還是要展開', () => {
  // 從書籤或通知直接進 /shortterm。照收合狀態畫的話,
  // 側邊欄會完全看不出他在哪一頁 —— 沒有任何一項是選取狀態。
  assert.equal(groupOpen(INCOME, ['收入'], '/shortterm'), true);
});

test('★ 子路徑也算在裡面（用 startsWith，跟 currentNav 同一套）', () => {
  assert.equal(groupOpen(INCOME, ['收入'], '/shortterm/123'), true);
});

test('★★ 沒有標題的那一群永遠是開的 —— 沒有把手就打不開', () => {
  // 設定與權限管理那一組只有一條分隔線,沒有地方放三角形。
  // 若它收得起來,收掉之後那兩項就永遠找不回來了。
  const tail = { label: '', items: [{ href: '/settings', roles: [] }] };
  assert.equal(groupOpen(tail, [''], '/attendance'), true);
});

test('★ groupOpen 不會去改傳進來的收合清單', () => {
  const c = ['收入'];
  groupOpen(INCOME, c, '/shortterm');
  assert.deepEqual(c, ['收入']);
});

test('toggleGroup 是開關，而且回新陣列', () => {
  const a: string[] = [];
  const b = toggleGroup(a, '收入');
  assert.deepEqual(b, ['收入']);
  assert.deepEqual(a, []);                     // 原本那個沒被動到
  assert.deepEqual(toggleGroup(b, '收入'), []); // 再按一次收回去
});

test('toggleGroup 只動指定的那一群', () => {
  assert.deepEqual(toggleGroup(['收入', '經營'], '收入'), ['經營']);
});

test('★★ localStorage 的內容壞掉時要回空陣列，不能丟例外', () => {
  // 側邊欄掛掉 = 全站白畫面。使用者手動改過、或舊版存了別的形狀,
  // 都不該讓整個 app 打不開。
  assert.deepEqual(parseCollapsed(null), []);
  assert.deepEqual(parseCollapsed(''), []);
  assert.deepEqual(parseCollapsed('不是 json'), []);
  assert.deepEqual(parseCollapsed('{"收入":true}'), []);   // 物件不是陣列
  assert.deepEqual(parseCollapsed('"收入"'), []);          // 字串不是陣列
  assert.deepEqual(parseCollapsed('123'), []);
});

test('★ 陣列裡混進非字串的，濾掉而不是整份丟棄', () => {
  // 全丟的話,一顆壞掉的值會把使用者收好的其他群一起清空。
  assert.deepEqual(parseCollapsed('["收入",null,3,"經營"]'), ['收入', '經營']);
});

test('parseCollapsed 讀得回 toggleGroup 存進去的東西', () => {
  const saved = toggleGroup(toggleGroup([], '收入'), '經營');
  assert.deepEqual(parseCollapsed(JSON.stringify(saved)), ['收入', '經營']);
});
