import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  jobKeyByCode, crewOf, sharePreview, fmtShare, previewText, type CrewRow,
} from './hk-crew.ts';

const r = (date: string, code: string | null, type: string, staff: string | null): CrewRow =>
  ({ work_date: date, property_code: code, work_type: type, staff_id: staff });

const D = '2026-08-01';
const NAME: Record<string, string> = { a: 'Ayu', b: '劉姐', c: '庭玉' };
const nameOf = (id: string) => NAME[id] ?? id;

describe('jobKeyByCode', () => {
  test('同一天同一間同一種工作 = 同一份工', () => {
    assert.equal(jobKeyByCode(r(D, '18B2', '清潔', 'a')), jobKeyByCode(r(D, '18B2', '清潔', 'b')));
  });

  test('★ 工作類型不同就是兩份工', () => {
    // 退房與入住是兩次不同的工作,不該互相分攤
    assert.notEqual(
      jobKeyByCode(r(D, '18B2', '退房清潔', 'a')),
      jobKeyByCode(r(D, '18B2', '入住準備', 'a')));
  });

  test('日期不同、房源不同都是兩份工', () => {
    assert.notEqual(jobKeyByCode(r(D, '18B2', '清潔', 'a')), jobKeyByCode(r('2026-08-02', '18B2', '清潔', 'a')));
    assert.notEqual(jobKeyByCode(r(D, '18B2', '清潔', 'a')), jobKeyByCode(r(D, '18B5', '清潔', 'a')));
  });

  test('null 與空字串的房源算同一種（都是「沒有房源」）', () => {
    assert.equal(jobKeyByCode(r(D, null, '其他工時', 'a')), jobKeyByCode(r(D, '', '其他工時', 'a')));
  });
});

describe('crewOf', () => {
  const rows = [r(D, '18B2', '清潔', 'a'), r(D, '18B2', '清潔', 'b'), r(D, '18B5', '清潔', 'a')];

  test('只算同一份工的人', () => {
    assert.deepEqual([...crewOf(rows, D, '18B2', '清潔')].sort(), ['a', 'b']);
    assert.deepEqual([...crewOf(rows, D, '18B5', '清潔')], ['a']);
  });

  test('沒有人的那份工回空集合', () => {
    assert.equal(crewOf(rows, D, '19B2', '清潔').size, 0);
  });

  test('★ 同一個人有兩筆只算一個人', () => {
    // 不去重的話他自己跟自己合掃,兩筆各 0.5,總量憑空少一半
    const dup = [r(D, '18B2', '清潔', 'a'), r(D, '18B2', '清潔', 'a')];
    assert.equal(crewOf(dup, D, '18B2', '清潔').size, 1);
  });

  test('沒有 staff_id 的列跳過', () => {
    assert.equal(crewOf([r(D, '18B2', '清潔', null)], D, '18B2', '清潔').size, 0);
  });
});

describe('★★★ sharePreview', () => {
  test('全新的一份工，一個人 → 1 間', () => {
    const p = sharePreview([], D, '18B2', '清潔', ['a']);
    assert.deepEqual(p, [{ staffId: 'a', before: 0, after: 1, isNew: true }]);
  });

  test('★ 一次勾兩個人 → 各 0.5，不是各 1', () => {
    const p = sharePreview([], D, '18B2', '清潔', ['a', 'b']);
    assert.deepEqual(p.map((x) => x.after), [0.5, 0.5]);
  });

  test('三個人 → 各 1/3', () => {
    const p = sharePreview([], D, '18B2', '清潔', ['a', 'b', 'c']);
    for (const x of p) assert.ok(Math.abs(x.after - 1 / 3) < 1e-9);
  });

  test('★★★ 補一個人進既有的工，原本那個人會掉到 0.5', () => {
    /*
     * 這是整支檔案最重要的一條。
     * 分母是「這份工的全部人」,不只是新勾的那幾個 ——
     * 所以補資料會讓原本那個人的數字**變少**。
     * 那是對的,但存檔前一定要講,不然畫面上只看得到「怎麼反而少了」。
     */
    const rows = [r(D, '18B2', '清潔', 'a')];
    const p = sharePreview(rows, D, '18B2', '清潔', ['b']);
    const ayu = p.find((x) => x.staffId === 'a')!;
    const liu = p.find((x) => x.staffId === 'b')!;
    assert.deepEqual([ayu.before, ayu.after, ayu.isNew], [1, 0.5, false]);
    assert.deepEqual([liu.before, liu.after, liu.isNew], [0, 0.5, true]);
  });

  test('★★ 回傳要包含原本就在的人', () => {
    // 只列新加的話,「Ayu 為什麼變少」還是沒有答案
    const rows = [r(D, '18B2', '清潔', 'a')];
    assert.equal(sharePreview(rows, D, '18B2', '清潔', ['b']).length, 2);
  });

  test('★ 勾一個已經在裡面的人，數字不變', () => {
    const rows = [r(D, '18B2', '清潔', 'a'), r(D, '18B2', '清潔', 'b')];
    const p = sharePreview(rows, D, '18B2', '清潔', ['a']);
    assert.equal(p.length, 2);
    for (const x of p) assert.equal(x.after, 0.5);
  });

  test('別份工的人不會被算進來', () => {
    const rows = [r(D, '18B5', '清潔', 'c'), r('2026-08-02', '18B2', '清潔', 'c')];
    const p = sharePreview(rows, D, '18B2', '清潔', ['a']);
    assert.deepEqual(p.map((x) => x.staffId), ['a']);
    assert.equal(p[0].after, 1);
  });

  test('一個人都沒勾、也沒有既有的 → 空陣列', () => {
    assert.deepEqual(sharePreview([], D, '18B2', '清潔', []), []);
  });

  test('★ 空字串的 staffId 要被濾掉，不能算成一個人', () => {
    const p = sharePreview([], D, '18B2', '清潔', ['a', '']);
    assert.equal(p.length, 1);
    assert.equal(p[0].after, 1);
  });

  test('沒有房源的工作（公區）也算得出來', () => {
    const p = sharePreview([], D, '', '其他工時', ['a', 'b']);
    assert.deepEqual(p.map((x) => x.after), [0.5, 0.5]);
  });
});

describe('fmtShare', () => {
  test('整數不加小數點', () => assert.equal(fmtShare(1), '1'));
  test('0.5 照寫', () => assert.equal(fmtShare(0.5), '0.5'));
  test('★ 1/3 不要印出一長串', () => assert.equal(fmtShare(1 / 3), '0.33'));
  test('NaN 當 0，不要印 NaN 給人看', () => assert.equal(fmtShare(NaN), '0'));
});

describe('previewText', () => {
  test('兩個人合掃的那一句', () => {
    const p = sharePreview([], D, '18B2', '清潔', ['a', 'b']);
    const t = previewText(p, nameOf)!;
    assert.match(t.line, /2 個人合掃/);
    assert.match(t.line, /Ayu 0\.5 間/);
    assert.match(t.line, /劉姐 0\.5 間/);
    assert.equal(t.warn, null, '沒有人變少就不該有警告');
  });

  test('★★★ 有人會變少時要單獨講一句', () => {
    const rows = [r(D, '18B2', '清潔', 'a')];
    const t = previewText(sharePreview(rows, D, '18B2', '清潔', ['b']), nameOf)!;
    assert.ok(t.warn, '一定要有警告');
    assert.match(t.warn!, /Ayu 會從 1 間變成 0\.5 間/);
  });

  test('一個人的時候不警告', () => {
    const t = previewText(sharePreview([], D, '18B2', '清潔', ['a']), nameOf)!;
    assert.equal(t.warn, null);
  });

  test('空的回 null（不要顯示一塊空的綠色區域）', () => {
    assert.equal(previewText([], nameOf), null);
  });

  test('★ 找不到名字時用 id 頂著，不要顯示 undefined', () => {
    const t = previewText(sharePreview([], D, '18B2', '清潔', ['zzz']), nameOf)!;
    assert.match(t.line, /zzz/);
  });
});
