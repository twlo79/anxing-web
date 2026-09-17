import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PLATFORMS, PLATFORM_LABEL, isPlatform, parsePlatform, platformLabel,
  FB_COLS, FB_VISIBLE_MAX, FB_PIN_MAX,
  fbCollage, fbVisibleCount, fbPhotoWarn,
  fbPinnedCount, fbCanPin, fbPinProblem, fbOrder,
  FB_CAPTION_LINES, FB_LINE_CHARS, fbWrap, fbCaptionCut,
  fbProfileStat,
} from './social-fb.ts';

/* ── 平台 ─────────────────────────────────────────────────── */

test('平台只有兩種', () => {
  assert.deepEqual([...PLATFORMS], ['ig', 'fb']);
  assert.equal(PLATFORM_LABEL.ig, 'Instagram');
  assert.equal(PLATFORM_LABEL.fb, 'Facebook');
});

test('isPlatform 只認得 ig / fb', () => {
  assert.equal(isPlatform('ig'), true);
  assert.equal(isPlatform('fb'), true);
  assert.equal(isPlatform('IG'), false);
  assert.equal(isPlatform(''), false);
  assert.equal(isPlatform(null), false);
  assert.equal(isPlatform(undefined), false);
  assert.equal(isPlatform(0), false);
});

test('★★★ 認不得的一律當 ig —— 回 null 的話現有帳號會在兩個平台底下都消失', () => {
  assert.equal(parsePlatform(null), 'ig');
  assert.equal(parsePlatform(undefined), 'ig');
  assert.equal(parsePlatform(''), 'ig');
  assert.equal(parsePlatform('threads'), 'ig');
  assert.equal(parsePlatform(0), 'ig');
  // 認得的照原樣
  assert.equal(parsePlatform('fb'), 'fb');
  assert.equal(parsePlatform('ig'), 'ig');
});

test('platformLabel 吃得下髒值', () => {
  assert.equal(platformLabel('fb'), 'Facebook');
  assert.equal(platformLabel(null), 'Instagram');
});

/* ── 拼貼 ─────────────────────────────────────────────────── */

const cols = (c: ReturnType<typeof fbCollage>) =>
  c.tiles.map((t) => [t.i, t.c, t.cw, t.r, t.rh, t.more]);

test('0 張：什麼都沒有', () => {
  const c = fbCollage(0);
  assert.deepEqual(c.tiles, []);
  assert.equal(c.hidden, 0);
  assert.deepEqual(c.rows, []);
});

test('1 張：整張，一列', () => {
  const c = fbCollage(1);
  assert.deepEqual(cols(c), [[0, 0, 6, 0, 1, 0]]);
  assert.deepEqual(c.rows, [1]);
});

test('2 張：左右各半', () => {
  const c = fbCollage(2);
  assert.deepEqual(cols(c), [[0, 0, 3, 0, 1, 0], [1, 3, 3, 0, 1, 0]]);
  assert.deepEqual(c.rows, [1]);
});

test('3 張：左邊一大跨兩列、右邊兩小', () => {
  const c = fbCollage(3);
  assert.deepEqual(cols(c), [
    [0, 0, 3, 0, 2, 0],
    [1, 3, 3, 0, 1, 0],
    [2, 3, 3, 1, 1, 0],
  ]);
  assert.deepEqual(c.rows, [1, 1]);
});

test('4 張：2×2', () => {
  const c = fbCollage(4);
  assert.deepEqual(cols(c), [
    [0, 0, 3, 0, 1, 0], [1, 3, 3, 0, 1, 0],
    [2, 0, 3, 1, 1, 0], [3, 3, 3, 1, 1, 0],
  ]);
});

test('5 張：上排 2 大、下排 3 小，剛好放完所以沒有 +N', () => {
  const c = fbCollage(5);
  assert.equal(c.tiles.length, 5);
  assert.equal(c.hidden, 0);
  assert.equal(c.tiles[4].more, 0);
  assert.deepEqual(c.rows, [1.5, 1]);
});

test('★★★ 11 張（使用者的截圖）：只有 5 張看得到，最後一格蓋 +6', () => {
  const c = fbCollage(11);
  assert.equal(c.tiles.length, FB_VISIBLE_MAX);
  assert.equal(c.hidden, 6);
  assert.equal(c.tiles[4].more, 6);
  // 前四格不該蓋東西
  assert.deepEqual(c.tiles.slice(0, 4).map((t) => t.more), [0, 0, 0, 0]);
});

test('每一種張數都填滿 6 欄、不重疊', () => {
  for (let n = 1; n <= 12; n++) {
    const c = fbCollage(n);
    // 每一列的欄寬加起來剛好是 FB_COLS
    const byRow = new Map<number, number>();
    for (const t of c.tiles) {
      for (let r = t.r; r < t.r + t.rh; r++) {
        byRow.set(r, (byRow.get(r) ?? 0) + t.cw);
      }
    }
    for (const [r, w] of byRow) {
      assert.equal(w, FB_COLS, `${n} 張的第 ${r} 列寬度是 ${w}，不是 ${FB_COLS}`);
    }
    // 有幾列就要有幾個 rows 比例
    assert.equal(c.rows.length, byRow.size, `${n} 張的 rows 長度對不上`);
  }
});

test('負數與小數收成 0 —— 輸入經過 length / Number / 資料庫好幾手', () => {
  assert.equal(fbCollage(-3).tiles.length, 0);
  assert.equal(fbCollage(2.7).tiles.length, 2);
  assert.equal(fbCollage(NaN).tiles.length, 0);
  assert.equal(fbCollage(Infinity).tiles.length, 0);
});

test('fbVisibleCount 封頂在 5', () => {
  assert.equal(fbVisibleCount(0), 0);
  assert.equal(fbVisibleCount(3), 3);
  assert.equal(fbVisibleCount(5), 5);
  assert.equal(fbVisibleCount(11), 5);
  assert.equal(fbVisibleCount(NaN), 0);
});

/* ── 圖太多的警告 ────────────────────────────────────────── */

test('5 張以內不叫', () => {
  for (const n of [0, 1, 4, 5]) assert.equal(fbPhotoWarn(n).over, 0, `${n} 張不該叫`);
});

test('★ 6 張開始叫，而且要講出被蓋掉幾張', () => {
  const w = fbPhotoWarn(11);
  assert.equal(w.over, 6);
  assert.match(w.why, /11 張/);
  assert.match(w.why, /\+6/);
  assert.match(w.why, /拆成兩則/);
});

/*
 * ★★★ 這裡本來有一條「超過 FB 的 10 張上限」的測試，而那個上限是我編的。
 *   使用者的截圖就是一則 11 張 —— 測試當場抓到 `fbPhotoWarn(11)`
 *   回了「最多 10 張」而不是「+6」。憑印象寫的常數會被當成規格。
 *   現在張數沒有上限，只有「看得到幾張」。
 */
test('★★ 張數再多，講的都還是「只有前 5 張看得到」', () => {
  const w = fbPhotoWarn(30);
  assert.equal(w.over, 25);
  assert.match(w.why, /\+25/);
  assert.doesNotMatch(w.why, /上限/);
});

/* ── 置頂 ─────────────────────────────────────────────────── */

const P = (id: string, pin = 0) => ({ id, pin });

test('★★★ FB 只能置頂一則（IG 是 3 格）', () => {
  assert.equal(FB_PIN_MAX, 1);
});

test('沒有置頂時，任何一則都放得上去', () => {
  const list = [P('a'), P('b')];
  assert.equal(fbCanPin(list, P('a')).ok, true);
});

test('已經有一則置頂 → 第二則擋下來，而且要講理由', () => {
  const list = [P('a', 1), P('b')];
  const r = fbCanPin(list, P('b'));
  assert.equal(r.ok, false);
  assert.match(r.why, /只能置頂 1 則/);
  assert.match(r.why, /先把原本那則取消/);
});

test('★ 已經置頂的那一則自己再問一次要回 ok —— 不然取消不了', () => {
  const list = [P('a', 1)];
  assert.equal(fbCanPin(list, P('a', 1)).ok, true);
});

test('★★ 換一則置頂時不該把自己算進去', () => {
  // a 已置頂,清單裡也只有 a —— 問 a 能不能置頂,答案是可以
  const list = [P('a', 1), P('b', 0)];
  assert.equal(fbPinnedCount(list), 1);
});

test('fbPinProblem：一則以內不叫', () => {
  assert.equal(fbPinProblem([P('a', 1), P('b')]).bad, false);
  assert.equal(fbPinProblem([P('a'), P('b')]).bad, false);
});

test('★★ 置頂 3 則（從 IG 帶過來的）要叫 —— 在 FB 上那是無效的', () => {
  const r = fbPinProblem([P('a', 1), P('b', 2), P('c', 3)]);
  assert.equal(r.bad, true);
  assert.equal(r.n, 3);
  assert.match(r.why, /不會置頂/);
});

/* ── 排序 ─────────────────────────────────────────────────── */

test('置頂的排最上面，其餘照陣列順序', () => {
  const got = fbOrder([P('a'), P('b', 2), P('c'), P('d', 1)]).map((x) => x.id);
  assert.deepEqual(got, ['d', 'b', 'a', 'c']);
});

test('沒有置頂時原樣不動', () => {
  const got = fbOrder([P('a'), P('b'), P('c')]).map((x) => x.id);
  assert.deepEqual(got, ['a', 'b', 'c']);
});

test('★ 不改動傳進來的陣列', () => {
  const src = [P('a'), P('b', 1)];
  fbOrder(src);
  assert.deepEqual(src.map((x) => x.id), ['a', 'b']);
});

/* ── 文案 ─────────────────────────────────────────────────── */

test('空文案回空陣列，不是一行空的', () => {
  assert.deepEqual(fbWrap(''), []);
  assert.deepEqual(fbWrap(null as unknown as string), []);
});

test('硬換行各自算一行', () => {
  assert.deepEqual(fbWrap('一\n二\n三', 22), ['一', '二', '三']);
});

test('★ 空行留著 —— 它在 FB 上真的佔一行', () => {
  assert.deepEqual(fbWrap('一\n\n二', 22), ['一', '', '二']);
});

test('全形字照 perLine 折', () => {
  const s = '一二三四五';
  assert.deepEqual(fbWrap(s, 2), ['一二', '三四', '五']);
});

test('★★ 半形算半個字寬 —— 不然一整行英文會被當成兩行', () => {
  // perLine = 2 ＝ 4 個半形字
  assert.deepEqual(fbWrap('abcdef', 2), ['abcd', 'ef']);
});

test('★★★ 超過 3 行就被收起來（FB 是照行數，不是字數）', () => {
  const cap = '一\n二\n三\n四\n五';
  const c = fbCaptionCut(cap);
  assert.equal(FB_CAPTION_LINES, 3);
  assert.deepEqual(c.lines, ['一', '二', '三']);
  assert.equal(c.hidden, '四\n五');
  assert.equal(c.total, 5);
  assert.equal(c.over, 2);
});

test('三行以內不收', () => {
  const c = fbCaptionCut('一\n二');
  assert.equal(c.over, 0);
  assert.equal(c.hidden, '');
  assert.equal(c.visible, '一\n二');
});

test('★ 一行很長的文案也會被折成好幾行然後收起來', () => {
  const cap = '安'.repeat(FB_LINE_CHARS * 5);
  const c = fbCaptionCut(cap);
  assert.equal(c.total, 5);
  assert.equal(c.over, 2);
  assert.equal(c.lines.length, 3);
});

test('★ 沒有文案時不叫', () => {
  const c = fbCaptionCut('');
  assert.deepEqual(c.lines, []);
  assert.equal(c.over, 0);
});

/* ── 檔案頭 ───────────────────────────────────────────────── */

test('★ FB 的順序是 followers → following → posts（IG 是反的）', () => {
  assert.equal(fbProfileStat('437', '11', 214), '437 followers · 11 following · 214 posts');
});

test('★★ 空的畫成「—」不是 0 —— 這一頁沒連 FB，那些數字是裝飾', () => {
  assert.equal(fbProfileStat('', null, 0), '— followers · — following · 0 posts');
  assert.equal(fbProfileStat('  ', undefined, 8), '— followers · — following · 8 posts');
});

test('★ 使用者寫「12.3萬」也照原樣顯示（欄位是 text 不是數字）', () => {
  assert.match(fbProfileStat('12.3萬', '99', 3), /12\.3萬 followers/);
});
