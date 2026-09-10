import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  isTakeable, takeableItems, toRequestItems, demandNote,
  unpricedNames, submitBlockedBy, requestTotal, totalText,
  linkBackPlan, canMarkDone, markDoneConfirm,
  type DemandItemSrc, type DemandItemStatus,
} from './demand-to-request.ts';

const D = (o: Partial<DemandItemSrc> = {}): DemandItemSrc => ({
  id: 'd1', item_name: '衛生紙*1箱', spec: '大包裝', qty: '2 箱',
  purpose_type: 'estate', estate_id: 'e1', status: 'pending', ...o,
});

describe('isTakeable —— 哪些還可以被領走（2026-09-05）', () => {
  /*
   * ★★ 已經被領走的再帶一次 = 兩張請款單同時請同一筆錢，
   *   而總額只是「比較大」，沒有任何地方會叫。
   */
  test('★★ requested / done 不能再帶', () => {
    assert.equal(isTakeable('requested'), false);
    assert.equal(isTakeable('done'), false);
  });

  test('★ 已取消的不該再冒出來', () => {
    assert.equal(isTakeable('cancelled'), false);
  });

  test('未採購與已詢價可以帶', () => {
    assert.equal(isTakeable('pending'), true);
    assert.equal(isTakeable('quoted'), true);
  });

  test('takeableItems 會濾掉不能帶的', () => {
    const xs = [D({ id: 'a' }), D({ id: 'b', status: 'requested' }), D({ id: 'c', status: 'cancelled' })];
    assert.deepEqual(takeableItems(xs).map((x) => x.id), ['a']);
  });
});

describe('toRequestItems —— 欄位怎麼對過去（2026-09-05）', () => {
  /*
   * ★★★ 金額是 **null 不是 0**。
   *   0 在請款單上是合法的值（贈品、換貨），畫面上跟「還沒填」一模一樣 ——
   *   拿 0 當待填的話送審擋不住，兩層核可都不會發現。
   */
  test('★★★ 金額是 null，不是 0', () => {
    const r = toRequestItems([D()])[0];
    assert.equal(r.amount, null);
    assert.notEqual(r.amount, 0);
  });

  // ★ 規格併進品名的話「衛生紙*1箱 大包裝」會被當成一個品項名稱，
  //   而品名是要印在單子上給人核的
  test('★ 規格進備註，不併進品名', () => {
    const r = toRequestItems([D()])[0];
    assert.equal(r.item_name, '衛生紙*1箱');
    assert.equal(r.note, '大包裝 × 2 箱');
  });

  test('★★★ 數量一定要帶進請款單（2026-09-10）', () => {
    /*
     * 這是整張需求單上會計最需要的一個數字。
     * 掉了的話他拿到的是「除霉劑・大瓶」，要買幾瓶得回頭問 ——
     * 而備註那一格**是有字的**，看起來完全正常。
     *
     * ★ 這一條釘的是「加了新欄位卻沒更新讀取端」那個坑
     *   （buy_link 就是這樣少了半年）。
     */
    assert.match(toRequestItems([D({ spec: '大瓶', qty: '3 瓶' })])[0].note!, /3 瓶/);
  });

  /*
   * ★★ 安幸辦公室不是物業，資料庫有互斥約束擋著 ——
   *   帶著上一次選的物業過去會被擋，而錯誤訊息看不懂。
   */
  test('★★ office 的 estate_id 一律 null', () => {
    const r = toRequestItems([D({ purpose_type: 'office', estate_id: 'e1' })])[0];
    assert.equal(r.purpose_type, 'office');
    assert.equal(r.estate_id, null);
  });

  test('estate 的物業帶過去', () => {
    assert.equal(toRequestItems([D()])[0].estate_id, 'e1');
  });

  test('記得回頭要接哪一個需求項目', () => {
    assert.equal(toRequestItems([D({ id: 'zz' })])[0].fromDemandItemId, 'zz');
  });

  // ★ 接在既有項目後面，不要從 0 開始蓋掉別人的排序
  test('★ sort 從 startSort 接下去', () => {
    const rs = toRequestItems([D({ id: 'a' }), D({ id: 'b' })], 3);
    assert.deepEqual(rs.map((r) => r.sort), [3, 4]);
  });

  test('不能帶的那些不會出現在結果裡', () => {
    assert.equal(toRequestItems([D({ status: 'requested' })]).length, 0);
  });

  test('空清單不會爆', () => {
    assert.deepEqual(toRequestItems([]), []);
  });

  test('品名前後空白會清掉', () => {
    assert.equal(toRequestItems([D({ item_name: '  抹布  ' })])[0].item_name, '抹布');
  });

  test('規格與數量都沒填時，備註是 null 不是空字串', () => {
    assert.equal(toRequestItems([D({ spec: '  ', qty: '' })])[0].note, null);
  });
});

describe('★★ demandNote —— 規格 ＋ 數量怎麼併', () => {
  test('兩個都有 → 用「×」接起來（跟需求列表長得一樣）', () =>
    assert.equal(demandNote('大瓶', '3 瓶'), '大瓶 × 3 瓶'));

  test('★ 只有一邊有值時不要留下孤零零的「×」', () => {
    assert.equal(demandNote('大瓶', ''), '大瓶');
    assert.equal(demandNote('', '3 瓶'), '3 瓶');
    assert.equal(demandNote(null, '3 瓶'), '3 瓶');
  });

  test('兩邊都空 → null，不是空字串', () => {
    assert.equal(demandNote('', ''), null);
    assert.equal(demandNote(null, undefined), null);
    assert.equal(demandNote('  ', '　'), null);
  });

  test('前後空白清掉', () =>
    assert.equal(demandNote('  大瓶 ', ' 3 瓶  '), '大瓶 × 3 瓶'));
});

describe('送審擋阻（2026-09-05）', () => {
  const I = (name: string, amt: number | null) => ({ item_name: name, amount: amt });

  /*
   * ★★★ 草稿的用途就是「先開起來、金額之後補」——
   *   存檔就擋的話這整條路走不通。送審才擋。
   */
  test('★★★ 全部填好就放行', () => {
    assert.equal(submitBlockedBy([I('A', 100), I('B', 0)]), null);
  });

  test('★★★ 真的填 0 算填好了 —— 那跟還沒填不一樣', () => {
    assert.deepEqual(unpricedNames([I('贈品', 0)]), []);
  });

  // ★ 回名字不是筆數 ——「有 2 項沒填」要人自己在十幾列裡找
  test('★ 回的是品名', () => {
    assert.deepEqual(unpricedNames([I('衛生紙', null), I('抹布', 50), I('除霉劑', null)]),
      ['衛生紙', '除霉劑']);
  });

  test('擋阻訊息含品名與筆數', () => {
    const m = submitBlockedBy([I('衛生紙', null), I('除霉劑', null)]);
    assert.match(m!, /2 項/);
    assert.match(m!, /衛生紙/);
    assert.match(m!, /除霉劑/);
  });

  // ★★ 訊息要說明「0 跟沒填不一樣」—— 不講的話使用者會全部填 0 送出去
  test('★★ 訊息要講「真的是 0 元請填 0」', () => {
    assert.match(submitBlockedBy([I('A', null)])!, /填 0/);
  });

  test('超過五項只列前五個，但筆數是全部', () => {
    const many = Array.from({ length: 8 }, (_, i) => I(`item${i}`, null));
    const m = submitBlockedBy(many)!;
    assert.match(m, /8 項/);
    assert.match(m, /等 8 項/);
  });

  test('沒填品名的顯示成「（沒填品名）」，不是空白', () => {
    assert.deepEqual(unpricedNames([I('  ', null)]), ['（沒填品名）']);
  });
});

describe('requestTotal / totalText —— 待填的不算但要講（2026-09-05）', () => {
  /*
   * ★★ 把 null 當 0 加總的話，合計看起來是一個完整的數字 ——
   *   而它少了還沒填的那幾筆，沒有人會發現。
   */
  test('★★ 待填的不算進合計，但回報幾筆', () => {
    const r = requestTotal([{ amount: 100 }, { amount: null }, { amount: 250 }]);
    assert.equal(r.total, 350);
    assert.equal(r.unpriced, 1);
  });

  test('★★ 有待填時合計要講出來', () => {
    assert.equal(totalText([{ amount: 100 }, { amount: null }]), '$100（另有 1 項待填）');
  });

  test('全部填好就只印金額', () => {
    assert.equal(totalText([{ amount: 1200 }, { amount: 0 }]), '$1,200');
  });

  test('空清單是 $0', () => {
    assert.equal(totalText([]), '$0');
  });
});

describe('linkBackPlan —— 存完之後回寫哪幾筆（2026-09-05）', () => {
  const drafts = toRequestItems([D({ id: 'd1' }), D({ id: 'd2' })]);

  test('照順序配對', () => {
    assert.deepEqual(linkBackPlan(drafts, ['r1', 'r2']), [
      { demandItemId: 'd1', requestItemId: 'r1' },
      { demandItemId: 'd2', requestItemId: 'r2' },
    ]);
  });

  /*
   * ★★ 資料庫只回了一部分 id 時，**只配對得到的那幾筆** ——
   *   硬配的話會把 d2 接到不存在的請款項目上，
   *   而那一項在需求單上會顯示「已進請款」卻點不到單號。
   */
  test('★★ id 少回幾個時只配得到的那些', () => {
    assert.equal(linkBackPlan(drafts, ['r1']).length, 1);
  });

  test('空的不會爆', () => {
    assert.deepEqual(linkBackPlan([], []), []);
    assert.deepEqual(linkBackPlan(drafts, []), []);
  });
});

describe('canMarkDone —— 零用金直接買的那條路（2026-09-05）', () => {
  /*
   * ★★ 已經進請款的不給手動標完成 —— 那條路的完成要跟著請款單走。
   *   手動標的話請款單付款時會對不起來，而兩邊都顯示「已完成」，
   *   看不出是哪一條路走完的。
   */
  test('★★ 已進請款的不給按', () => {
    assert.equal(canMarkDone({ status: 'requested' as DemandItemStatus }), false);
    assert.equal(canMarkDone({ status: 'done' as DemandItemStatus }), false);
  });

  test('未採購與已詢價可以按', () => {
    assert.equal(canMarkDone({ status: 'pending' as DemandItemStatus }), true);
    assert.equal(canMarkDone({ status: 'quoted' as DemandItemStatus }), true);
  });

  test('已取消的不給按', () => {
    assert.equal(canMarkDone({ status: 'cancelled' as DemandItemStatus }), false);
  });

  // ★ 確認訊息要講清楚這條路不會產生請款單
  test('★ 確認訊息要講「不會產生請款單」', () => {
    const m = markDoneConfirm(['衛生紙', '抹布']);
    assert.match(m, /不會.*請款單/);
    assert.match(m, /衛生紙/);
    assert.match(m, /2 項/);
  });

  test('超過八項只列前八個', () => {
    const m = markDoneConfirm(Array.from({ length: 10 }, (_, i) => `x${i}`));
    assert.match(m, /等 10 項/);
  });
});
