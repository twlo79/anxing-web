import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  looksLikeInvoice, splitTax, toInvoiceDraft, importable,
  pickedOf, importError, importSummary, toRows,
  type ExpenseSrc,
} from './tax-from-expense.ts';

const TAX_ID = '83684417';

const E = (o: Partial<ExpenseSrc> = {}): ExpenseSrc => ({
  id: 'e1', spent_on: '2026-09-02', item_name: '清潔耗材',
  amount: 2100, voucher_no: 'AB12345678', ...o,
});

describe('splitTax —— 含稅拆成銷售額與稅額（2026-09-05）', () => {
  /*
   * ★★★ 稅額用相減，不是 round(net × 0.05)。
   *   兩個各自四捨五入的話 net + tax 可能不等於 total，
   *   而 tax_invoice_amount_chk 會擋下來,訊息看不懂。
   */
  test('★★★ 銷售額 + 稅額一定等於總金額', () => {
    for (const g of [2100, 300, 10500, 1, 7, 999, 123456, 33]) {
      const r = splitTax(g);
      assert.equal(r.net + r.tax, r.total, `${g} 拆不回去`);
    }
  });

  test('整除的情況', () => {
    assert.deepEqual(splitTax(2100), { net: 2000, tax: 100, total: 2100 });
    assert.deepEqual(splitTax(10500), { net: 10000, tax: 500, total: 10500 });
  });

  test('不整除的情況', () => {
    // 300 / 1.05 = 285.71… → 286，稅額 14
    assert.deepEqual(splitTax(300), { net: 286, tax: 14, total: 300 });
  });

  test('0 元不會拆出稅額', () => {
    assert.deepEqual(splitTax(0), { net: 0, tax: 0, total: 0 });
  });

  // ★ 負數不該出現,但真的來了也不能拆出一個正的稅額
  test('★ 負數不拆', () => {
    assert.equal(splitTax(-100).tax, 0);
  });

  test('小數會先四捨五入成整數', () => {
    assert.equal(splitTax(2100.4).total, 2100);
  });
});

describe('looksLikeInvoice —— 兩個英文字母 ＋ 八個數字', () => {
  test('標準的統一發票號碼', () => {
    assert.equal(looksLikeInvoice('AB12345678'), true);
    assert.equal(looksLikeInvoice('ab12345678'), true);
    assert.equal(looksLikeInvoice(' AB12345678 '), true);
  });

  /*
   * ★ 這些是實際資料裡撈出來的（2026-09-05）。
   *   不合格式不代表一定不可扣抵 —— 所以列出來但不預設勾。
   */
  test('★ 實際資料裡不合格式的那幾種', () => {
    for (const no of ['免用統一收據', '0346', 'S80516012', 'BB0G597056',
      'BBAA523929', 'A111267969', 'B1150514', '036114']) {
      assert.equal(looksLikeInvoice(no), false, `${no} 不該被當成統一發票`);
    }
  });

  test('空的不算', () => {
    assert.equal(looksLikeInvoice(''), false);
    assert.equal(looksLikeInvoice(null), false);
    assert.equal(looksLikeInvoice(undefined), false);
  });
});

describe('toInvoiceDraft —— 欄位怎麼對過去', () => {
  test('合格式的:稅碼 25、預設勾、稅額反推', () => {
    const d = toInvoiceDraft(E(), '202609', TAX_ID);
    assert.equal(d.tax_code, '25');
    assert.equal(d.picked, true);
    assert.equal(d.net_amount, 2000);
    assert.equal(d.tax_amount, 100);
    assert.equal(d.total_amount, 2100);
  });

  /*
   * ★★★ 不合格式的稅額給 0,不給反推值。
   *   給它一個反推的稅額才危險 —— 那個數字看起來很正常，
   *   而它會進到 401 的進項稅額裡而沒有人會發現。
   */
  test('★★★ 不合格式的:稅碼 X、不預設勾、稅額 0', () => {
    const d = toInvoiceDraft(E({ voucher_no: '免用統一收據', amount: 300 }), '202609', TAX_ID);
    assert.equal(d.tax_code, 'X');
    assert.equal(d.picked, false);
    assert.equal(d.tax_amount, 0);
    assert.equal(d.net_amount, 300);
    assert.equal(d.total_amount, 300);
  });

  test('★ 稅碼一定有值 —— validate 會擋「要選稅碼」', () => {
    assert.ok(toInvoiceDraft(E({ voucher_no: 'xx' }), '202609', TAX_ID).tax_code);
  });

  test('廠商與統編從請款單帶過來', () => {
    const d = toInvoiceDraft(
      E({ payee_company: '好神拖有限公司', payee_tax_id: '12345678' }), '202609', TAX_ID);
    assert.equal(d.counterparty, '好神拖有限公司');
    assert.equal(d.counterparty_tax_id, '12345678');
  });

  test('接不到請款單時廠商與統編是 null 不是空字串', () => {
    const d = toInvoiceDraft(E(), '202609', TAX_ID);
    assert.equal(d.counterparty, null);
    assert.equal(d.counterparty_tax_id, null);
  });

  test('備註進摘要、支出 id 進收支帳', () => {
    const d = toInvoiceDraft(E({ id: 'xyz', note: '3F 用' }), '202609', TAX_ID);
    assert.equal(d.summary, '3F 用');
    assert.equal(d.voucher_ref, 'xyz');
    assert.equal(d.expense_id, 'xyz');
  });

  // ★ source 要看得出這是反推的,不能混進 manual
  test('★ source 是 expense', () => {
    assert.equal(toInvoiceDraft(E(), '202609', TAX_ID).source, 'expense');
    assert.equal(toInvoiceDraft(E(), '202609', TAX_ID).kind, 'in');
  });

  test('沒填備註時摘要是 null 不是空字串', () => {
    assert.equal(toInvoiceDraft(E({ note: '  ' }), '202609', TAX_ID).summary, null);
  });
});

describe('importable —— 三道過濾（2026-09-05）', () => {
  /*
   * ★★ 不擋期別的話,9-10 月的畫面上會出現 7 月的支出，
   *   帶進來之後那筆掛在 9-10 月期 —— 而它該在 7-8 月期申報。
   *   兩期同時錯,而畫面上兩邊都很正常。
   */
  test('★★ 只留同一期的', () => {
    const rows = [
      E({ id: 'a', spent_on: '2026-09-02' }),
      E({ id: 'b', spent_on: '2026-10-31' }),   // 偶數月歸前一個奇數月 → 同一期
      E({ id: 'c', spent_on: '2026-08-31' }),   // 上一期
      E({ id: 'd', spent_on: '2026-11-01' }),   // 下一期
    ];
    assert.deepEqual(
      importable(rows, '202609', TAX_ID).map((d) => d.expense_id).sort(), ['a', 'b']);
  });

  test('★ 沒有憑證號碼的不出現 —— 沒有發票號碼就不是發票', () => {
    const rows = [E({ id: 'a' }), E({ id: 'b', voucher_no: null }), E({ id: 'c', voucher_no: '  ' })];
    assert.deepEqual(importable(rows, '202609', TAX_ID).map((d) => d.expense_id), ['a']);
  });

  /*
   * ★★★ 帶兩次的話進項稅額憑空多一份，
   *   而 401 上只會顯示成「應繳比較少」—— 沒有地方會叫。
   */
  test('★★★ 已經帶過的不再出現', () => {
    const rows = [E({ id: 'a' }), E({ id: 'b' })];
    assert.deepEqual(
      importable(rows, '202609', TAX_ID, ['a']).map((d) => d.expense_id), ['b']);
  });

  test('★ 合格式的排前面 —— 那些是預設勾的', () => {
    const rows = [
      E({ id: 'x', voucher_no: '0346' }),
      E({ id: 'y', voucher_no: 'AB12345678' }),
    ];
    assert.deepEqual(importable(rows, '202609', TAX_ID).map((d) => d.expense_id), ['y', 'x']);
  });

  test('空清單不會爆', () => {
    assert.deepEqual(importable([], '202609', TAX_ID), []);
  });
});

describe('importError / importSummary', () => {
  const ok = () => importable([E()], '202609', TAX_ID);

  test('一筆都沒勾就擋', () => {
    const ds = importable([E({ voucher_no: '0346' })], '202609', TAX_ID);
    assert.match(importError(ds)!, /先勾/);
  });

  test('全部正常就放行', () => {
    assert.equal(importError(ok()), null);
  });

  // ★★ 資料庫的 amount_chk 也擋,但它回一句 SQL 例外 —— 這裡先講是哪一筆
  test('★★ 稅額大於總金額要擋,而且講出品名', () => {
    const ds = ok();
    ds[0].tax_amount = 99999;
    assert.match(importError(ds)!, /清潔耗材/);
  });

  test('負的稅額要擋', () => {
    const ds = ok();
    ds[0].tax_amount = -1;
    assert.match(importError(ds)!, /不合理/);
  });

  /*
   * ★ 摘要要講稅額合計 —— 那是這個動作對 401 的實際影響。
   *   「帶入 12 筆」看不出來會讓應繳稅額少多少。
   */
  test('★ 摘要有筆數、總金額、稅額合計', () => {
    const s = importSummary(ok());
    assert.match(s, /1 筆/);
    assert.match(s, /\$2,100/);
    assert.match(s, /\$100/);
  });

  test('沒勾的不算進摘要', () => {
    const ds = importable([E({ id: 'a' }), E({ id: 'b', voucher_no: '0346' })], '202609', TAX_ID);
    assert.equal(pickedOf(ds).length, 1);
    assert.match(importSummary(ds), /1 筆/);
  });

  test('toRows 只給勾起來的,而且拿掉 picked', () => {
    const ds = importable([E({ id: 'a' }), E({ id: 'b', voucher_no: '0346' })], '202609', TAX_ID);
    const rows = toRows(ds);
    assert.equal(rows.length, 1);
    assert.equal('picked' in rows[0], false);
    assert.equal((rows[0] as { expense_id: string }).expense_id, 'a');
  });
});
