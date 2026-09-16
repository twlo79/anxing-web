import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALERT_WINDOWS, DEFAULT_WINDOW, WIN_ALL, winLabel, winDays, parseWin,
  contractTypeLabel, isBizContract, splitContractExits,
  daysLabel, exitTone, HOT_DAYS, WARM_DAYS,
  canSeeAlerts, ALERT_ROLES,
} from './hk-alerts.ts';
import { exitsSoon, type Stay, type Exit } from './room-calendar.ts';

function c(id: string, room: string, end: string, ctype: string | null): Stay {
  return {
    id: `c${id}`, srcId: id, room, kind: 'contract',
    start: '2025-01-01', end, tone: 'longterm', ctype,
  };
}
const exit = (s: Stay, days: number): Exit => ({ stay: s, on: s.end!, days });

/* ── 天數窗口 ───────────────────────────────────────────── */

test('窗口選項含「全部」', () => {
  assert.deepEqual([...ALERT_WINDOWS], [7, 14, 30, 45, 0]);
  assert.equal(winLabel(0), '全部');
  assert.equal(winLabel(45), '45 天');
});

test('★ 預設是 45 —— 使用者心裡的退租門檻', () => {
  assert.equal(DEFAULT_WINDOW, 45);
  assert.ok((ALERT_WINDOWS as readonly number[]).includes(DEFAULT_WINDOW));
});

test('★ 「全部」轉成有限的上界，不是 Infinity', () => {
  assert.equal(winDays(0), WIN_ALL);
  assert.ok(Number.isFinite(winDays(0)));
  assert.equal(winDays(30), 30);
});

test('parseWin 認得網址上的數字', () => {
  assert.equal(parseWin('45'), 45);
  assert.equal(parseWin('7'), 7);
  assert.equal(parseWin('0'), 0);
});

test('★ 清單裡拿掉的數字（90／180）回預設，不是照單全收', () => {
  assert.equal(parseWin('90'), DEFAULT_WINDOW);
  assert.equal(parseWin('180'), DEFAULT_WINDOW);
});

test('★ parseWin 認不得就回預設，不是回 0（＝全部）', () => {
  assert.equal(parseWin('abc'), DEFAULT_WINDOW);
  assert.equal(parseWin(''), DEFAULT_WINDOW);
  assert.equal(parseWin(null), DEFAULT_WINDOW);
  assert.equal(parseWin(undefined), DEFAULT_WINDOW);
  assert.equal(parseWin('999'), DEFAULT_WINDOW);
  assert.equal(parseWin('-7'), DEFAULT_WINDOW);
});

test('★ parseWin 不會把 "" 當成 0', () => {
  // Number('') === 0，所以這一條特別容易寫錯 —— 空字串會變成「全部」
  assert.notEqual(parseWin(''), 0);
});

/* ── 契約類別 ───────────────────────────────────────────── */

test('公司登記與辦公室算「沒有人住」的那一類', () => {
  assert.equal(isBizContract('company'), true);
  assert.equal(isBizContract('office'), true);
});

test('長租不算', () => {
  assert.equal(isBizContract('longterm'), false);
});

test('★★★ 沒填或不認得的類別掉進退租那塊，不是消失', () => {
  assert.equal(isBizContract(null), false);
  assert.equal(isBizContract(undefined), false);
  assert.equal(isBizContract(''), false);
  assert.equal(isBizContract('短期辦公'), false);   // 日後新增的類別
});

test('類別的中文跟契約頁同一組', () => {
  assert.equal(contractTypeLabel('longterm'), '長租');
  assert.equal(contractTypeLabel('company'), '公司登記');
  assert.equal(contractTypeLabel('office'), '辦公室');
});

test('★ 認不得的類別印原字串，不印空白', () => {
  assert.equal(contractTypeLabel('weird'), 'weird');
  assert.equal(contractTypeLabel(null), '未分類');
  assert.equal(contractTypeLabel(''), '未分類');
});

/* ── 分堆 ───────────────────────────────────────────────── */

test('分成退租與契約結束兩堆', () => {
  const list = [
    exit(c('1', '8A2', '2026-11-25', 'longterm'), 70),
    exit(c('2', '7A5', '2026-09-30', 'company'), 14),
    exit(c('3', 'B01', '2026-12-31', 'office'), 106),
  ];
  const { lease, biz } = splitContractExits(list);
  assert.deepEqual(lease.map((e) => e.stay.room), ['8A2']);
  assert.deepEqual(biz.map((e) => e.stay.room), ['7A5', 'B01']);
});

test('★★★ 兩堆加起來就是全部 —— 沒有一筆會消失', () => {
  const list = [
    exit(c('1', 'A', '2026-10-01', 'longterm'), 15),
    exit(c('2', 'B', '2026-10-01', 'company'), 15),
    exit(c('3', 'C', '2026-10-01', null), 15),
    exit(c('4', 'D', '2026-10-01', '未來新增的類別'), 15),
  ];
  const { lease, biz } = splitContractExits(list);
  assert.equal(lease.length + biz.length, list.length);
});

test('空清單回兩個空陣列，不是 undefined', () => {
  const { lease, biz } = splitContractExits([]);
  assert.deepEqual(lease, []);
  assert.deepEqual(biz, []);
});

test('分堆保留原本的排序（近的在前）', () => {
  const list = [
    exit(c('1', 'A', '2026-09-20', 'longterm'), 4),
    exit(c('2', 'B', '2026-10-20', 'longterm'), 34),
    exit(c('3', 'C', '2026-11-20', 'longterm'), 65),
  ];
  assert.deepEqual(splitContractExits(list).lease.map((e) => e.days), [4, 34, 65]);
});

test('★ 跟 exitsSoon 串起來：公司登記不會出現在退租清單裡', () => {
  const stays = [
    c('1', '8A2', '2026-10-05', 'longterm'),
    c('2', '7A5', '2026-10-05', 'company'),
  ];
  const all = exitsSoon(stays, '2026-09-16', 'contract', 30);
  assert.equal(all.length, 2);
  const { lease, biz } = splitContractExits(all);
  assert.equal(lease.length, 1);
  assert.equal(biz.length, 1);
  assert.equal(lease[0].stay.room, '8A2');
});

test('★ 沒有房號的公司登記照樣進得了清單', () => {
  const s = c('9', '', '2026-10-07', 'company');
  const all = exitsSoon([s], '2026-09-16', 'contract', 30);
  assert.equal(all.length, 1);
  assert.equal(splitContractExits(all).biz.length, 1);
});

/* ── 畫面上的字 ─────────────────────────────────────────── */

test('daysLabel', () => {
  assert.equal(daysLabel(19), '還有 19 天');
  assert.equal(daysLabel(1), '還有 1 天');
});

test('★ 0 是「就是今天」，不是「還有 0 天」', () => {
  assert.equal(daysLabel(0), '就是今天');
});

test('負數不印成「還有 -3 天」', () => {
  assert.equal(daysLabel(-3), '已經過了 3 天');
});

test('★★★ 標色的門檻固定，不跟著窗口跑', () => {
  assert.equal(exitTone(0), 'hot');
  assert.equal(exitTone(HOT_DAYS), 'hot');
  assert.equal(exitTone(HOT_DAYS + 1), 'warm');
  assert.equal(exitTone(WARM_DAYS), 'warm');
  assert.equal(exitTone(WARM_DAYS + 1), 'calm');
  assert.equal(exitTone(180), 'calm');
});

/* ── 權限 ───────────────────────────────────────────────── */

test('管家會計主管總經理看得到', () => {
  for (const r of ['housekeeper', 'accountant', 'manager', 'super_admin']) {
    assert.equal(canSeeAlerts(r), true, r);
  }
});

test('★★ 房務看不到 —— 他們不管退租退房', () => {
  assert.equal(canSeeAlerts('cleaner'), false);
});

test('★ 沒登入／沒讀到權限的時候看不到，不是預設看得到', () => {
  assert.equal(canSeeAlerts(null), false);
  assert.equal(canSeeAlerts(undefined), false);
  assert.equal(canSeeAlerts(''), false);
});

test('★★ 名單裡有管家 —— 房務管理現有的 canEdit 沒有他', () => {
  assert.ok((ALERT_ROLES as readonly string[]).includes('housekeeper'));
});
