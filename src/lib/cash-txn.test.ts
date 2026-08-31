import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  netOf, recalcBalances, changedBalances, validateCash, draftToRow,
  type CashRow, type CashDraft,
} from './cash-txn.ts';

const row = (post_date: string, credit = 0, debit = 0, id?: string, seq?: number): CashRow =>
  ({ id, post_date, credit, debit, seq });

describe('netOf', () => {
  test('存入為正、支出為負', () => {
    assert.equal(netOf({ credit: 8000, debit: 0 }), 8000);
    assert.equal(netOf({ credit: 0, debit: 1200 }), -1200);
  });

  test('字串進來也要算對（input 給的都是字串）', () => {
    assert.equal(netOf({ credit: '8000', debit: '0' }), 8000);
  });

  test('null／undefined 當 0，不要變 NaN', () => {
    // NaN 會一路傳染下去,而畫面上顯示的是空白 —— 看起來像沒資料而不是算錯
    assert.equal(netOf({ credit: null as never, debit: 500 }), -500);
  });
});

describe('recalcBalances', () => {
  test('從 0 開始累加', () => {
    const out = recalcBalances([row('2026-08-12', 0, 1200), row('2026-08-18', 8000)]);
    assert.deepEqual(out.map((r) => r.balance), [-1200, 6800]);
  });

  test('期初餘額會被算進去', () => {
    const out = recalcBalances([row('2026-08-12', 0, 1200), row('2026-08-18', 8000)], 16700);
    assert.deepEqual(out.map((r) => r.balance), [15500, 23500]);
  });

  test('順序不拘 —— 傳進來是亂的也要排好再算', () => {
    const out = recalcBalances([row('2026-08-18', 8000), row('2026-08-12', 0, 1200)], 16700);
    assert.deepEqual(out.map((r) => r.post_date), ['2026-08-12', '2026-08-18']);
    assert.deepEqual(out.map((r) => r.balance), [15500, 23500]);
  });

  test('同一天多筆用 seq 決定先後', () => {
    const out = recalcBalances([
      row('2026-08-12', 0, 500, 'b', 2),
      row('2026-08-12', 1000, 0, 'a', 1),
    ]);
    assert.deepEqual(out.map((r) => r.id), ['a', 'b']);
    assert.deepEqual(out.map((r) => r.balance), [1000, 500]);
  });

  test('不改動傳進來的陣列', () => {
    const src = [row('2026-08-12', 1000)];
    recalcBalances(src, 500);
    assert.equal(src[0].balance, undefined);
  });

  test('空陣列不會爆', () => {
    assert.deepEqual(recalcBalances([]), []);
  });
});

describe('★★★ 插進中間要讓後面全部跟著改', () => {
  /*
   * 這是現金帳戶跟銀行帳戶最根本的差異。
   * 只算新那一筆的話,後面的餘額會停在舊值,而它跟前後兜不攏 ——
   * 不會報錯,只會讓某一段的餘額全部差一個固定的數。
   */
  test('補一筆 8/15 之後，8/18 的餘額也要變', () => {
    const before = recalcBalances(
      [row('2026-08-12', 0, 1200, 'x'), row('2026-08-18', 8000, 0, 'y')], 16700);
    assert.deepEqual(before.map((r) => r.balance), [15500, 23500]);

    const after = recalcBalances([...before, row('2026-08-15', 0, 500, 'z')], 16700);
    assert.deepEqual(after.map((r) => r.id), ['x', 'z', 'y']);
    assert.deepEqual(after.map((r) => r.balance), [15500, 15000, 23000]);
  });

  test('刪掉中間一筆，後面也要跟著回去', () => {
    const three = recalcBalances([
      row('2026-08-12', 0, 1200, 'x'), row('2026-08-15', 0, 500, 'z'),
      row('2026-08-18', 8000, 0, 'y'),
    ], 16700);
    assert.deepEqual(three.map((r) => r.balance), [15500, 15000, 23000]);

    const two = recalcBalances(three.filter((r) => r.id !== 'z'), 16700);
    assert.deepEqual(two.map((r) => r.balance), [15500, 23500]);
  });

  test('改金額之後，那一筆之後的全部跟著改', () => {
    const orig = recalcBalances([
      row('2026-08-12', 0, 1200, 'x'), row('2026-08-18', 8000, 0, 'y'),
    ], 16700);
    const edited = orig.map((r) => (r.id === 'x' ? { ...r, debit: 2200 } : r));
    const out = recalcBalances(edited, 16700);
    assert.deepEqual(out.map((r) => r.balance), [14500, 22500]);
  });
});

describe('★★ 累加不可以漂', () => {
  test('小數累加不會出現 0.30000000000000004', () => {
    const rows = Array.from({ length: 3 }, (_, i) =>
      row(`2026-08-1${i}`, 0.1, 0, String(i)));
    const out = recalcBalances(rows);
    assert.deepEqual(out.map((r) => r.balance), [0.1, 0.2, 0.3]);
  });

  test('幾百筆之後餘額仍然是乾淨的兩位小數', () => {
    const rows = Array.from({ length: 300 }, (_, i) =>
      row(`2026-01-01`, 10.01, 0, String(i), i));
    const out = recalcBalances(rows);
    const last = Number(out[out.length - 1].balance);
    assert.equal(last, 3003);
    assert.equal(Math.round(last * 100), last * 100);
  });
});

describe('changedBalances', () => {
  test('只挑出真的變了的', () => {
    const before = [
      { id: 'x', post_date: '2026-08-12', credit: 0, debit: 1200, balance: 15500 },
      { id: 'y', post_date: '2026-08-18', credit: 8000, debit: 0, balance: 23500 },
    ];
    const after = [...before.slice(0, 1), { ...before[1], balance: 23000 }];
    assert.deepEqual(changedBalances(before, after), [{ id: 'y', balance: 23000 }]);
  });

  test('沒有東西變的話回空陣列（不要白寫一輪）', () => {
    const rows = [{ id: 'x', post_date: '2026-08-12', credit: 0, debit: 1200, balance: 15500 }];
    assert.deepEqual(changedBalances(rows, rows), []);
  });

  test('還沒有 id 的（剛新增的那一筆）跳過', () => {
    const after = [{ post_date: '2026-08-12', credit: 100, debit: 0, balance: 100 }];
    assert.deepEqual(changedBalances([], after), []);
  });
});

describe('validateCash', () => {
  const ok: CashDraft = {
    post_date: '2026-08-18', counterparty: '陳小胖',
    dir: 'credit', amount: '8000', memo: '開封1F-1 8月租金',
  };

  test('填齊了就過', () => assert.equal(validateCash(ok), null));
  test('摘要可以空白', () => assert.equal(validateCash({ ...ok, memo: '' }), null));

  test('沒填日期', () => assert.match(validateCash({ ...ok, post_date: '' })!, /交易日/));
  test('沒填人名', () => assert.match(validateCash({ ...ok, counterparty: '' })!, /人名/));
  test('人名只有空白也算沒填', () =>
    assert.match(validateCash({ ...ok, counterparty: '   ' })!, /人名/));
  test('沒填金額', () => assert.match(validateCash({ ...ok, amount: '' })!, /要填金額/));

  test('★ 金額帶單位要擋 —— parseFloat 會吃掉尾巴然後裝作沒事', () => {
    assert.match(validateCash({ ...ok, amount: '100元' })!, /只能填數字/);
    assert.match(validateCash({ ...ok, amount: '1,000' })!, /只能填數字/);
  });

  test('★ 全形數字也擋 —— 存進去會變 NaN', () => {
    assert.match(validateCash({ ...ok, amount: '１０００' })!, /只能填數字/);
  });

  test('0 與負數要擋（方向用下拉選，不是用負號）', () => {
    assert.match(validateCash({ ...ok, amount: '0' })!, /大於 0/);
    assert.match(validateCash({ ...ok, amount: '-500' })!, /大於 0/);
  });

  test('★ 分以下要擋 —— numeric(14,2) 會偷偷四捨五入', () => {
    assert.match(validateCash({ ...ok, amount: '100.005' })!, /兩位/);
    assert.equal(validateCash({ ...ok, amount: '100.05' }), null);
  });

  test('大到不像話的擋（多打幾個 0）', () => {
    assert.match(validateCash({ ...ok, amount: '1000000000000' })!, /太大/);
  });

  test('一次只回一個錯誤，而且是最前面那個', () => {
    const bad = { ...ok, post_date: '', counterparty: '', amount: '' };
    assert.match(validateCash(bad)!, /交易日/);
  });
});

describe('draftToRow', () => {
  const d: CashDraft = {
    post_date: '2026-08-18', counterparty: ' 陳小胖 ',
    dir: 'credit', amount: '8000', memo: ' 8月租金 ',
  };

  test('交易型態固定是「現金」', () => {
    assert.equal(draftToRow(d, 'acc-1').description, '現金');
  });

  test('人名進 counterparty，前後空白去掉', () => {
    assert.equal(draftToRow(d, 'acc-1').counterparty, '陳小胖');
  });

  test('存入寫 credit、支出寫 debit，另一邊是 0', () => {
    const c = draftToRow(d, 'acc-1');
    assert.equal(c.credit, 8000);
    assert.equal(c.debit, 0);
    const e = draftToRow({ ...d, dir: 'debit' }, 'acc-1');
    assert.equal(e.debit, 8000);
    assert.equal(e.credit, 0);
  });

  test('★ bank_txn_one_side 這個 check 不會被違反（一邊一定是 0）', () => {
    for (const dir of ['credit', 'debit'] as const) {
      const r = draftToRow({ ...d, dir }, 'acc-1');
      assert.ok(Number(r.debit) === 0 || Number(r.credit) === 0);
    }
  });

  test('空摘要存 null 不是空字串', () => {
    // 空字串跟 null 在畫面上長得一樣,但排序與 `is null` 的查詢會分岔
    assert.equal(draftToRow({ ...d, memo: '  ' }, 'acc-1').memo, null);
  });

  test('★ ref_no 與 statement_id 都是 null —— 現金沒有帳號也沒有對帳單', () => {
    const r = draftToRow(d, 'acc-1');
    assert.equal(r.ref_no, null);
    assert.equal(r.statement_id, null);
    assert.equal(r.bank_balance, null);
  });

  test('txn_date 跟 post_date 一樣（現金當天就入帳）', () => {
    const r = draftToRow(d, 'acc-1');
    assert.equal(r.txn_date, r.post_date);
  });
});
