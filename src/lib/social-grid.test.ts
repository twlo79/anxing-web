import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  PIN_MAX, COLS, CELL_W, CELL_H, CAPTION_CUT,
  totalCells, layout, pinnedCells, canPin, renumberPins,
  skewAt, misaligned, pinShift, sourceSize, sliceCrop, sliceBg,
  publishOrder, sliceFileName, captionCut,
  type Item,
} from './social-grid.ts';

const post = (id: string, o: Partial<Item> = {}): Item =>
  ({ id, span: 1, pin: 0, status: 'draft', ...o });
const split = (id: string, span: number, o: Partial<Item> = {}): Item =>
  ({ id, span, pin: 0, status: 'draft', ...o });

/** 把版面畫成使用者手寫的那個樣子，方便一眼對答案 */
const wall = (items: readonly Item[]) => {
  const cells = layout(items);
  const rows: string[] = [];
  for (let i = 0; i < cells.length; i += COLS) {
    rows.push(cells.slice(i, i + COLS).map((c) => String(c.seq)).join(' '));
  }
  return rows;
};

/* ══════════════════════════════════════════════════════════ */
describe('序號：發佈順序，#1 最舊', () => {
  /*
   * 使用者 2026-09-16 手寫的期望值：
   *
   *      9 8 7          10 9 8
   *      6 5 4     →     7 6 5
   *      3 2 1           4 3 2
   *                      1
   */
  test('★★★ 9 則：9 8 7 / 6 5 4 / 3 2 1', () => {
    const a = Array.from({ length: 9 }, (_, i) => post(`p${i}`));
    assert.deepEqual(wall(a), ['9 8 7', '6 5 4', '3 2 1']);
  });

  test('★★★ 10 則：新的那一則進**左上角**，#1 被擠到最後一排的左邊', () => {
    const a = Array.from({ length: 10 }, (_, i) => post(`p${i}`));
    assert.deepEqual(wall(a), ['10 9 8', '7 6 5', '4 3 2', '1']);
  });

  test('陣列是新→舊 —— 第一個元素永遠是序號最大的', () => {
    const a = [post('新'), post('中'), post('舊')];
    const cells = layout(a);
    assert.equal(cells[0].item.id, '新');
    assert.equal(cells[0].seq, 3);
    assert.equal(cells[2].seq, 1);
  });

  test('切圖佔 N 格，序號就吃掉 N 個號碼（左邊那張最大）', () => {
    const a = [post('a'), split('s', 3), post('b')];
    assert.equal(totalCells(a), 5);
    const cells = layout(a);
    assert.deepEqual(cells.map((c) => c.seq), [5, 4, 3, 2, 1]);
    assert.deepEqual(cells.map((c) => c.slice), [0, 0, 1, 2, 0]);
  });
});

/* ══════════════════════════════════════════════════════════ */
describe('釘選', () => {
  test('上限就是 3 —— 改了這裡畫面那句提示也要跟著改', () => {
    assert.equal(PIN_MAX, 3);
  });

  test('★★★ 釘選把它拉到最上面，但**序號不變**', () => {
    const a = [post('c'), post('b'), post('a', { pin: 1 })];
    const cells = layout(a);
    assert.equal(cells[0].item.id, 'a', '釘選的排第一格');
    assert.equal(cells[0].seq, 1, '★ 但它還是 #1（最舊的那一則）');
    assert.deepEqual(cells.map((c) => c.seq), [1, 3, 2]);
  });

  test('多個釘選照 pin 由小到大排', () => {
    const a = [post('x'), post('p2', { pin: 2 }), post('p1', { pin: 1 })];
    assert.deepEqual(layout(a).map((c) => c.item.id), ['p1', 'p2', 'x']);
  });

  test('★★ 額度算的是**格數**不是筆數', () => {
    assert.equal(pinnedCells([post('a', { pin: 1 })]), 1);
    assert.equal(pinnedCells([split('s', 3, { pin: 1 })]), 3, '跨 3 格的切圖吃掉 3 格');
  });

  test('跨 3 格的切圖釘得上去（剛好用完），跨 6 格的釘不了', () => {
    assert.equal(canPin([], split('s', 3)).ok, true);
    const no6 = canPin([], split('s', 6));
    assert.equal(no6.ok, false);
    assert.match(no6.why, /6 格/, '★ 要說出為什麼,不是只有灰掉');
  });

  test('已經釘滿就擋下來，而且說得出還差幾格', () => {
    const a = [post('p1', { pin: 1 }), post('p2', { pin: 2 })];
    assert.equal(canPin(a, post('p3')).ok, true, '2 格 + 1 格 = 3，剛好');
    const a3 = [...a, post('p3', { pin: 3 })];
    const r = canPin(a3, post('p4'));
    assert.equal(r.ok, false);
    assert.match(r.why, /已經釘了 3 格/);
  });

  test('已經釘著的那一筆永遠回 ok —— 不然使用者取消不掉', () => {
    const a = [post('p1', { pin: 1 }), post('p2', { pin: 2 }), post('p3', { pin: 3 })];
    assert.equal(canPin(a, a[0]).ok, true);
  });

  test('取消其中一個之後編號補起來，不留 1、3 這種洞', () => {
    const a = [post('p1', { pin: 1 }), post('p2', { pin: 0 }), post('p3', { pin: 3 })];
    assert.deepEqual(renumberPins(a).map((x) => x.pin), [1, 0, 2]);
  });

  test('★★★ 編號編的是**格的位置**不是第幾筆', () => {
    // 跨 3 格的切圖釘在最前面 → 它自己就吃掉 1、2、3
    const a = [split('s', 3, { pin: 1 }), post('p', { pin: 2 })];
    const r = renumberPins(a);
    assert.equal(r[0].pin, 1);
    assert.equal(r[1].pin, 4, '★ 不是 2 —— 切圖佔掉 1、2、3 了');
  });

  test('切圖排在後面時,它的起點是前面佔完之後的下一格', () => {
    const a = [post('p', { pin: 1 }), split('s', 3, { pin: 2 })];
    assert.deepEqual(renumberPins(a).map((x) => x.pin), [1, 2]);
  });
});

/* ══════════════════════════════════════════════════════════ */
describe('切圖對齊', () => {
  test('切圖要從每排第一格開始', () => {
    assert.equal(skewAt(0), 0);
    assert.equal(skewAt(3), 0);
    assert.equal(skewAt(1), 1);
    assert.equal(skewAt(2), 2);
  });

  test('前面剛好 3 的倍數 → 對齊', () => {
    const a = [post('a'), post('b'), post('c'), split('s', 3)];
    assert.deepEqual(misaligned(layout(a)), []);
  });

  test('★★★ 前面多一則 → 歪一格，而且說得出往下推幾格', () => {
    const a = [post('a'), split('s', 3)];
    const m = misaligned(layout(a));
    assert.equal(m.length, 1);
    assert.equal(m[0].item.id, 's');
    assert.equal(m[0].at, 1);
    assert.equal(m[0].skew, 1);
    assert.equal(m[0].push, 2, '再補 2 格就到下一排的開頭');
  });

  test('貼文不會歪 —— 一格的東西放哪裡都對齊', () => {
    const a = [post('a'), post('b'), post('c'), post('d')];
    assert.deepEqual(misaligned(layout(a)), []);
  });

  test('只回報切圖的**第一張**，不是每一張都報一次', () => {
    const a = [post('a'), split('s', 6)];
    assert.equal(misaligned(layout(a)).length, 1, '六張切片只該叫一次');
  });

  /* ── 釘選與切圖的連動：這一組是整支最重要的 ── */
  test('★★★ 釘 3 格剛好一排，底下的切圖不動', () => {
    const a = [post('p1', { pin: 1 }), post('p2', { pin: 2 }), post('p3', { pin: 3 }),
      split('s', 3)];
    assert.equal(pinShift(a), 0);
    assert.deepEqual(misaligned(layout(a)), [], '★ 3 格 = 一整排,底下整齊');
  });

  test('★★★ 釘 1 格，底下每一張切圖都歪 —— 而動到的是上面那顆 📌', () => {
    const a = [post('p1', { pin: 1 }), split('s1', 3), split('s2', 3)];
    assert.equal(pinShift(a), 1);
    const m = misaligned(layout(a));
    assert.deepEqual(m.map((x) => x.item.id), ['s1', 's2']);
    assert.deepEqual(m.map((x) => x.skew), [1, 1]);
  });

  test('★★ 把那顆釘選取消掉，兩張切圖同時就正了', () => {
    const a = [post('p1', { pin: 0 }), split('s1', 3), split('s2', 3)];
    assert.equal(pinShift(a), 0);
    assert.equal(misaligned(layout(a)).length, 2, '★ p1 那一格還在,所以兩張都還是歪的');

    const b = [split('s1', 3), split('s2', 3)];
    assert.deepEqual(misaligned(layout(b)), [], '把那一格也拿掉才真的整齊');
  });

  test('釘一張跨 3 格的切圖 —— 它自己在第一排,後面照樣對齊', () => {
    const a = [split('big', 3, { pin: 1 }), post('x'), post('y'), post('z'), split('s', 3)];
    assert.deepEqual(layout(a).slice(0, 3).map((c) => c.item.id), ['big', 'big', 'big']);
    assert.deepEqual(misaligned(layout(a)), []);
  });
});

/* ══════════════════════════════════════════════════════════ */
describe('切片座標', () => {
  test('★★★ 一格是 4:5 不是正方形', () => {
    assert.equal(CELL_W, 1080);
    assert.equal(CELL_H, 1350);
    assert.equal(CELL_H / CELL_W, 1.25);
  });

  test('原圖要多大', () => {
    assert.deepEqual(sourceSize(3), { w: 3240, h: 1350 });
    assert.deepEqual(sourceSize(6), { w: 3240, h: 2700 });
    assert.deepEqual(sourceSize(9), { w: 3240, h: 4050 });
    assert.deepEqual(sourceSize(1), { w: 1080, h: 1350 });
  });

  test('跨 3 格：三張橫著切', () => {
    assert.deepEqual([0, 1, 2].map((s) => sliceCrop(3, s).sx), [0, 1080, 2160]);
    assert.deepEqual([0, 1, 2].map((s) => sliceCrop(3, s).sy), [0, 0, 0]);
  });

  test('跨 6 格：第 4 張（索引 3）跳到第二排最左邊', () => {
    const c = sliceCrop(6, 3);
    assert.equal(c.cx, 0);
    assert.equal(c.cy, 1);
    assert.equal(c.sx, 0);
    assert.equal(c.sy, 1350);
  });

  test('★★ CSS 與 canvas 是同一份座標的兩種寫法', () => {
    // 跨 3 格的第 2 張（中間）：canvas 從 1080 開始，CSS 是 50%
    assert.equal(sliceCrop(3, 1).sx, CELL_W);
    assert.deepEqual(sliceBg(3, 1), { size: '300% 100%', position: '50% 0%' });
    // 跨 6 格的最後一張：canvas 右下，CSS 100% 100%
    assert.deepEqual(sliceBg(6, 5), { size: '300% 200%', position: '100% 100%' });
    // 單格不做除以零
    assert.deepEqual(sliceBg(1, 0), { size: '100% 100%', position: '0% 0%' });
  });
});

/* ══════════════════════════════════════════════════════════ */
describe('發佈順序：是反的', () => {
  test('★★★ 跨 3 格：先貼最右邊那張（序號最小的）', () => {
    // 左中右的序號是 12、11、10
    assert.deepEqual(publishOrder(3, 12), [
      { slice: 2, seq: 10 },
      { slice: 1, seq: 11 },
      { slice: 0, seq: 12 },
    ]);
  });

  test('序號一路遞增 —— 那就是「先貼小的」', () => {
    const o = publishOrder(6, 20);
    assert.deepEqual(o.map((x) => x.seq), [15, 16, 17, 18, 19, 20]);
    assert.equal(o[0].slice, 5, '第一個貼的是右下角那張');
    assert.equal(o[5].slice, 0, '最後貼的是左上角那張');
  });

  test('★★ 檔名一定帶順序 —— 不帶的話人到手機上還是會貼反', () => {
    assert.equal(sliceFileName('estia', 1, 3), 'estia_01_先貼.png');
    assert.equal(sliceFileName('estia', 2, 3), 'estia_02.png');
    assert.equal(sliceFileName('estia', 3, 3), 'estia_03_最後.png');
  });

  test('檔名把不能用的字元換掉,不要生出一個存不了的檔名', () => {
    // ★ 中文要留著 —— 用白名單的話「安幸上工」會整個被吃掉
    assert.equal(sliceFileName('ESTIA 台北/館', 1, 3), 'ESTIA_台北_館_01_先貼.png');
    assert.equal(sliceFileName('安幸上工', 2, 3), '安幸上工_02.png');
    assert.equal(sliceFileName('', 1, 2), 'ig_01_先貼.png');
    assert.equal(sliceFileName('///', 2, 2), 'ig_02_最後.png');
  });
});

/* ══════════════════════════════════════════════════════════ */
describe('文案截斷', () => {
  test('沒超過就整段展開', () => {
    const r = captionCut('短短一句');
    assert.equal(r.over, 0);
    assert.equal(r.hidden, '');
    assert.equal(r.visible, '短短一句');
  });

  test('★★ 回的是「看得到的那一段」與「被藏起來的那一段」,不是一個字數', () => {
    const cap = 'あ'.repeat(200);
    const r = captionCut(cap);
    assert.equal(r.len, 200);
    assert.equal(r.over, 75);
    assert.equal(r.visible.length, CAPTION_CUT);
    assert.equal(r.hidden.length, 75);
    assert.equal(r.visible + r.hidden, cap, '兩段接回去要等於原文');
  });

  test('空的與 null 不要炸', () => {
    assert.equal(captionCut('').len, 0);
    assert.equal(captionCut(undefined as any).len, 0);
  });
});
