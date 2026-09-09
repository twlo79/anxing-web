import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PAY_LABEL, PAY_OPTS, needsPayout, needsPayeeAccount, needsPlan,
  hasTransferFee, dateWord, acctWord, payLabel, accountMethodsFor, payAccountsFor,
} from './purchase-pay.ts';

/**
 * 加新的付款方式時，最危險的不是「新的不能用」，
 * 是**舊的判斷式漏掉它**：那張單只會安靜地不出現在待排付款清單裡。
 * 所以每一支述詞都把五種方式全列一次。
 */

test('五種方式都有標籤，而且下拉選得到', () => {
  assert.deepEqual(PAY_OPTS, ['cash', 'transfer', 'credit_card', 'counter', 'autopay']);
  for (const m of PAY_OPTS) assert.ok(PAY_LABEL[m], m);
  assert.equal(PAY_LABEL.counter, '臨櫃');
  assert.equal(PAY_LABEL.autopay, '自動繳款');
});

test('★ 需要安幸付款帳號：五種全部都要（現金 2026-09-09 加入）', () => {
  /*
   * 現金原本是 false —— 那在 migration_225 之前是對的:
   * 全公司只有一個現金水位，不用挑。
   *
   * 225 把現金拆成正隆／安幸兩本之後，「這筆從哪一本出去」
   * 變成一個有答案而且必須記下來的問題 —— 不記的話兩本的餘額
   * 永遠算不出來，而畫面上只會看到一個總數。
   *
   * ★ 「要指定」不等於「必填」—— 存檔那邊照舊是 `edit.pay_account || null`。
   */
  for (const m of ['cash', 'transfer', 'credit_card', 'counter', 'autopay']) {
    assert.equal(needsPayout(m), true, m);
  }
  assert.equal(needsPayout(null), false);
  assert.equal(needsPayout(''), false);
});

test('★★ 廠商收款帳號只有匯款必填 —— 臨櫃與自動繳款沒有匯款對象', () => {
  assert.equal(needsPayeeAccount('transfer'), true);
  assert.equal(needsPayeeAccount('counter'), false);
  assert.equal(needsPayeeAccount('autopay'), false);
  assert.equal(needsPayeeAccount('cash'), false);
  assert.equal(needsPayeeAccount('credit_card'), false);
});

test('★ 要先排付款：現金以外全部都要', () => {
  assert.equal(needsPlan('cash'), false);
  for (const m of ['transfer', 'credit_card', 'counter', 'autopay']) {
    assert.equal(needsPlan(m), true, m);
  }
});

test('沒選付款方式時不算「要排付款」—— 空的單不該擠進待排清單', () => {
  assert.equal(needsPlan(null), false);
  assert.equal(needsPlan(undefined), false);
  assert.equal(needsPlan(''), false);
});

test('★ 手續費維持只有匯款 —— 這次沒有跟著放寬', () => {
  assert.equal(hasTransferFee('transfer'), true);
  assert.equal(hasTransferFee('counter'), false);
  assert.equal(hasTransferFee('autopay'), false);
});

test('用詞：只有信用卡講「刷卡」', () => {
  assert.equal(dateWord('credit_card'), '刷卡日');
  assert.equal(acctWord('credit_card'), '刷卡卡片');
  for (const m of ['transfer', 'counter', 'autopay', 'cash']) {
    assert.equal(dateWord(m), '付款日', m);
    assert.equal(acctWord(m), '安幸付款帳號', m);
  }
});

test('payLabel：認不出來回原始值，不要變空白', () => {
  assert.equal(payLabel('counter'), '臨櫃');
  assert.equal(payLabel('mystery'), 'mystery');
  assert.equal(payLabel(null), '—');
  assert.equal(payLabel(''), '—');
});

test('★★★ 要排付款的一定要挑得到帳號 —— 反過來不必', () => {
  /*
   * 這條原本寫成雙向相等（needsPayout === needsPlan）。
   * 2026-09-09 現金也要挑帳號之後就不再相等了 —— 但**沒有壞掉**:
   *
   *   壞的方向是 needsPlan 而 !needsPayout
   *     → 「排得進待付款卻沒有帳號可填」，流程卡住
   *   現在的方向是 needsPayout 而 !needsPlan
   *     → 現金要記從哪一本出，但不用排付款。付了就是付了
   *
   * ★ 所以正確的不變量是**單向蘊含**，不是相等。
   *   寫成相等的話，這種正常的放寬會讓測試變紅而不是讓 bug 變紅。
   */
  for (const m of PAY_OPTS) {
    if (needsPlan(m)) assert.ok(needsPayout(m), `${m} 要排付款卻挑不到帳號`);
  }
  assert.equal(needsPlan('cash'), false);
  assert.equal(needsPayout('cash'), true);
});

/*
 * ── 付款方式 → 可選帳號（2026-08-25，2026-09-09 加現金）─────────
 *
 * payment_accounts 原本只有 transfer / credit_card 兩種 method，
 * 直接拿 payment_method 去比的話，臨櫃與自動繳款會篩出空清單 ——
 * 下拉打開只有「請選擇」，畫面上不會說為什麼。
 *
 * migration_231 之後多了 cash 兩列（正隆／安幸兩本現金）。
 */
const ACCTS = [
  { code: 'A48088', method: 'transfer' },
  { code: 'A70564', method: 'transfer' },
  { code: 'CARD1', method: 'credit_card' },
  { code: '正隆現金', method: 'cash' },
  { code: '安幸現金', method: 'cash' },
];

test('匯款與自動繳款：只有銀行帳戶', () => {
  for (const m of ['transfer', 'autopay']) {
    assert.deepEqual(payAccountsFor(ACCTS, m).map((a) => a.code), ['A48088', 'A70564'], m);
  }
});

test('★★★ 臨櫃：銀行帳戶 ＋ 兩本現金（2026-09-09 使用者指定）', () => {
  /*
   * 臨櫃是「拿錢去銀行櫃檯繳」—— 那筆錢可能是從帳戶領的，
   * 也可能是手上的現金。兩類都要選得到。
   */
  assert.deepEqual(payAccountsFor(ACCTS, 'counter').map((a) => a.code),
    ['A48088', 'A70564', '正隆現金', '安幸現金']);
});

test('★★★ 現金：只有兩本現金，不該看到任何銀行帳戶', () => {
  /*
   * 看得到銀行帳戶的話，一筆現金支出會被記到元大 48088 上，
   * 而對帳時那個帳戶會多出一筆銀行對帳單上沒有的錢。
   */
  assert.deepEqual(payAccountsFor(ACCTS, 'cash').map((a) => a.code),
    ['正隆現金', '安幸現金']);
});

test('信用卡只挑卡片，不該看到銀行帳戶或現金', () => {
  assert.deepEqual(payAccountsFor(ACCTS, 'credit_card').map((a) => a.code), ['CARD1']);
});

test('沒選付款方式時回空陣列', () => {
  assert.deepEqual(payAccountsFor(ACCTS, null), []);
  assert.deepEqual(payAccountsFor(ACCTS, undefined), []);
});

test('accountMethodsFor：每一種方式對到哪幾類帳號', () => {
  assert.deepEqual(accountMethodsFor('credit_card'), ['credit_card']);
  assert.deepEqual(accountMethodsFor('cash'), ['cash']);
  assert.deepEqual(accountMethodsFor('counter'), ['transfer', 'cash']);
  for (const m of ['transfer', 'autopay']) {
    assert.deepEqual(accountMethodsFor(m), ['transfer'], m);
  }
});

test('帳號清單是 null / 空的時候不炸', () => {
  assert.deepEqual(payAccountsFor(null, 'counter'), []);
  assert.deepEqual(payAccountsFor([], 'counter'), []);
});

test('★★ needsPayout 為真的每一種都挑得到帳號 —— 不然是選得到卻填不了', () => {
  for (const m of PAY_OPTS) {
    if (needsPayout(m)) assert.ok(payAccountsFor(ACCTS, m).length > 0, m);
  }
});
