import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { voucherBrief, isMultiVoucher } from './voucher.ts';

/**
 * 憑證號碼的截斷。
 *
 * 這裡切錯**不會報錯**，只會讓人看到一個看起來很正常但不完整的號碼 ——
 * 而憑證號碼正是拿去跟發票對帳的東西。
 */

describe('拆解', () => {
  test('★★ 三種分隔號都要認', () => {
    // 填單的人頓號、半形逗號、全形逗號都打過。
    // 只認一種的話,另外兩種會被當成「一個很長的號碼」而不截斷。
    assert.equal(voucherBrief('A1、B2、C3', 2)?.more, 1);
    assert.equal(voucherBrief('A1,B2,C3', 2)?.more, 1);
    assert.equal(voucherBrief('A1，B2，C3', 2)?.more, 1);
  });

  test('前後空白要去掉', () => {
    assert.equal(voucherBrief(' A1 、 B2 ')?.text, 'A1、B2');
  });

  test('空的分段不算一個', () => {
    // 「A1、、B2」不該被算成三個
    assert.equal(voucherBrief('A1、、B2', 5)?.text, 'A1、B2');
  });
});

describe('截斷', () => {
  test('沒超過就全部顯示，more 是 0', () => {
    const v = voucherBrief('A1、B2', 2);
    assert.equal(v?.text, 'A1、B2');
    assert.equal(v?.more, 0);
  });

  test('★★ 超過要留「還有幾個」', () => {
    /*
     * 直接切掉的話，看的人會以為這筆真的只有兩個號碼 ——
     * 而那比現在整串亂碼更容易讓人做出錯的判斷。
     */
    const v = voucherBrief('A1、B2、C3、D4', 2);
    assert.equal(v?.text, 'A1、B2');
    assert.equal(v?.more, 2);
  });

  test('★ full 一定是完整的 —— 抽屜與 title 要看得到全部', () => {
    const v = voucherBrief('A1、B2、C3、D4', 2);
    assert.equal(v?.full, 'A1、B2、C3、D4');
  });

  test('★ 一個號碼都不能少 —— 只是斷開顯示，不是丟掉', () => {
    const src = 'CD78918483、CD78918502、DU13853833、DU13853875';
    assert.equal(voucherBrief(src, 1)!.full, src);
    assert.equal(voucherBrief(src, 1)!.more, 3);
  });
});

describe('沒有號碼', () => {
  test('★ 回 null，不要自己決定要顯示什麼', () => {
    /*
     * 「無憑證（有人勾過）」跟「未填（沒人碰過）」是兩件事,
     * 而這支不知道 no_voucher 的值。決定權留給呼叫端。
     */
    assert.equal(voucherBrief(null), null);
    assert.equal(voucherBrief(''), null);
    assert.equal(voucherBrief('   '), null);
    assert.equal(voucherBrief('、、'), null);
  });
});

describe('是不是多筆混在一起', () => {
  test('★ 抽屜要靠它決定加不加來源說明', () => {
    assert.equal(isMultiVoucher('A1'), false);
    assert.equal(isMultiVoucher('A1、B2'), false);      // 預設 keep=2
    assert.equal(isMultiVoucher('A1、B2、C3'), true);
    assert.equal(isMultiVoucher(null), false);
  });
});
