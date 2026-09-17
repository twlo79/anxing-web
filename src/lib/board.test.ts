import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SECRET_ROLES, canSeeSecrets, SECRET_DENIED,
  EVENT_KINDS, KIND_LABEL, isEventKind, parseEventKind, kindLabel,
  eventOrder, nextEvent, isPast, daysUntil, untilLabel, fmtEventWhen,
  FILE_ACCEPT, fileKind, KIND_BADGE, canPreview, whyNoPreview,
  fmtSize, FILE_MAX_MB, fileTooBig,
} from './board.ts';

/* ── 誰看得到帳密 ─────────────────────────────────────────── */

test('★★★ 房務看不到帳密，其餘四種看得到（使用者 2026-09-17）', () => {
  assert.equal(canSeeSecrets('cleaner'), false);
  assert.equal(canSeeSecrets('housekeeper'), true);
  assert.equal(canSeeSecrets('accountant'), true);
  assert.equal(canSeeSecrets('manager'), true);
  assert.equal(canSeeSecrets('super_admin'), true);
});

test('★★ 是白名單不是黑名單 —— 沒見過的角色預設看不到', () => {
  assert.equal(canSeeSecrets('intern'), false);
  assert.equal(canSeeSecrets('vendor'), false);
  assert.equal(canSeeSecrets(''), false);
  assert.equal(canSeeSecrets(null), false);
  assert.equal(canSeeSecrets(undefined), false);
  assert.equal(canSeeSecrets(0), false);
  assert.equal(canSeeSecrets({ role: 'super_admin' }), false);
});

test('★ 大小寫不同也不放行 —— role 是資料庫的列舉，不是人打的字', () => {
  assert.equal(canSeeSecrets('SUPER_ADMIN'), false);
  assert.equal(canSeeSecrets('Manager'), false);
});

test('白名單裡剛好四種，房務不在裡面', () => {
  assert.equal(SECRET_ROLES.length, 4);
  assert.ok(!(SECRET_ROLES as readonly string[]).includes('cleaner'));
});

test('★ 看不到的時候有話講，不是一片空白', () => {
  assert.ok(SECRET_DENIED.length > 10);
  assert.match(SECRET_DENIED, /權限/);
});

/* ── 活動種類 ─────────────────────────────────────────────── */

test('兩種活動', () => {
  assert.deepEqual([...EVENT_KINDS], ['meeting', 'gathering']);
  assert.equal(KIND_LABEL.meeting, '開會');
  assert.equal(KIND_LABEL.gathering, '團聚');
});

test('isEventKind 只認得那兩個', () => {
  assert.equal(isEventKind('meeting'), true);
  assert.equal(isEventKind('gathering'), true);
  assert.equal(isEventKind('party'), false);
  assert.equal(isEventKind(null), false);
});

test('★ 認不得的當開會 —— 回 null 的話那一筆會沒有標籤', () => {
  assert.equal(parseEventKind('party'), 'meeting');
  assert.equal(parseEventKind(null), 'meeting');
  assert.equal(parseEventKind(''), 'meeting');
  assert.equal(kindLabel('gathering'), '團聚');
  assert.equal(kindLabel(undefined), '開會');
});

/* ── 排序 ─────────────────────────────────────────────────── */

const E = (id: string, starts: string, created = '2026-09-01T00:00:00+08:00') =>
  ({ id, kind: 'meeting', starts_at: starts, created_at: created });

test('★★ 最新排在上方（使用者 2026-09-17）—— 照日期由新到舊', () => {
  const got = eventOrder([
    E('a', '2026-09-03T10:00:00+08:00'),
    E('c', '2026-12-27T18:00:00+08:00'),
    E('b', '2026-09-24T14:00:00+08:00'),
  ]).map((x) => x.id);
  assert.deepEqual(got, ['c', 'b', 'a']);
});

test('★ 已過的自然沉到最底下 —— 不需要封存按鈕', () => {
  const got = eventOrder([
    E('past', '2026-07-19T00:00:00+08:00'),
    E('soon', '2026-10-11T18:30:00+08:00'),
  ]).map((x) => x.id);
  assert.deepEqual(got, ['soon', 'past']);
});

test('同一天看建立時間，新的在上', () => {
  const got = eventOrder([
    E('old', '2026-09-24T14:00:00+08:00', '2026-09-01T09:00:00+08:00'),
    E('new', '2026-09-24T14:00:00+08:00', '2026-09-10T09:00:00+08:00'),
  ]).map((x) => x.id);
  assert.deepEqual(got, ['new', 'old']);
});

test('★ 不改動傳進來的陣列', () => {
  const src = [E('a', '2026-09-03T10:00:00+08:00'), E('b', '2026-12-27T18:00:00+08:00')];
  eventOrder(src);
  assert.deepEqual(src.map((x) => x.id), ['a', 'b']);
});

test('壞掉的日期不會讓整份排序爆掉', () => {
  const got = eventOrder([
    E('bad', 'not-a-date'),
    E('good', '2026-09-24T14:00:00+08:00'),
  ]).map((x) => x.id);
  assert.deepEqual(got, ['good', 'bad']);
});

/* ── 下一場 ───────────────────────────────────────────────── */

const NOW = new Date('2026-09-17T11:00:00+08:00');

test('★★★ 下一場不是列表最上面那一筆', () => {
  const list = [
    E('far', '2026-12-27T18:00:00+08:00'),
    E('next', '2026-09-24T14:00:00+08:00'),
    E('past', '2026-09-03T10:00:00+08:00'),
  ];
  // 最上面的是 12/27（日期最遠）
  assert.equal(eventOrder(list)[0].id, 'far');
  // 但下一場是 9/24
  assert.equal(nextEvent(list, NOW)?.id, 'next');
});

test('全部都過去了 → 沒有下一場', () => {
  assert.equal(nextEvent([E('a', '2026-01-01T10:00:00+08:00')], NOW), null);
});

test('空清單 → null，不是丟錯', () => {
  assert.equal(nextEvent([], NOW), null);
});

test('★ 今天稍晚的那一場算下一場', () => {
  const list = [E('later', '2026-09-17T18:00:00+08:00')];
  assert.equal(nextEvent(list, NOW)?.id, 'later');
});

/* ── 還有幾天 ─────────────────────────────────────────────── */

test('isPast', () => {
  assert.equal(isPast('2026-09-03T10:00:00+08:00', NOW), true);
  assert.equal(isPast('2026-09-24T14:00:00+08:00', NOW), false);
});

test('★★★ 今天下午的會是「就是今天」，不是「還有 0 天」', () => {
  // 現在 9/17 11:00，會議 9/17 14:00 —— 時間差只有 3 小時
  assert.equal(daysUntil('2026-09-17T14:00:00+08:00', NOW), 0);
  assert.equal(untilLabel('2026-09-17T14:00:00+08:00', NOW), '就是今天');
});

test('★★ 明天早上八點是「還有 1 天」，即使不到 24 小時', () => {
  // 9/17 11:00 → 9/18 08:00 只有 21 小時
  assert.equal(daysUntil('2026-09-18T08:00:00+08:00', NOW), 1);
  assert.equal(untilLabel('2026-09-18T08:00:00+08:00', NOW), '還有 1 天');
});

test('七天後', () => {
  assert.equal(untilLabel('2026-09-24T14:00:00+08:00', NOW), '還有 7 天');
});

test('過去的寫「已過」', () => {
  assert.equal(untilLabel('2026-09-03T10:00:00+08:00', NOW), '已過');
});

test('壞掉的日期回 0，不丟錯', () => {
  assert.equal(daysUntil('nope', NOW), 0);
});

/* ── 顯示 ─────────────────────────────────────────────────── */

test('9/24 是星期四', () => {
  assert.equal(fmtEventWhen('2026-09-24T14:00:00+08:00'), '9/24（四） 14:00');
});

test('★ 沒有時間就不畫時間 —— 補 00:00 看起來像半夜要開會', () => {
  assert.equal(fmtEventWhen('2026-07-19T00:00:00+08:00', false), '7/19（日）');
});

test('壞掉的日期畫破折號', () => {
  assert.equal(fmtEventWhen('nope'), '—');
});

/* ── 檔案 ─────────────────────────────────────────────────── */

test('兩種都收', () => {
  assert.match(FILE_ACCEPT, /\.pdf/);
  assert.match(FILE_ACCEPT, /\.docx/);
});

test('★★ 照副檔名判，不照 MIME —— Windows 傳上來的 docx 常常沒有 MIME', () => {
  assert.equal(fileKind('議程.pdf'), 'pdf');
  assert.equal(fileKind('議程.PDF'), 'pdf');
  assert.equal(fileKind('九月營收.docx'), 'word');
  assert.equal(fileKind('九月營收.DOCX'), 'word');
  assert.equal(fileKind('舊檔.doc'), 'word');
  assert.equal(fileKind('資料.xlsx'), 'other');
  assert.equal(fileKind(''), 'other');
});

test('★★★ PDF 標「原樣」、Word 標「預覽」—— 這兩個字是整個檔案功能的重點', () => {
  assert.equal(KIND_BADGE.pdf?.t, '原樣');
  assert.equal(KIND_BADGE.word?.t, '預覽');
  assert.equal(KIND_BADGE.other, null);
  // Word 的說明要講出排版會走樣
  assert.match(KIND_BADGE.word!.hint, /排版跟原檔不一樣/);
});

test('★★ .doc 是舊格式，解不開 —— 不要畫一個點了沒反應的連結', () => {
  assert.equal(canPreview('議程.pdf'), true);
  assert.equal(canPreview('九月營收.docx'), true);
  assert.equal(canPreview('舊檔.doc'), false);
  assert.equal(canPreview('資料.xlsx'), false);
});

test('★ 打不開的時候要講得出為什麼、還有怎麼辦', () => {
  assert.match(whyNoPreview('舊檔.doc'), /舊版 Word/);
  assert.match(whyNoPreview('舊檔.doc'), /另存成/);
  assert.match(whyNoPreview('資料.xlsx'), /只能下載/);
});

test('檔案大小', () => {
  assert.equal(fmtSize(0), '');
  assert.equal(fmtSize(null), '');
  assert.equal(fmtSize(512), '512 B');
  assert.equal(fmtSize(1536), '2 KB');
  assert.equal(fmtSize(3 * 1024 * 1024), '3.0 MB');
});

test('★ 25MB 以內放行', () => {
  assert.equal(fileTooBig(1024 * 1024).bad, false);
  assert.equal(fileTooBig(FILE_MAX_MB * 1024 * 1024).bad, false);
});

test('★★ 太大的要擋，而且要講怎麼辦', () => {
  const r = fileTooBig(200 * 1024 * 1024);
  assert.equal(r.bad, true);
  assert.match(r.why, /200\.0 MB/);
  assert.match(r.why, /壓縮|拆成/);
});
