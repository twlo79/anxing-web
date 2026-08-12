import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeText, noticeContentChanged } from './notice.ts';

test('正規化：頭尾空白與連續空白不算差異', () => {
  assert.equal(normalizeText('  下次開會   週五 10:00 '), '下次開會 週五 10:00');
  assert.equal(normalizeText(null), '');
});

test('★ 只多打一個空格不算內容變了', () => {
  // 不擋的話,游標亂點一下就會讓十幾個人的畫面冒出未讀圓點,
  // 而使用者根本不知道自己改了什麼
  const a = { title: '重要日程', body: '下次開會 週三 10:00' };
  assert.equal(noticeContentChanged(a, { title: '重要日程', body: '下次開會  週三 10:00' }), false);
  assert.equal(noticeContentChanged(a, { title: ' 重要日程 ', body: '下次開會 週三 10:00\n' }), false);
});

test('★ 開會時間改了就是變了', () => {
  const a = { title: '重要日程', body: '下次開會 週三 10:00' };
  assert.equal(noticeContentChanged(a, { title: '重要日程', body: '下次開會 週五 10:00' }), true);
});

test('標題變了也算', () => {
  const a = { title: '重要日程', body: '同樣的內容' };
  assert.equal(noticeContentChanged(a, { title: '本週日程', body: '同樣的內容' }), true);
});

test('★ 新發布的公告不需要「重設已讀」', () => {
  // 本來就全員未讀。跳出一個「要不要重新通知」只會讓人困惑
  assert.equal(noticeContentChanged(null, { title: 'A', body: 'B' }), false);
  assert.equal(noticeContentChanged(undefined, { title: 'A', body: 'B' }), false);
});

test('★ 置頂與下架不算內容變了', () => {
  // 把舊公告下架再上架,不該要求所有人重看一次
  const a = { title: '重要日程', body: '下次開會 週三 10:00' };
  assert.equal(noticeContentChanged(a, { title: '重要日程', body: '下次開會 週三 10:00' }), false);
});

test('空內容與 null 視為相同 —— 不要因為型別差異誤判', () => {
  assert.equal(noticeContentChanged({ title: 'A', body: null }, { title: 'A', body: '' }), false);
});
