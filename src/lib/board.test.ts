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

/* ── 備註裡的網址（2026-09-17）────────────────────────────── */

import { linkify, urlHref, urlLabel, eventShareText, lineShareUrl, shareVia,
  canUpload, filesByPerson } from './board.ts';

const kinds = (t: string) => linkify(t).map((p) => `${p.kind}:${p.v}`);

test('純文字 —— 一段，不切', () => {
  assert.deepEqual(kinds('六點在店門口集合，遲到請先跟芊說'),
    ['text:六點在店門口集合，遲到請先跟芊說']);
});

test('純網址 —— 一段', () => {
  assert.deepEqual(kinds('https://maps.app.goo.gl/abc'), ['url:https://maps.app.goo.gl/abc']);
});

test('混合 —— 前中後三段', () => {
  assert.deepEqual(kinds('KIGAI 微風店 https://maps.app.goo.gl/abc 六點集合'),
    ['text:KIGAI 微風店 ', 'url:https://maps.app.goo.gl/abc', 'text: 六點集合']);
});

test('★★★ 中文沒有空白 —— 句號之後的字不可以被吃進網址', () => {
  /*
   * 第一版寫 `[^\s]+`（不是空白就算）—— 而中文句子裡沒有空白，
   * 整句話從句號到句尾全被吃進網址裡：連結是壞的、後面那句也不見了。
   */
  assert.deepEqual(kinds('地點 https://maps.app.goo.gl/abc。記得帶名片'),
    ['text:地點 ', 'url:https://maps.app.goo.gl/abc', 'text:。記得帶名片']);
});

test('★★ 括號包住的網址，右括號不算網址', () => {
  assert.deepEqual(kinds('看這裡(https://x.co/a)好嗎'),
    ['text:看這裡(', 'url:https://x.co/a', 'text:)好嗎']);
});

test('★ 沒打 https:// 的 www. 也認', () => {
  assert.deepEqual(kinds('餐廳官網 www.kigai.com.tw 可以先看菜單'),
    ['text:餐廳官網 ', 'url:www.kigai.com.tw', 'text: 可以先看菜單']);
});

test('兩條網址都要切出來', () => {
  const r = linkify('地圖 https://maps.app.goo.gl/a 菜單 https://kigai.com.tw/menu');
  assert.equal(r.filter((p) => p.kind === 'url').length, 2);
});

test('★ 換行留在文字段落裡（畫面是 pre-wrap，靠它換行）', () => {
  assert.deepEqual(kinds('KIGAI\n\nhttps://maps.app.goo.gl/abc\n六點集合'),
    ['text:KIGAI\n\n', 'url:https://maps.app.goo.gl/abc', 'text:\n六點集合']);
});

test('空字串回空陣列', () => {
  assert.deepEqual(linkify(''), []);
  assert.deepEqual(linkify(null as unknown as string), []);
});

test('★★★ www. 開頭一定要補 https:// —— 直接丟進 href 會被當成相對路徑', () => {
  // 不補的話點下去跑到「安幸上工網址/board/www.kigai.com.tw」，一個 404
  assert.equal(urlHref('www.kigai.com.tw'), 'https://www.kigai.com.tw');
  assert.equal(urlHref('https://x.co/a'), 'https://x.co/a');
  assert.equal(urlHref('HTTP://x.co/a'), 'HTTP://x.co/a');
});

test('★★ 地圖連結顯示成「📍 開啟地圖」', () => {
  /*
   * 第一版比對的是「前面是開頭或一個點」，而真正的網址是
   * https://maps.app.goo.gl/… —— maps 前面是 `//`，所以一條都沒認出來，
   * 而畫面只是照原樣顯示網址、看起來完全正常。
   */
  assert.equal(urlLabel('https://maps.app.goo.gl/pa9u39LqFjUDnHDq7'), '📍 開啟地圖');
  assert.equal(urlLabel('https://goo.gl/maps/xyz'), '📍 開啟地圖');
  assert.equal(urlLabel('https://www.google.com/maps/place/abc'), '📍 開啟地圖');
});

test('★ 不是地圖的照原樣顯示 —— 全部換成「連結」的話兩條會長得一樣', () => {
  assert.equal(urlLabel('https://kigai.com.tw/menu'), 'https://kigai.com.tw/menu');
  assert.equal(urlLabel('www.kigai.com.tw'), 'www.kigai.com.tw');
  assert.equal(urlLabel('https://maps.apple.com/?q=x'), 'https://maps.apple.com/?q=x');
});

test('★ 太長的中間省略，頭尾都留著', () => {
  const long = 'https://kigai.com.tw/menu/2026-autumn-special-course';
  const out = urlLabel(long);
  assert.ok(out.length < long.length);
  assert.ok(out.startsWith('https://kigai'));
  assert.ok(out.includes('…'));
  assert.ok(out.endsWith(long.slice(-9)));
});

/* ── 分享 ─────────────────────────────────────────────────── */

test('分享的文字：種類、時間、名稱、備註', () => {
  assert.equal(eventShareText({
    kind: 'gathering', title: 'KIGAI燒肉專門店',
    starts_at: '2026-09-17T17:00:00+08:00', note: 'https://maps.app.goo.gl/x',
  }), '【團聚】9/17（四） 17:00\nKIGAI燒肉專門店\nhttps://maps.app.goo.gl/x');
});

test('★ 沒有備註就不留空行', () => {
  const t = eventShareText({
    kind: 'meeting', title: 'Q4 房源檢討', starts_at: '2026-09-24T14:00:00+08:00', note: null,
  });
  assert.equal(t, '【開會】9/24（四） 14:00\nQ4 房源檢討');
  assert.ok(!t.includes('\n\n'));
});

test('lineShareUrl：換行要編碼成 %0A（它只是最後一條退路）', () => {
  const u = lineShareUrl('一\n二');
  assert.ok(u.startsWith('https://line.me/R/share?text='));
  assert.ok(u.includes('%0A'), '換行要編碼成 %0A');
});

/*
 * ══════════════════════════════════════════════════════════
 * 【2026-09-17 使用者回報：點分享跑到 www.line.me/en/】
 *
 * `line.me/R/share` 是 LINE 的 URL scheme，而官方文件寫著
 * 「isn't supported in LINE for PC」—— 桌機瀏覽器打開就是官網首頁。
 *
 * 所以分享不能只有一條路。這幾條在驗**每一種裝置都走得到會動的那一條**。
 * ══════════════════════════════════════════════════════════
 */
test('★★★ 手機有系統分享面板就走它 —— 文字原樣帶過去，不經過網址編碼', () => {
  assert.equal(shareVia({ hasNativeShare: true, hasClipboard: true }), 'native');
  assert.equal(shareVia({ hasNativeShare: true, hasClipboard: false }), 'native');
});

test('★★★ 桌機沒有系統分享面板 → 複製，不要開 LINE 網址', () => {
  // 這就是使用者踩到的那一格:桌機 Chrome 沒有 navigator.share
  assert.equal(shareVia({ hasNativeShare: false, hasClipboard: true }), 'copy');
});

test('★ 兩種都沒有才退回 LINE 網址（本來就不保證成功，所以排最後）', () => {
  assert.equal(shareVia({ hasNativeShare: false, hasClipboard: false }), 'line');
  assert.equal(shareVia({}), 'line');
  assert.equal(shareVia(null), 'line');
  assert.equal(shareVia(undefined), 'line');
});

test('shareVia 是純函式：同樣的輸入永遠同樣的輸出', () => {
  const env = { hasNativeShare: false, hasClipboard: true };
  assert.equal(shareVia(env), shareVia(env));
});

/* ── 上傳開關 ─────────────────────────────────────────────── */

test('★★★ 要開會＋開關開著，兩個條件都成立才收得了檔案', () => {
  assert.equal(canUpload({ kind: 'meeting', uploads_open: true }), true);
  assert.equal(canUpload({ kind: 'meeting', uploads_open: false }), false);
  assert.equal(canUpload({ kind: 'gathering', uploads_open: true }), false, '團聚不收');
  assert.equal(canUpload({ kind: 'meeting' }), false, 'undefined 當關著');
  assert.equal(canUpload({ kind: 'meeting', uploads_open: null }), false);
});

/* ── 照人分組 ─────────────────────────────────────────────── */

const F = (id: string, who: string | null, at: string) =>
  ({ id, uploaded_by: who, created_at: at });

test('照人分組，人名照第一次上傳的時間排', () => {
  const g = filesByPerson([
    F('c', 'tang', '2026-09-03T10:00:00Z'),
    F('a', 'qian', '2026-09-01T10:00:00Z'),
    F('b', 'qian', '2026-09-02T10:00:00Z'),
  ]);
  assert.deepEqual(g.map((x) => x.who), ['qian', 'tang']);
  assert.deepEqual(g[0].items.map((x) => x.id), ['a', 'b']);
});

test('★ 沒有 uploaded_by 的也要有自己一組，不能掉進別人底下', () => {
  const g = filesByPerson([F('a', null, '2026-09-01T10:00:00Z'), F('b', 'qian', '2026-09-02T10:00:00Z')]);
  assert.equal(g.length, 2);
});

test('★ 不改動傳進來的陣列', () => {
  const src = [F('b', 'q', '2026-09-02T10:00:00Z'), F('a', 'q', '2026-09-01T10:00:00Z')];
  filesByPerson(src);
  assert.deepEqual(src.map((x) => x.id), ['b', 'a']);
});

/* ══════════════════════════════════════════════════════════
 * 帳密清單（2026-09-17 改版）
 * ══════════════════════════════════════════════════════════ */

import {
  splitSecretTitle, joinSecretTitle, SECRET_CATS, catRank,
  secretIcon, sortSecrets, matchSecret, secretHasWarn, secretHref,
} from './board.ts';

const S = (title: string, extra: Record<string, unknown> = {}) =>
  ({ id: title, title, ...extra } as never);

test('splitSecretTitle：全形｜切成類別與名稱', () => {
  assert.deepEqual(splitSecretTitle('訂房｜Airbnb'), { cat: '訂房', name: 'Airbnb' });
  assert.deepEqual(splitSecretTitle('公司資料｜安幸銀行帳號（8088）'),
    { cat: '公司資料', name: '安幸銀行帳號（8088）' });
});

test('★★ 沒有分隔符號的整串當名稱 —— 不要猜它屬於哪一類', () => {
  assert.deepEqual(splitSecretTitle('台電・網路自繳'), { cat: '', name: '台電・網路自繳' });
  assert.deepEqual(splitSecretTitle(''), { cat: '', name: '' });
  assert.deepEqual(splitSecretTitle(null), { cat: '', name: '' });
});

test('★★ 半形 | 不算分隔符號 —— 密碼與網址裡出現的機率高得多', () => {
  assert.deepEqual(splitSecretTitle('a|b'), { cat: '', name: 'a|b' });
});

test('splitSecretTitle：名稱裡還有｜的話只切第一個', () => {
  assert.deepEqual(splitSecretTitle('其他｜A｜B'), { cat: '其他', name: 'A｜B' });
});

test('joinSecretTitle：組回去，類別空的不留開頭的｜', () => {
  assert.equal(joinSecretTitle('訂房', 'Airbnb'), '訂房｜Airbnb');
  assert.equal(joinSecretTitle('', '台電'), '台電');
  assert.equal(joinSecretTitle(null, '台電'), '台電');
  assert.equal(joinSecretTitle('  訂房  ', '  Airbnb  '), '訂房｜Airbnb');
});

test('★★ split 與 join 對得起來（來回一次不變）', () => {
  for (const t of ['訂房｜Airbnb', '台電・網路自繳', '公司資料｜統一編號', '其他｜A｜B']) {
    const { cat, name } = splitSecretTitle(t);
    assert.equal(joinSecretTitle(cat, name), t, `${t} 來回之後變了`);
  }
});

test('catRank：照使用者選的順序', () => {
  const ranks = SECRET_CATS.map((c) => catRank(c));
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b), 'SECRET_CATS 自己要是遞增的');
  assert.ok(catRank('訂房') < catRank('公司資料'));
});

test('★★ 不認得的類別排在已知後面、未分類前面（打錯字不會跳到第一個）', () => {
  assert.ok(catRank('訂房 ') === catRank('訂房'), '前後空白要 trim');
  assert.ok(catRank('亂打的') > catRank('公司資料'));
  assert.ok(catRank('') > catRank('亂打的'), '未分類要在最後');
  assert.ok(catRank(null) > catRank('亂打的'));
});

test('secretIcon：八類各有一個，不認得的回鑰匙', () => {
  const icons = SECRET_CATS.map((c) => secretIcon(c));
  assert.equal(new Set(icons).size, SECRET_CATS.length, '八個圖示不可以重複');
  assert.equal(secretIcon('亂打的'), '🔑');
  assert.equal(secretIcon(null), '🔑');
});

test('★★★ sortSecrets：照類別，同類照名稱', () => {
  const out = sortSecrets([
    S('公司資料｜統一編號'), S('訂房｜VRBO'), S('台電・網路自繳'),
    S('訂房｜Agoda'), S('社群｜安幸 FB'),
  ]).map((r) => (r as { title: string }).title);
  assert.deepEqual(out, [
    '訂房｜Agoda', '訂房｜VRBO', '社群｜安幸 FB', '公司資料｜統一編號', '台電・網路自繳',
  ]);
});

test('★★ sortSecrets 不改到傳進來的陣列（那是 React 的 state）', () => {
  const src = [S('社群｜B'), S('訂房｜A')];
  const before = src.map((r) => (r as { title: string }).title);
  sortSecrets(src);
  assert.deepEqual(src.map((r) => (r as { title: string }).title), before);
});

test('sortSecrets：空的／null 回空陣列，不炸', () => {
  assert.deepEqual(sortSecrets([]), []);
  assert.deepEqual(sortSecrets(null), []);
  assert.deepEqual(sortSecrets(undefined), []);
});

test('★★ matchSecret：連類別、帳號、網址、備註一起找', () => {
  const r = { id: '1', title: '財稅｜電子發票整合平台', account: '83684417',
              url: 'www.einvoice.nat.gov.tw', note: '統編登入' };
  assert.equal(matchSecret(r, '83684417'), true, '帳號');
  assert.equal(matchSecret(r, '財稅'), true, '類別');
  assert.equal(matchSecret(r, 'einvoice'), true, '網址');
  assert.equal(matchSecret(r, '統編'), true, '備註');
  assert.equal(matchSecret(r, 'EINVOICE'), true, '不分大小寫');
  assert.equal(matchSecret(r, '蝦皮'), false);
});

test('★★★ matchSecret 不比密碼 —— 不讓人用猜的去撞', () => {
  const r = { id: '1', title: '訂房｜Agoda', account: 'a@b.c', secret: 'SuperSecret123' };
  assert.equal(matchSecret(r, 'SuperSecret123'), false);
  assert.equal(matchSecret(r, 'supersecret'), false);
});

test('matchSecret：關鍵字空白就全部通過', () => {
  const r = { id: '1', title: '訂房｜Agoda' };
  assert.equal(matchSecret(r, ''), true);
  assert.equal(matchSecret(r, '   '), true);
  assert.equal(matchSecret(r, null), true);
  assert.equal(matchSecret(null, 'x'), false);
});

test('★★★ secretHasWarn：⚠ 要在清單那一層就看得到', () => {
  assert.equal(secretHasWarn({ id: '1', title: 't', note: '⚠ 要確認：另一處寫的是…' }), true);
  assert.equal(secretHasWarn({ id: '1', title: 't', note: '洪小姐' }), false);
  assert.equal(secretHasWarn({ id: '1', title: 't' }), false);
  assert.equal(secretHasWarn(null), false);
});

test('★★ secretHref：沒有協定的要補 https，不然會被當成相對路徑', () => {
  assert.equal(secretHref('www.airbnb.com.tw'), 'https://www.airbnb.com.tw');
  assert.equal(secretHref('https://mail.zoho.com/'), 'https://mail.zoho.com/');
  assert.equal(secretHref('HTTP://a.b'), 'HTTP://a.b');
  assert.equal(secretHref('  www.a.b  '), 'https://www.a.b');
});

test('secretHref：沒填就回空字串（呼叫端靠它決定畫不畫連結）', () => {
  assert.equal(secretHref(''), '');
  assert.equal(secretHref('   '), '');
  assert.equal(secretHref(null), '');
  assert.equal(secretHref(undefined), '');
});

/* ══════════════════════════════════════════════════════════
 * 表單下載（2026-09-18）
 * ══════════════════════════════════════════════════════════ */

import {
  FORM_EDIT_ROLES, canEditForms, FORM_CATS, parseFormCat, formIcon,
  sortForms, matchForm, formHasFile,
} from './board.ts';

test('★★★ 上傳／換檔案只有總經理・會計・主管（使用者 2026-09-18）', () => {
  assert.equal(canEditForms('super_admin'), true);
  assert.equal(canEditForms('accountant'), true);
  assert.equal(canEditForms('manager'), true);
  assert.equal(canEditForms('housekeeper'), false);
  assert.equal(canEditForms('cleaner'), false);
  assert.equal(FORM_EDIT_ROLES.length, 3);
});

test('★★ 是白名單 —— 沒見過的角色預設不能改', () => {
  assert.equal(canEditForms('intern'), false);
  assert.equal(canEditForms('SUPER_ADMIN'), false);
  assert.equal(canEditForms(null), false);
  assert.equal(canEditForms(undefined), false);
  assert.equal(canEditForms({ role: 'super_admin' }), false);
});

/*
 * ★★★ 表單跟帳密**不是同一份名單**，這一條在防「有人為了少寫一行而共用」。
 *   共用的話改其中一格會連帶改掉另一格，而那件事不會有人發現。
 */
test('★★★ 表單的名單跟帳密的名單不一樣 —— 管家看得到帳密，但不能改表單', () => {
  assert.equal(canSeeSecrets('housekeeper'), true);
  assert.equal(canEditForms('housekeeper'), false);
  assert.notDeepEqual([...FORM_EDIT_ROLES], [...SECRET_ROLES]);
});

test('★★ 房務看不到帳密，但表單他要看得到（下載不受這份名單限制）', () => {
  assert.equal(canSeeSecrets('cleaner'), false);
  // 「能不能改」是 false，但「能不能看」這一頁不設限 —— 由 RLS 的 select policy 放行
  assert.equal(canEditForms('cleaner'), false);
});

test('四個分類，認不得的當「其他」', () => {
  assert.deepEqual([...FORM_CATS], ['人事', '財務', '房務', '其他']);
  assert.equal(parseFormCat('人事'), '人事');
  assert.equal(parseFormCat('亂打的'), '其他');
  assert.equal(parseFormCat(null), '其他');
  assert.equal(parseFormCat(''), '其他');
});

test('formIcon：四類各一個，不重複', () => {
  const icons = FORM_CATS.map((c) => formIcon(c));
  assert.equal(new Set(icons).size, FORM_CATS.length);
  assert.equal(formIcon('亂打的'), '📄');
});

test('★★ sortForms：照分類排，同類照名稱', () => {
  const out = sortForms([
    { title: '備品盤點表', category: '房務' },
    { title: '報帳單', category: '財務' },
    { title: '請假單', category: '人事' },
    { title: '加班申請單', category: '人事' },
    { title: '雜項', category: '亂打的' },
  ]).map((r) => r.title);
  // 人事（加班・請假）→ 財務 → 房務 → 其他（亂打的歸這裡）
  assert.deepEqual(out, ['加班申請單', '請假單', '報帳單', '備品盤點表', '雜項']);
});

test('sortForms 不改到傳進來的陣列', () => {
  const src = [{ title: 'B', category: '財務' }, { title: 'A', category: '人事' }];
  sortForms(src);
  assert.deepEqual(src.map((r) => r.title), ['B', 'A']);
});

test('sortForms：空的／null 回空陣列', () => {
  assert.deepEqual(sortForms([]), []);
  assert.deepEqual(sortForms(null), []);
  assert.deepEqual(sortForms(undefined), []);
});

test('matchForm：名稱、分類、說明、檔名都找得到', () => {
  const r = { id: '1', title: '請假單', category: '人事',
              note: '填完交給芊', file_name: 'leave-form.pdf' };
  assert.equal(matchForm(r, '請假'), true);
  assert.equal(matchForm(r, '人事'), true);
  assert.equal(matchForm(r, '芊'), true);
  assert.equal(matchForm(r, 'LEAVE'), true);
  assert.equal(matchForm(r, '報帳'), false);
  assert.equal(matchForm(r, ''), true);
  assert.equal(matchForm(null, 'x'), false);
});

/*
 * ★★★ 一份「表單下載」而沒有檔案，畫面上是一顆按了沒反應的下載鈕 ——
 *   使用者的結論會是「系統壞了」。
 */
test('★★★ formHasFile：沒有檔案要看得出來', () => {
  assert.equal(formHasFile({ id: '1', title: 'x', file_path: 'forms/a.pdf' }), true);
  assert.equal(formHasFile({ id: '1', title: 'x', file_path: '' }), false);
  assert.equal(formHasFile({ id: '1', title: 'x', file_path: '   ' }), false);
  assert.equal(formHasFile({ id: '1', title: 'x' }), false);
  assert.equal(formHasFile(null), false);
});
