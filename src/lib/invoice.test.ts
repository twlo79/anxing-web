import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { INV_NO_RE, INV_YM_RE, invYm, invoiceMissing } from './invoice.ts';

describe('invYm —— 六碼、沒有連字號', () => {
  test('正常日期', () => assert.equal(invYm('2026-08-31'), '202608'));
  test('帶時間也吃得下', () => assert.equal(invYm('2026-08-31T00:00:00'), '202608'));
  test('空的回空字串，不要編一個出來', () => {
    assert.equal(invYm(null), '');
    assert.equal(invYm(undefined), '');
    assert.equal(invYm(''), '');
  });
  test('格式不對回空字串', () => assert.equal(invYm('2026/08/31'), ''));

  /*
   * ★★★ 這一條釘住 2026-09-22 那個 bug：
   *   `String(d).slice(0, 7)` 回的是 '2026-08'（七碼、有橫線），
   *   而資料庫的 `invoices_ym_chk` 只收六碼 —— 存下去必爆。
   */
  test('★★★ 不可以是 slice(0,7) 那種七碼帶橫線的形狀', () => {
    const wrong = '2026-08-31'.slice(0, 7);
    assert.equal(wrong, '2026-08');
    assert.equal(INV_YM_RE.test(wrong), false);
    assert.equal(INV_YM_RE.test(invYm('2026-08-31')), true);
  });
});

describe('INV_YM_RE —— 跟資料庫的 invoices_ym_chk 同一條', () => {
  test('六碼數字過', () => assert.equal(INV_YM_RE.test('202608'), true));
  test('七碼帶橫線不過', () => assert.equal(INV_YM_RE.test('2026-08'), false));
  test('空的不過', () => assert.equal(INV_YM_RE.test(''), false));
  test('八碼不過', () => assert.equal(INV_YM_RE.test('20260831'), false));
});

describe('invoiceMissing —— 一次只回第一個錯', () => {
  const ok = { ym: '202608', invoice_no: 'CA31814450', invoice_date: '2026-08-31' };

  test('都填對回 null', () => assert.equal(invoiceMissing(ok), null));

  test('號碼錯先講號碼', () => {
    assert.match(invoiceMissing({ ...ok, invoice_no: 'CA3181445' })!, /發票號碼/);
    assert.match(invoiceMissing({ ...ok, invoice_no: '' })!, /發票號碼/);
  });

  test('號碼對了才輪到日期', () => {
    assert.match(invoiceMissing({ ...ok, invoice_date: '' })!, /開票日期/);
  });

  /*
   * ★★ 訊息要指著使用者看得到的東西。畫面上沒有「月份」那一格 ——
   *   它是從加費那一列的日期推出來的，所以訊息要叫他去補**日期**。
   */
  test('★★★ ym 不是六碼就擋住，而且訊息講的是「日期」不是「月份格式」', () => {
    const m = invoiceMissing({ ...ok, ym: '2026-08' })!;
    assert.ok(m, '應該要擋');
    assert.match(m, /日期/);
    assert.doesNotMatch(m, /格式錯誤/);
    assert.equal(invoiceMissing({ ...ok, ym: '' })!, m);
  });

  test('號碼小寫也過（存檔前會轉大寫）', () => {
    assert.equal(invoiceMissing({ ...ok, invoice_no: 'ca31814450' }), null);
  });
});

describe('INV_NO_RE', () => {
  test('兩碼英文八碼數字', () => assert.equal(INV_NO_RE.test('AB12345678'), true));
  test('小寫不過（呼叫端要先轉大寫）', () => assert.equal(INV_NO_RE.test('ab12345678'), false));
  test('長度不對不過', () => assert.equal(INV_NO_RE.test('AB1234567'), false));
});
