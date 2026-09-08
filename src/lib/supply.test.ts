import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  KIND_LABEL, KIND_BUTTON, txnRow, txnError, previewAfter, negativeWarn,
  isLow, LOW_STOCK, expiringSoon,
  countDiff, countsWithDiff, countPlan, countConfirm,
  type CountDraft,
} from './supply.ts';

const D = (o: Partial<CountDraft> = {}): CountDraft =>
  ({ item_id: 'i1', system_qty: 10, counted: '', ...o });

describe('用語（2026-09-07 使用者選 B）', () => {
  /*
   * ★★ 按的人是管家跟房務，不是倉管 —— 他們腦中沒有「庫」這個東西。
   *   而且符號要在按鈕上，不然看不出是加還是減。
   */
  test('★★ 取用是減、補貨是加，符號在按鈕上', () => {
    assert.equal(KIND_LABEL.out, '取用');
    assert.equal(KIND_LABEL.in, '補貨');
    assert.match(KIND_BUTTON.out, /−/);
    assert.match(KIND_BUTTON.in, /＋/);
  });

  test('不要用「領用／入庫」', () => {
    const all = Object.values(KIND_LABEL).join('');
    assert.doesNotMatch(all, /領用|入庫|出庫/);
  });
});

describe('txnRow —— qty 帶正負號', () => {
  /*
   * ★★★ 取用存成負數。兩邊都存正數的話 `sum(qty)` 就不是餘量，
   *   而每一個要算餘量的地方都得自己寫一次 case
   *   （CLAUDE.md:同一條規則在三個地方各寫一次）。
   */
  test('★★★ 取用存負數、補貨存正數', () => {
    assert.equal(txnRow('out', 'i1', 3, '2026-09-08').qty, -3);
    assert.equal(txnRow('in', 'i1', 24, '2026-09-08').qty, 24);
  });

  // ★ 畫面上讓人填正數。他不小心打了負號也要收得住
  test('★ 使用者填負數也照樣轉成正確方向', () => {
    assert.equal(txnRow('out', 'i1', -3, '2026-09-08').qty, -3);
    assert.equal(txnRow('in', 'i1', -24, '2026-09-08').qty, 24);
  });

  test('備註空白存 null 不是空字串', () => {
    assert.equal(txnRow('in', 'i1', 1, '2026-09-08', '  ').note, null);
  });
});

describe('txnError —— 送出前擋什麼', () => {
  // ★ 記一筆「動了 0 個」沒有意義，多半是打錯
  test('★ 0 要擋', () => {
    assert.ok(txnError('out', 0, '2026-09-08'));
    assert.ok(txnError('out', '', '2026-09-08'));
    assert.ok(txnError('out', 'abc', '2026-09-08'));
  });

  test('★ 填負數要講「填正數就好」，不要只說格式錯', () => {
    assert.match(txnError('out', -3, '2026-09-08')!, /正數/);
  });

  test('沒選日期要擋', () => {
    assert.ok(txnError('out', 3, ''));
  });

  test('正常的放行', () => {
    assert.equal(txnError('out', 3, '2026-09-08'), null);
  });
});

describe('送出前先算給人看', () => {
  test('43 取用 3 → 40；43 補貨 24 → 67', () => {
    assert.equal(previewAfter(43, 'out', 3), 40);
    assert.equal(previewAfter(43, 'in', 24), 67);
  });

  test('小數不要跑出浮點雜訊', () => {
    assert.equal(previewAfter(0.3, 'out', 0.1), 0.2);
  });

  /*
   * ★★ 負數**問一次，不是擋死**。那多半是打錯，但也可能是真的
   *   （先借出去了、補貨忘了登）—— 擋死的話那個人就記不了帳，
   *   而他手上的東西是真的少了。
   */
  test('★★ 會變負數時回一段警告，不是 null', () => {
    const w = negativeWarn(2, 'out', 5)!;
    assert.match(w, /-3/);
    assert.match(w, /不能刪/);
  });

  test('不會變負數就不囉嗦', () => {
    assert.equal(negativeWarn(10, 'out', 5), null);
    assert.equal(negativeWarn(0, 'in', 5), null);
  });

  test('剛好變 0 不算負數', () => {
    assert.equal(negativeWarn(5, 'out', 5), null);
  });
});

describe('低量與效期提醒', () => {
  test(`餘量 ≤ ${LOW_STOCK} 算低`, () => {
    assert.equal(isLow(LOW_STOCK), true);
    assert.equal(isLow(LOW_STOCK + 1), false);
    assert.equal(isLow(0), true);
  });

  test('效期兩個月內算快到期', () => {
    assert.equal(expiringSoon('2026-10-01', '2026-09-08'), true);
    assert.equal(expiringSoon('2027-06-01', '2026-09-08'), false);
  });

  test('★ 已經過期的也要算 —— 那更該提醒', () => {
    assert.equal(expiringSoon('2026-08-01', '2026-09-08'), true);
  });

  test('沒填效期不提醒', () => {
    assert.equal(expiringSoon(null, '2026-09-08'), false);
    assert.equal(expiringSoon('', '2026-09-08'), false);
  });
});

describe('盤點（2026-09-07）', () => {
  /*
   * ★★★ 「還沒盤」跟「盤到 0」是兩件事。
   *   空字串當成 0 的話，沒盤的品項會全部產生一筆「歸零」的調整 ——
   *   而那會把整個倉庫清空，畫面上只是一堆 0。
   */
  test('★★★ 還沒盤回 null，不是 0', () => {
    assert.equal(countDiff(D({ counted: '' })), null);
    assert.equal(countDiff(D({ counted: '  ' })), null);
  });

  test('★★★ 盤到 0 是真的 0，差異 −10', () => {
    assert.equal(countDiff(D({ system_qty: 10, counted: '0' })), -10);
  });

  test('差異 = 實際 − 系統', () => {
    assert.equal(countDiff(D({ system_qty: 15, counted: '17' })), 2);
    assert.equal(countDiff(D({ system_qty: 43, counted: '43' })), 0);
  });

  test('只有對不上的才要調整', () => {
    const ds = [
      D({ item_id: 'a', system_qty: 43, counted: '43' }),   // 對得上
      D({ item_id: 'b', system_qty: 2, counted: '0' }),     // 差 −2
      D({ item_id: 'c', counted: '' }),                     // 還沒盤
    ];
    assert.deepEqual(countsWithDiff(ds).map((d) => d.item_id), ['b']);
  });

  /*
   * ★ 差異是 0 就不產生流水 —— 那會是一筆 qty=0，
   *   而資料庫的 check 會擋（訊息看不懂）。
   */
  test('★ 對得上的產生盤點紀錄但不產生調整流水', () => {
    const p = countPlan([D({ system_qty: 43, counted: '43' })], '202609')[0];
    assert.equal(p.count.diff, 0);
    assert.equal(p.adjust, null);
  });

  test('對不上的產生一筆調整，方向跟差異一致', () => {
    const p = countPlan([D({ system_qty: 2, counted: '0' })], '202609')[0];
    assert.equal(p.adjust!.qty, -2);
    assert.equal(p.adjust!.kind, 'adjust');
  });

  test('還沒盤的完全不進計畫', () => {
    assert.equal(countPlan([D({ counted: '' })], '202609').length, 0);
  });

  test('原因空白存 null', () => {
    const p = countPlan([D({ system_qty: 2, counted: '0', reason: ' ' })], '202609')[0];
    assert.equal(p.count.reason, null);
  });

  // ★ 要講會產生幾筆調整 —— 使用者以為只是填了幾個數字
  test('★ 確認訊息要講盤了幾個、幾個對不上、會產生幾筆調整', () => {
    const m = countConfirm([
      D({ item_id: 'a', system_qty: 43, counted: '43' }),
      D({ item_id: 'b', system_qty: 2, counted: '0' }),
    ], '202609');
    assert.match(m, /2026-09/);
    assert.match(m, /盤了 2 個/);
    assert.match(m, /1 個對不上/);
    assert.match(m, /1 筆盤點調整/);
  });

  test('全部對得上時講清楚不會產生調整', () => {
    const m = countConfirm([D({ system_qty: 43, counted: '43' })], '202609');
    assert.match(m, /不會產生任何調整/);
  });

  test('一個都沒盤就回空字串（不要跳一個空對話框）', () => {
    assert.equal(countConfirm([D({ counted: '' })], '202609'), '');
  });
});
