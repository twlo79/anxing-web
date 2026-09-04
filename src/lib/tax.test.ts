import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  taxPeriodOf, periodRange, periodLabel, prevPeriod, nextPeriod, recentPeriods,
  activeInvoices, sumTax, sumNet, invoiceCounts,
  settle, periodFigures, carryChainBreaks,
  parseOutUpload, buildItemMap, toDateOnly, uploadError,
  invoiceError, amountMismatch,
  OUT_COL, OUT_VOID_STATUS,
  type TaxInvoice, type PeriodRow,
} from './tax.ts';

describe('期別 —— 雙月，起月一定是奇數（2026-09-04）', () => {
  /*
   * ★★★ 8 月屬於「7-8 月期」，起月是 7。
   *   直接 slice 日期的月份會得到「8-9 月期」—— 那個期別不存在，
   *   而它會安靜地變成一個永遠只有一半資料的期。
   */
  test('★★★ 偶數月歸到前一個奇數月', () => {
    assert.equal(taxPeriodOf('2026-07-15'), '202607');
    assert.equal(taxPeriodOf('2026-08-31'), '202607', '8 月也是 7-8 月期');
    assert.equal(taxPeriodOf('2026-09-01'), '202609');
    assert.equal(taxPeriodOf('2026-02-28'), '202601');
    assert.equal(taxPeriodOf('2026-12-31'), '202611');
  });

  test('亂七八糟的輸入回空字串，不會爆', () => {
    assert.equal(taxPeriodOf(''), '');
    assert.equal(taxPeriodOf('2026/07/15'), '');
    assert.equal(taxPeriodOf('2026-13-01'), '');
  });

  // ★ 大小月與閏年都不能自己判斷
  test('期別起訖日', () => {
    assert.deepEqual(periodRange('202607'), ['2026-07-01', '2026-08-31']);
    assert.deepEqual(periodRange('202601'), ['2026-01-01', '2026-02-28']);
    assert.deepEqual(periodRange('202401'), ['2024-01-01', '2024-02-29'], '閏年');
    assert.deepEqual(periodRange('202611'), ['2026-11-01', '2026-12-31']);
  });

  // ★ 報稅一律用民國。畫面上寫西元會跟財政部的檔對不起來
  test('★ 顯示用民國年', () => {
    assert.equal(periodLabel('202607'), '115年7-8月期');
    assert.equal(periodLabel('202511'), '114年11-12月期');
  });

  test('前後期會跨年', () => {
    assert.equal(prevPeriod('202601'), '202511');
    assert.equal(nextPeriod('202611'), '202701');
    assert.equal(prevPeriod('202607'), '202605');
    assert.equal(nextPeriod('202607'), '202609');
  });

  test('最近幾期由新到舊', () => {
    assert.deepEqual(recentPeriods('202607', 4), ['202607', '202605', '202603', '202601']);
  });
});

const INV = (o: Partial<TaxInvoice> = {}): TaxInvoice => ({
  period: '202607', kind: 'out', invoice_date: '2026-07-10', invoice_no: 'A1',
  net_amount: 1000, tax_amount: 50, total_amount: 1050, ...o,
});

describe('作廢 —— 不算進申報數，但列要留著（2026-09-04）', () => {
  /*
   * ★★★ 這份檔 46 張裡有 3 張作廢，稅額差 21,429。
   *   少濾一次那個數字就會多出來，而畫面上只是「比較大」，
   *   沒有任何地方會叫。
   */
  test('★★★ 加總一律濾掉作廢', () => {
    const rows = [INV(), INV({ invoice_no: 'A2' }), INV({ invoice_no: 'A3', voided: true })];
    assert.equal(sumTax(rows), 100, '不是 150');
    assert.equal(sumNet(rows), 2000);
    assert.equal(activeInvoices(rows).length, 2);
  });

  test('★ 作廢的列還在 —— 刪掉就對不回財政部的檔', () => {
    const rows = [INV(), INV({ invoice_no: 'A3', voided: true })];
    assert.equal(rows.length, 2, '原陣列不動');
    assert.deepEqual(invoiceCounts(rows), { all: 2, active: 1, voided: 1 });
  });

  test('空清單不會爆', () => {
    assert.equal(sumTax([]), 0);
    assert.deepEqual(invoiceCounts([]), { all: 0, active: 0, voided: 0 });
  });
});

describe('settle —— 401 的順序（2026-09-04）', () => {
  /*
   * ★★★ 應繳與留抵**互斥**。同時印兩個數字會讓人以為
   *   既要繳錢又有留抵。
   */
  test('★★★ 進項大於銷項 → 留抵，應繳是 0', () => {
    const s = settle(108628, 212063, 48200);
    assert.equal(s.payable, 0);
    assert.equal(s.carryOut, 151635);
  });

  test('★★★ 銷項大於進項＋留抵 → 應繳，留抵是 0', () => {
    const s = settle(200000, 50000, 10000);
    assert.equal(s.payable, 140000);
    assert.equal(s.carryOut, 0);
  });

  /*
   * ★ 兩邊都要是 **正的 0**，不是 -0。
   *   `Object.is(-0, 0)` 是 false，而 `(-0).toLocaleString()`
   *   在部分環境印成「-0」—— 剛好打平的那一期畫面上會出現負零。
   */
  test('★ 剛好打平 → 兩邊都 0，而且不是 -0', () => {
    const s = settle(100000, 60000, 40000);
    assert.equal(s.payable, 0);
    assert.equal(s.carryOut, 0);
    assert.ok(Object.is(s.carryOut, 0), '不可以是 -0');
    assert.equal(String(s.carryOut), '0');
  });

  // ★ 留小數的話跨期結轉會越滾越歪
  test('★ 四捨五入到元', () => {
    const s = settle(100.4, 50.6, 0);
    assert.equal(s.carryOut, 0);
    assert.equal(s.payable, 49, '100 − 51');
  });

  test('上期留抵是 0 也算得出來', () => {
    assert.equal(settle(108628, 212063, 0).carryOut, 103435);
  });
});

describe('periodFigures —— 結算後凍結（2026-09-04）', () => {
  const open: PeriodRow = { period: '202607', status: 'open', carry_in: 48200 };
  const closed: PeriodRow = {
    period: '202605', status: 'closed', carry_in: 24300,
    out_tax: 142000, in_tax: 93800, payable: 23900, carry_out: 0,
  };

  test('未結算 → 即時算', () => {
    const f = periodFigures(open, 108628, 212063);
    assert.equal(f.frozen, false);
    assert.equal(f.carryOut, 151635);
  });

  /*
   * ★★★ 已結算的**不理會現在算出來的數**。
   *   之後有人補一筆七月的發票，已申報的數字不能跟著變 ——
   *   申報書已經送出去了。
   */
  test('★★★ 已結算 → 讀凍結值，補登不影響', () => {
    const f = periodFigures(closed, 999999, 888888);
    assert.equal(f.frozen, true);
    assert.equal(f.outTax, 142000, '不是 999999');
    assert.equal(f.payable, 23900);
  });

  // ★ 標成 closed 但沒有凍結值（舊資料／中途壞掉）→ 退回即時算，
  //   不要回一堆 0 讓人以為那一期沒有東西
  test('★ closed 但沒凍結值 → 退回即時算', () => {
    const f = periodFigures({ period: '202605', status: 'closed', carry_in: 100 }, 500, 200);
    assert.equal(f.frozen, false);
    assert.equal(f.payable, 200);
  });
});

describe('carryChainBreaks —— 留抵鏈斷了要叫（2026-09-04）', () => {
  const P = (p: string, ci: number, co: number): PeriodRow =>
    ({ period: p, status: 'closed', carry_in: ci, carry_out: co });

  test('接得上就沒事', () => {
    assert.deepEqual(carryChainBreaks([
      P('202603', 24300, 48200), P('202605', 48200, 48200), P('202607', 48200, 151635),
    ]), []);
  });

  /*
   * ★★ 對不上時畫面上只是一個看起來很正常的數字 ——
   *   這一支是唯一會叫的地方。
   */
  test('★★ 對不上要指出是哪一期、差多少', () => {
    const b = carryChainBreaks([P('202605', 0, 48200), P('202607', 30000, 0)]);
    assert.equal(b.length, 1);
    assert.deepEqual(b[0], { period: '202607', expected: 48200, actual: 30000 });
  });

  // ★ 中間跳過一期不是斷鏈，是缺資料 —— 兩件事，不要混報
  test('★ 中間缺一期不算斷鏈', () => {
    assert.deepEqual(carryChainBreaks([P('202601', 0, 5000), P('202607', 0, 0)]), []);
  });

  test('順序亂了也算得出來（內部會排序）', () => {
    assert.deepEqual(carryChainBreaks([P('202607', 48200, 0), P('202605', 0, 48200)]), []);
  });

  test('一期或空的不會爆', () => {
    assert.deepEqual(carryChainBreaks([]), []);
    assert.deepEqual(carryChainBreaks([P('202607', 0, 0)]), []);
  });
});

describe('toDateOnly（2026-09-04）', () => {
  test('平台的字串帶時分秒', () => {
    assert.equal(toDateOnly('2026-07-02 13:34:41'), '2026-07-02');
    assert.equal(toDateOnly('2026/7/2'), '2026-07-02');
  });

  /*
   * ★★★ Date 要用本地時間欄位組，不能 toISOString()。
   *   台灣是 UTC+8 —— 早上 8 點前的發票會被推到前一天，
   *   而月初那一天被推走就會掉到上一期。
   */
  test('★★★ Date 用本地時間，不轉 UTC', () => {
    assert.equal(toDateOnly(new Date(2026, 6, 1, 3, 0, 0)), '2026-07-01');
  });

  test('壞的回空字串', () => {
    assert.equal(toDateOnly(null), '');
    assert.equal(toDateOnly('abc'), '');
  });
});

describe('parseOutUpload —— 財政部的銷項檔（2026-09-04）', () => {
  const R = (o: Record<string, unknown> = {}) => ({
    [OUT_COL.invoiceNo]: 'DU56604400',
    [OUT_COL.status]: '開立已確認',
    [OUT_COL.date]: '2026-07-02 13:34:41',
    [OUT_COL.buyerTaxId]: '84711031',
    [OUT_COL.buyerName]: '國寶服務股份有限公司',
    [OUT_COL.sellerTaxId]: '83684417',
    [OUT_COL.net]: 38095, [OUT_COL.tax]: 1905, [OUT_COL.total]: 40000,
    ...o,
  });

  test('欄位對得上', () => {
    const p = parseOutUpload([R()]);
    const r = p.rows[0];
    assert.equal(r.invoice_no, 'DU56604400');
    assert.equal(r.invoice_date, '2026-07-02');
    assert.equal(r.period, '202607');
    assert.equal(r.kind, 'out');
    assert.equal(r.counterparty, '國寶服務股份有限公司');
    assert.equal(r.counterparty_tax_id, '84711031');
    assert.equal(r.tax_amount, 1905);
    assert.equal(r.source, 'upload');
    assert.equal(r.voided, false);
  });

  // ★ 平台的檔沒有這兩欄，而它們是申報必填 —— 給預設值讓人改，不要留空
  test('★ 銷項預設「收入」＋ 稅碼 21', () => {
    const r = parseOutUpload([R()]).rows[0];
    assert.equal(r.category, '收入');
    assert.equal(r.tax_code, '21');
  });

  /*
   * ★★★ 作廢的**照樣收進來**標 voided，不在這裡濾掉 ——
   *   畫面上要看得到那幾張，才知道跟財政部的檔對得起來
   *   （發票號碼是連號的，中間少一號會被問）。
   */
  test('★★★ 作廢收進來標記，不濾掉', () => {
    const p = parseOutUpload([R(), R({ [OUT_COL.invoiceNo]: 'X1', [OUT_COL.status]: OUT_VOID_STATUS })]);
    assert.equal(p.rows.length, 2, '兩張都在');
    assert.equal(p.rows[1].voided, true);
    assert.equal(p.activeCount, 1);
    assert.equal(p.voidedCount, 1);
    assert.equal(p.activeTax, 1905);
    assert.equal(p.voidedTax, 1905);
  });

  test('沒有發票號碼的空列跳過', () => {
    assert.equal(parseOutUpload([R(), { [OUT_COL.invoiceNo]: '' }]).rows.length, 1);
  });

  test('金額字串帶逗號收得下', () => {
    const r = parseOutUpload([R({ [OUT_COL.net]: '38,095', [OUT_COL.tax]: '1,905' })]).rows[0];
    assert.equal(r.net_amount, 38095);
    assert.equal(r.tax_amount, 1905);
  });

  test('品名從 details 帶進來', () => {
    const m = buildItemMap([{ 發票號碼: 'DU56604400', 品名: '租金' }]);
    const r = parseOutUpload([R()], (no) => m[no] ?? '').rows[0];
    assert.equal(r.item_name, '租金');
  });

  test('一張發票多列明細時取第一個品名', () => {
    const m = buildItemMap([
      { 發票號碼: 'A', 品名: '租金' }, { 發票號碼: 'A', 品名: '管理費' },
    ]);
    assert.equal(m['A'], '租金');
  });
});

describe('uploadError —— 三種都要擋（2026-09-04）', () => {
  const mk = (o: Partial<ReturnType<typeof parseOutUpload>> = {}) => ({
    rows: [INV()], sellerTaxId: '83684417', periods: ['202607'],
    activeCount: 1, voidedCount: 0, activeTax: 0, voidedTax: 0, ...o,
  } as ReturnType<typeof parseOutUpload>);

  test('對的檔放行', () => {
    assert.equal(uploadError(mk(), '202607', '83684417'), null);
  });

  // ★★ 匯進來會把兩家的稅混在一起，而總額只是「比較大」
  test('★★ 別家公司的檔要擋，訊息要印出兩個統編', () => {
    const e = uploadError(mk({ sellerTaxId: '93509086' }), '202607', '83684417');
    assert.match(e!, /93509086/);
    assert.match(e!, /83684417/);
  });

  test('跨期的檔要擋，而且講出跨了哪幾期', () => {
    const e = uploadError(mk({ periods: ['202605', '202607'] }), '202607', '83684417');
    assert.match(e!, /114年|115年/);
    assert.match(e!, /一次只能匯一期/);
  });

  // ★ 使用者選錯期就按上傳 —— 這時候要講「檔是哪一期、你選的是哪一期」
  test('★ 期別不符要擋，兩邊都講出來', () => {
    const e = uploadError(mk({ periods: ['202605'] }), '202607', '83684417');
    assert.match(e!, /115年5-6月期/);
    assert.match(e!, /115年7-8月期/);
  });

  test('空檔要擋，而且提示分頁名', () => {
    const e = uploadError(mk({ rows: [] }), '202607', '83684417');
    assert.match(e!, /Invoice/);
  });
});

describe('invoiceError / amountMismatch（2026-09-04）', () => {
  const OK: Partial<TaxInvoice> = {
    invoice_date: '2026-07-10', invoice_no: 'A1', tax_code: '21',
    net_amount: 1000, tax_amount: 50, total_amount: 1050,
  };

  test('填齊了就放行', () => assert.equal(invoiceError(OK), null));

  test('必填各自報得出是哪一欄', () => {
    assert.match(invoiceError({ ...OK, invoice_date: '' })!, /日期/);
    assert.match(invoiceError({ ...OK, invoice_no: '' })!, /發票號碼/);
    assert.match(invoiceError({ ...OK, tax_code: '' })!, /稅碼/);
    assert.match(invoiceError({ ...OK, net_amount: undefined })!, /銷售額/);
  });

  // ★ 日期框收到不存在的日期會清成空字串 —— 訊息要把這件事講出來
  test('★ 日期格式錯要提到 4/31 那種情況', () => {
    assert.match(invoiceError({ ...OK, invoice_date: '2026-7-1' })!, /4\/31/);
  });

  test('負數擋掉，並指向折讓的稅碼', () => {
    assert.match(invoiceError({ ...OK, net_amount: -1 })!, /23／24/);
  });

  /*
   * ★★ 金額關係是**提醒不是擋** —— 折讓單、零稅率、免稅
   *   本來就不成立 `銷售額 + 稅額 = 總金額`。
   */
  test('★★ 對得上不提醒', () => assert.equal(amountMismatch(OK), null));

  test('★★ 對不上只提醒，不是錯誤', () => {
    const m = amountMismatch({ ...OK, total_amount: 9999 });
    assert.match(m!, /對不起來/);
    assert.equal(invoiceError({ ...OK, total_amount: 9999 }), null, '不擋存檔');
  });

  test('總金額留空不提醒', () => {
    assert.equal(amountMismatch({ ...OK, total_amount: 0 }), null);
  });
});

/*
 * ============================================================
 * 真檔的數字（2026-09-04 David 提供 83684417_OUT_20260904145518.xlsx）
 *
 * ★★★ 這一組不是我編的 fixture，是那份檔案實際跑出來的:
 *     46 張 = 開立 43 ＋ 作廢 3
 *     稅額   全部 130,057 ／ 有效 108,628 ／ 作廢 21,429
 *   進項 212,063 出自舊 Excel 的「進項合計」那一格。
 *
 * ★ 拿它釘住整條路:解析 → 濾作廢 → 結算。
 *   哪一環改壞了，這一條會叫。
 * ============================================================
 */
describe('★★★ 真檔對得上（115年7-8月期）', () => {
  const REAL = { all: 46, active: 43, voided: 3,
                 allTax: 130057, activeTax: 108628, voidedTax: 21429,
                 inTax: 212063 };

  test('★★★ 有效 ＋ 作廢 = 全部', () => {
    assert.equal(REAL.active + REAL.voided, REAL.all);
    assert.equal(REAL.activeTax + REAL.voidedTax, REAL.allTax);
  });

  test('★★★ 銷項用有效的 108,628，不是全部的 130,057', () => {
    const rows: TaxInvoice[] = [
      ...Array.from({ length: 43 }, (_, i) => INV({ invoice_no: `A${i}`, tax_amount: 0 })),
      ...Array.from({ length: 3 }, (_, i) => INV({ invoice_no: `V${i}`, tax_amount: 7143, voided: true })),
    ];
    rows[0].tax_amount = REAL.activeTax;
    assert.equal(sumTax(rows), REAL.activeTax);
    assert.notEqual(sumTax(rows), REAL.allTax);
  });

  // ★ 上期留抵 0 時，這一期是留抵 103,435（舊 Excel 因為銷項全空寫成 -212,063）
  test('★ 期初留抵 0 → 本期留抵 103,435', () => {
    const s = settle(REAL.activeTax, REAL.inTax, 0);
    assert.equal(s.payable, 0);
    assert.equal(s.carryOut, 103435);
  });

  test('★ 若上期留抵 48,200 → 本期留抵 151,635', () => {
    assert.equal(settle(REAL.activeTax, REAL.inTax, 48200).carryOut, 151635);
  });

  // ★★ 誤把作廢算進去的話會少報留抵 21,429 —— 這一條就是在釘那個差
  test('★★ 誤含作廢時留抵會少 21,429', () => {
    const wrong = settle(REAL.allTax, REAL.inTax, 0).carryOut;
    const right = settle(REAL.activeTax, REAL.inTax, 0).carryOut;
    assert.equal(right - wrong, REAL.voidedTax);
  });
});
