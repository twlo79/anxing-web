/**
 * lib/other-book.ts 的「安幸代墊」那一組（2026-09-17）。
 *
 * ★ 這幾支決定的是**畫面上看不看得出哪幾筆是代墊**。
 *   使用者 2026-09-17 連問三次「怎麼還是三筆」「全都代墊」——
 *   每一次都是因為這一頁沒有這個籤。
 *
 * 跑法：node --experimental-strip-types --test src/lib/other-book.test.ts
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  isLent, lentTotal, lentSiblings, type Entry,
  paidOf, dueOf, gapOf, isSettledExpense, bookTotals,
  validatePayment, overpayWarning, PAY_METHODS,
  drawerShape, delIncomeMsg,
} from './other-book.ts';

const ex = (id: string, amount: number, advanceId?: string | null): Entry => ({
  id, kind: 'expense', date: '2026-09-08', name: id, account_code: null,
  party: null, amount, note: null, settled: true, advanceId: advanceId ?? null,
});
const inc = (id: string, amount: number, advanceId?: string | null): Entry => ({
  ...ex(id, amount, advanceId), kind: 'income',
});

/* ══════════════ isLent ══════════════ */

test('isLent：有 advanceId 就是代墊', () => {
  assert.equal(isLent(ex('a', 100, 'AP1')), true);
});

test('isLent：null／空字串／沒這個欄位都不是', () => {
  assert.equal(isLent(ex('a', 100, null)), false);
  assert.equal(isLent(ex('a', 100, '')), false);
  assert.equal(isLent({ ...ex('a', 100) , advanceId: undefined }), false);
  assert.equal(isLent(null), false);
  assert.equal(isLent(undefined), false);
});

/* ══════════════ lentTotal ══════════════ */

test('★★★ lentTotal：愛皮 2026-09 的真實數字', () => {
  // 三張請款單、8 筆支出（2026-09-17 線上資料）
  const rows = [
    ex('健保費', 1428, 'AP075'), ex('勞保費', 3102, 'AP075'),
    ex('旅平險', 261, 'AP086'), ex('電信0975-7月', 246, 'AP086'),
    ex('電信2778-8月', 305, 'AP086'), ex('電信2778-7月', 300, 'AP086'),
    ex('電信0975-8月', 217, 'AP086'),
    ex('管理服務費', 7350, 'AP077'),
  ];
  assert.equal(lentTotal(rows), 13209);
  // 暫付那三列加起來也要是同一個數 —— 兩邊對不上就是漏了一筆
  assert.equal(4530 + 1329 + 7350, 13209);
});

test('lentTotal：沒代墊的不算進去', () => {
  assert.equal(lentTotal([ex('a', 100, 'AP1'), ex('b', 50, null)]), 100);
});

test('★★ lentTotal 只算支出 —— 收入沒有代墊這回事', () => {
  // 收入那一側就算被塞了 advanceId 也不該讓這個數字變大
  assert.equal(lentTotal([ex('a', 100, 'AP1'), inc('b', 999, 'AP1')]), 100);
});

test('lentTotal：空清單／null 回 0，不是 NaN', () => {
  assert.equal(lentTotal([]), 0);
  assert.equal(lentTotal(null), 0);
  assert.equal(lentTotal(undefined), 0);
});

test('lentTotal：金額四捨五入到整數（台幣沒有小數）', () => {
  assert.equal(lentTotal([ex('a', 100.4, 'AP1'), ex('b', 100.6, 'AP1')]), 201);
});

/* ══════════════ lentSiblings ══════════════ */

test('★★★ lentSiblings：五筆的那一組要回五筆（含自己）', () => {
  const rows = [
    ex('健保費', 1428, 'AP075'), ex('勞保費', 3102, 'AP075'),
    ex('旅平險', 261, 'AP086'), ex('電信0975-7月', 246, 'AP086'),
    ex('電信2778-8月', 305, 'AP086'), ex('電信2778-7月', 300, 'AP086'),
    ex('電信0975-8月', 217, 'AP086'),
  ];
  const five = lentSiblings(rows, 'AP086');
  assert.equal(five.length, 5);
  assert.equal(five.reduce((s, e) => s + e.amount, 0), 1329);

  const two = lentSiblings(rows, 'AP075');
  assert.equal(two.length, 2);
  assert.equal(two.reduce((s, e) => s + e.amount, 0), 4530);
});

test('lentSiblings：沒有 advanceId 就回空陣列，不是全部', () => {
  const rows = [ex('a', 1, 'AP1'), ex('b', 2, 'AP2')];
  assert.deepEqual(lentSiblings(rows, null), []);
  assert.deepEqual(lentSiblings(rows, undefined), []);
  assert.deepEqual(lentSiblings(rows, ''), []);
});

test('lentSiblings：撈不到就是空的，不要回 undefined', () => {
  assert.deepEqual(lentSiblings([ex('a', 1, 'AP1')], 'AP9'), []);
  assert.deepEqual(lentSiblings(null, 'AP1'), []);
});

/*
 * ★★ 分組加總 == 總額。分組漏掉一筆的話,
 *   點開來的明細加起來會比那一列暫付少 —— 而畫面上兩個數字都「看起來正常」。
 */
test('★★ 每一組的加總，合起來要等於 lentTotal', () => {
  const rows = [
    ex('健保費', 1428, 'AP075'), ex('勞保費', 3102, 'AP075'),
    ex('旅平險', 261, 'AP086'), ex('電信0975-7月', 246, 'AP086'),
    ex('電信2778-8月', 305, 'AP086'), ex('電信2778-7月', 300, 'AP086'),
    ex('電信0975-8月', 217, 'AP086'),
    ex('管理服務費', 7350, 'AP077'),
    ex('自己付的', 500, null),
  ];
  const ids = [...new Set(rows.map((r) => r.advanceId).filter(Boolean))] as string[];
  const sum = ids.reduce(
    (s, id) => s + lentSiblings(rows, id).reduce((n, e) => n + e.amount, 0), 0);
  assert.equal(sum, lentTotal(rows));
  assert.equal(sum, 13209);
});

/* ══════════════════════════════════════════════════════════
 * 應支與實支（migration_277，2026-09-17／18）
 * ══════════════════════════════════════════════════════════ */

const EXP = (o: Partial<Entry> = {}): Entry => ({
  id: 'e1', kind: 'expense', date: '2026-09-09', name: '勞保費',
  account_code: '5200', party: null, amount: 3102, note: null, settled: true, ...o,
});
const noPays = () => [];
const noAdv = () => null;

describe('★★★ paidOf —— 代墊與自付走不同來源', () => {
  test('自付:把付款明細加起來', () => {
    const e = EXP({ amount: 5000 });
    const pays = [
      { expense_id: 'e1', paid_on: '2026-09-20', amount: 2000 },
      { expense_id: 'e1', paid_on: '2026-09-25', amount: 1500 },
    ];
    assert.equal(paidOf(e, () => pays, noAdv), 3500);
  });

  test('自付、一筆都還沒付 → 0（不是 null）', () => {
    assert.equal(paidOf(EXP(), noPays, noAdv), 0);
  });

  test('★★★ 代墊:讀安幸那一列暫付收回了多少', () => {
    const e = EXP({ advanceId: 'a1' });
    assert.equal(paidOf(e, noPays, () => 3102), 3102);
  });

  test('★★★ 代墊還沒收回（null）→ 實支 0 —— 從愛皮的帳上看錢還沒付', () => {
    assert.equal(paidOf(EXP({ advanceId: 'a1' }), noPays, () => null), 0);
  });

  test('★★ 代墊全額被扣（收回 0）也是 0 —— null 與 0 在這裡同一個結果', () => {
    assert.equal(paidOf(EXP({ advanceId: 'a1' }), noPays, () => 0), 0);
  });

  test('★★★ 代墊**不看**付款明細 —— 那是兩個來源，會對不起來', () => {
    const e = EXP({ advanceId: 'a1' });
    const pays = [{ expense_id: 'e1', paid_on: '2026-09-20', amount: 9999 }];
    assert.equal(paidOf(e, () => pays, () => 3102), 3102);
  });

  test('★ 收入不走這一套', () => {
    assert.equal(paidOf(EXP({ kind: 'income', amount: 8000 }), noPays, noAdv), 8000);
  });
});

describe('gapOf / isSettledExpense', () => {
  test('差距 ＝ 應支 − 實支', () => assert.equal(gapOf(5000, 3500), 1500));
  test('付清是 0', () => assert.equal(gapOf(5000, 5000), 0));
  test('★★ 付超過**不會變負數** —— 多付要退，不是「欠 −500」', () => {
    assert.equal(gapOf(5000, 5500), 0);
  });
  /* ★ 先各自收成整數再相減 —— 反過來會留下畫面上看不到的小數 */
  test('★ 一律整數台幣', () => {
    assert.equal(gapOf(3000.4, 1000.4), 2000);
    assert.equal(gapOf(3000.6, 1000.4), 2001);
  });
  test('付清了沒', () => {
    assert.equal(isSettledExpense(5000, 5000), true);
    assert.equal(isSettledExpense(5000, 4999), false);
    assert.equal(isSettledExpense(5000, 5500), true);
    assert.equal(isSettledExpense(0, 0), true);
  });
});

describe('★★ bookTotals —— 上面那張卡的支出是「實支」', () => {
  const rows: Entry[] = [
    EXP({ id: 'a', amount: 3102, advanceId: 'adv-a' }),
    EXP({ id: 'b', amount: 1428, advanceId: 'adv-b' }),
    EXP({ id: 'c', amount: 5000 }),
    { ...EXP({ id: 'd', amount: 8000 }), kind: 'income' },
  ];
  /* 代墊都還沒收回；自付那一筆付了 2,000 */
  const paid = (e: Entry) => paidOf(e,
    (id) => (id === 'c' ? [{ expense_id: 'c', paid_on: '2026-09-20', amount: 2000 }] : []),
    () => null);

  test('★★★ 支出 ＝ 實支總計，應支另外算', () => {
    const t = bookTotals(rows, paid);
    assert.equal(t.expense, 2000);            // 只有自付那 2,000 真的付了
    assert.equal(t.due, 3102 + 1428 + 5000);  // 應支 9,530
    assert.equal(t.income, 8000);
  });

  test('★ 淨額用實支 —— 那是真的離開過帳戶的錢', () => {
    assert.equal(bookTotals(rows, paid).net, 8000 - 2000);
  });

  test('★ 一筆都沒有時回 0，不是 NaN', () => {
    assert.deepEqual(bookTotals([], paid), { income: 0, expense: 0, due: 0, net: 0 });
  });
});

describe('★★★ validatePayment', () => {
  const ok = { paid_on: '2026-09-20', amount: 1000 };

  test('正常的回 null', () => assert.equal(validatePayment(EXP(), ok, 0), null));

  test('★★★ 代墊的不給在這裡記，而且要說得出去哪裡記', () => {
    const err = validatePayment(EXP({ advanceId: 'a1' }), ok, 0);
    assert.ok(err?.includes('暫付'), err ?? '');
    assert.ok(err?.includes('收回'), err ?? '');
  });

  test('沒填付款日', () => assert.equal(validatePayment(EXP(), { amount: 100 }, 0), '要填付款日'));

  test('金額要大於 0', () => {
    assert.equal(validatePayment(EXP(), { ...ok, amount: 0 }, 0), '金額要大於 0');
    assert.equal(validatePayment(EXP(), { ...ok, amount: -5 }, 0), '金額要大於 0');
  });

  test('★★ 只收整數 —— 存進去的跟看到的不可以是兩個數字', () => {
    assert.ok(validatePayment(EXP(), { ...ok, amount: 1.5 }, 0)?.includes('整數'));
    assert.equal(validatePayment(EXP(), { ...ok, amount: 1500 }, 0), null);
  });

  test('★★ 付超過**不擋** —— 系統負責看見，人負責決定', () => {
    assert.equal(validatePayment(EXP({ amount: 1000 }), { ...ok, amount: 9999 }, 0), null);
  });

  test('★ 一次只回一個錯', () => {
    const err = validatePayment(EXP(), { amount: -1 }, 0);
    assert.equal(err, '要填付款日');
    assert.ok(!err!.includes('\n'));
  });
});

describe('overpayWarning —— 提醒不是禁止', () => {
  test('沒超過不囉嗦', () => assert.equal(overpayWarning(5000, 3000, 2000), null));
  test('剛好付清也不囉嗦', () => assert.equal(overpayWarning(5000, 5000, 0), null));
  test('★ 超過要講出三個數字:記完變多少、應支多少、多了多少', () => {
    const m = overpayWarning(5000, 4000, 2000)!;
    assert.match(m, /6000/);
    assert.match(m, /5000/);
    assert.match(m, /1000/);
  });
});


/* ── 檢視抽屜的形狀 ────────────────────────────────────
   ★★★ 這一組在守的是「收入跟支出不是同一個形狀」。
   本來兩種都印支出的樣子:標題寫「這筆支出」、看板三格、
   底下掛著「＋ 記一筆實支」—— 而收入沒有應收 vs 實收的落差。 */

test('★★★ 收入:標題是「這筆收入」、看板只有一個金額', () => {
  const sh = drawerShape('income');
  assert.equal(sh.title, '這筆收入');
  assert.equal(sh.board, 'amount');
});

test('★★★ 收入沒有「實支明細」那一段', () => {
  assert.equal(drawerShape('income').payments, false);
});

test('★★★ 收入有刪除，支出沒有', () => {
  assert.equal(drawerShape('income').del, true);
  assert.equal(drawerShape('expense').del, false);
});

test('★★ 收款方式只有收入有 —— 支出沒有這個欄位', () => {
  assert.equal(drawerShape('income').payAccount, true);
  assert.equal(drawerShape('expense').payAccount, false);
});

test('★★★ 支出那一邊一個字都不准變（這次改動不該碰到它）', () => {
  assert.deepEqual(drawerShape('expense'), {
    title: '這筆支出',
    board: 'due-paid-gap',
    payAccount: false,
    payments: true,
    del: false,
  });
});

test('★ 兩種形狀不可以是同一個東西', () => {
  assert.notDeepEqual(drawerShape('income'), drawerShape('expense'));
});

/* ── 刪收入的問句 ─────────────────────────────────── */

test('★★ 問句要講得出刪的是哪一筆、多少錢', () => {
  const m = delIncomeMsg('團費收入', '50,634');
  assert.ok(m.includes('團費收入'), m);
  assert.ok(m.includes('50,634'), m);
});

test('★★★ 括號裡要寫實際後果 —— 這一筆進回收桶，所以是「可以復原」', () => {
  /* 走 soft_delete 卻寫「不可復原」，或真的 cascade 卻寫「可以復原」，
     那句話就不再有意義（anxing-ui 四-3）。 */
  const m = delIncomeMsg('X', '1');
  assert.ok(m.includes('回收桶'), m);
  assert.ok(/復原/.test(m), m);
  assert.ok(!m.includes('不可復原'), m);
});
