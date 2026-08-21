import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  voucherBrief, isMultiVoucher,
  resolveVoucher, voucherText, itemVoucherDisabled, missingVouchers, voucherSummary,
} from './voucher.ts';

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


/* ══════════════════════════════════════════════════════════
 * 逐項憑證（migration_155）
 * ══════════════════════════════════════════════════════════ */

const shared = (no: string | null, none = false) =>
  ({ shared_voucher: true, voucher_no: no, no_voucher: none });
const perItem = { shared_voucher: false, voucher_no: null, no_voucher: false };

describe('共同憑證 vs 逐項', () => {
  test('★★ 勾了共同憑證，項目上的舊號碼一律不使用', () => {
    /*
     * 使用者指定「留著但不使用（灰掉）」。
     *
     * 如果寫成「誰有填就用誰」,會變成:勾了共同憑證,
     * 但某一項底下還留著上次填的舊號碼 —— 那一項用舊的、
     * 其他項用共同的。**畫面上完全看不出來**,因為兩邊都顯示得出東西。
     */
    const st = resolveVoucher(shared('AB-001'), { voucher_no: '舊號碼', no_voucher: false });
    assert.deepEqual(st, { kind: 'shared', no: 'AB-001' });
  });

  test('★ 取消勾選之後，項目的號碼要回來', () => {
    // 「留著」的意義就在這裡 —— 不用重打一次。
    const item = { voucher_no: '舊號碼', no_voucher: false };
    assert.deepEqual(resolveVoucher(perItem, item), { kind: 'item', no: '舊號碼' });
  });

  test('沒勾共同憑證就看項目自己的', () => {
    assert.deepEqual(resolveVoucher(perItem, { voucher_no: 'X1' }), { kind: 'item', no: 'X1' });
  });

  test('★ 共同憑證勾了但號碼是空的 → blank，不是 shared', () => {
    // 顯示成「—」而不是空的號碼,不然看起來像填好了。
    assert.deepEqual(resolveVoucher(shared('   '), {}), { kind: 'blank' });
  });

  test('項目的憑證欄該不該灰掉', () => {
    assert.equal(itemVoucherDisabled(shared('A')), true);
    assert.equal(itemVoucherDisabled(perItem), false);
  });
});

describe('無憑證 vs 還沒填', () => {
  test('★★ 這兩個顯示不能一樣', () => {
    /*
     * 前者是有人查過、確定沒有單據;後者是沒有人碰過。
     * 印成一樣的話,對帳的人不知道該不該去追
     * （2026-08-19 使用者問「有兩種顯示要怎麼整合」—— 答案是不整合）。
     */
    assert.equal(voucherText({ kind: 'item-none' }), '無憑證');
    assert.equal(voucherText({ kind: 'blank' }), '—');
    assert.notEqual(voucherText({ kind: 'item-none' }), voucherText({ kind: 'blank' }));
  });

  test('★ 每項各自的無憑證 —— 四項有發票、一項現金車馬費', () => {
    const items = [
      { voucher_no: 'A1' }, { voucher_no: 'A2' }, { voucher_no: 'A3' }, { voucher_no: 'A4' },
      { voucher_no: null, no_voucher: true },     // 給阿姨的現金,真的沒單據
    ];
    assert.deepEqual(items.map((i) => resolveVoucher(perItem, i).kind),
      ['item', 'item', 'item', 'item', 'item-none']);
  });

  test('共同憑證整張註記無憑證', () => {
    assert.deepEqual(resolveVoucher(shared(null, true), {}), { kind: 'shared-none' });
  });
});

describe('送審前提醒', () => {
  test('★★ 要講出是哪幾項，不是「有項目沒填」', () => {
    /*
     * 十七個項目的單子上,「有項目沒填」等於沒說 ——
     * 使用者得自己一個一個找,而找的過程中很容易就放棄。
     */
    const miss = missingVouchers(perItem, [
      { item_name: '清潔用品', voucher_no: 'A1' },
      { item_name: '五金' },
      { item_name: '冷氣維修' },
    ]);
    assert.deepEqual(miss, ['五金', '冷氣維修']);
  });

  test('項目沒有名字時要給得出位置', () => {
    assert.deepEqual(missingVouchers(perItem, [{ item_name: '  ' }]), ['第 1 項']);
  });

  test('全部填好回空陣列', () => {
    assert.deepEqual(missingVouchers(perItem,
      [{ voucher_no: 'A' }, { no_voucher: true }]), []);
  });

  test('★ 共同憑證只看單張那一格 —— 不要去唸每個項目', () => {
    assert.deepEqual(missingVouchers(shared('A1'), [{}, {}, {}]), []);
    assert.deepEqual(missingVouchers(shared(null), [{}]), ['整張單的共同憑證']);
  });
});

describe('列表上的摘要', () => {
  test('★★ 舊單（共同憑證）沿用截斷 —— 那串頓號號碼還在', () => {
    const s = voucherSummary(shared('CD789、CD790、DU138、DU139'), []);
    assert.equal(s.text, 'CD789、CD790 +2');
    assert.equal(s.full, 'CD789、CD790、DU138、DU139');   // 一個號碼都不能少
    assert.equal(s.warn, false);
  });

  test('★ 逐項沒填完要標成待處理', () => {
    const s = voucherSummary(perItem, [{ voucher_no: 'A' }, {}, {}]);
    assert.equal(s.text, '1 / 3');
    assert.equal(s.warn, true);
  });

  test('逐項全部填好', () => {
    const s = voucherSummary(perItem, [{ voucher_no: 'A' }, { no_voucher: true }]);
    assert.equal(s.text, '逐項 2');
    assert.equal(s.warn, false);
  });

  test('★ 一個項目都沒有的單子算待處理', () => {
    assert.equal(voucherSummary(perItem, []).warn, true);
  });

  test('共同憑證註記無憑證不算待處理', () => {
    assert.equal(voucherSummary(shared(null, true), []).warn, false);
  });
});

describe('舊資料的行為不能變', () => {
  test('★★ 59 張舊單回填成 shared_voucher=true 之後，顯示與現在一致', () => {
    /*
     * migration_155 把既有的單全部標成共同憑證。
     * 這一條是那個決定的守門員 —— 舊單的憑證欄位一個字都不該變。
     */
    const old = { shared_voucher: true, voucher_no: 'INV-2026-0001', no_voucher: false };
    assert.equal(voucherText(resolveVoucher(old, {})), 'INV-2026-0001');
    assert.equal(voucherSummary(old, [{}, {}, {}]).text, 'INV-2026-0001');
  });
});
