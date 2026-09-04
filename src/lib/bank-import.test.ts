import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  planImport, matchAccount, totalBalance,
  type ExistingTxn, type AccountLike,
} from './bank-import.ts';
import type { Statement, Txn } from './bank-statement.ts';

/**
 * 匯入判斷的測試。
 *
 * 這裡的每一條錯了都**不會報錯**:
 *   · 去重太寬 → 重傳同一份變兩倍流水,而每一筆的餘額欄看起來都對
 *   · 去重太嚴 → 新的幾筆被當成重複跳過,靜靜地少
 *   · 帳戶對錯 → 整份記到別的帳上,要對帳時才發現
 */

const txn = (o: Partial<Txn> = {}): Txn => ({
  page: 1, seq: 1, txnDate: '2025-01-01', postDate: '2025-01-02', txnTime: '01:06:44',
  description: 'ＡＴＭ轉', counterparty: '台北富邦',
  debit: 0, credit: 17_836, balance: 45_943, bankBalance: 45_943, balanceNote: null,
  memo: '', refNo: '', ...o,
});

// ── 去重 ──────────────────────────────────────────

describe('去重', () => {
  test('資料庫是空的 → 全部都是新的', () => {
    const p = planImport('a', [txn({ seq: 1 }), txn({ seq: 2, bankBalance: 82_153 })], []);
    assert.equal(p.fresh.length, 2);
    assert.equal(p.duplicate.length, 0);
  });

  test('★★ 同一份重傳 → 全部算重複', () => {
    const rows = [txn({ seq: 1 }), txn({ seq: 2, bankBalance: 82_153, txnTime: '09:00:00' })];
    const have: ExistingTxn[] = rows.map((t) => ({
      post_date: t.postDate, bank_balance: t.bankBalance, txn_time: t.txnTime,
    }));
    const p = planImport('a', rows, have);
    assert.equal(p.fresh.length, 0);
    assert.equal(p.duplicate.length, 2);
  });

  test('★★ 序號變了但內容相同,仍算重複', () => {
    // 換一個查詢期間,同一筆交易的序號會不一樣 ——
    // 拿序號當鑰匙的話這裡會重複匯入
    const have: ExistingTxn[] = [{ post_date: '2025-01-02', bank_balance: 45_943, txn_time: '01:06:44' }];
    const p = planImport('a', [txn({ seq: 88 })], have);
    assert.equal(p.duplicate.length, 1);
    assert.equal(p.fresh.length, 0);
  });

  test('★★ 資料庫回來的時間帶時區也要對得起來', () => {
    // `13:07:00+08` vs `13:07:00` —— 不切齊的話每一筆都會被當成新的,
    // 而症狀是「每次上傳都說全部是新的」,流水一路長
    const have: ExistingTxn[] = [
      { post_date: '2025-01-02T00:00:00', bank_balance: '45943.00', txn_time: '01:06:44+08' },
    ];
    const p = planImport('a', [txn()], have);
    assert.equal(p.duplicate.length, 1, '時區或型別沒切齊');
  });

  test('★★ 沒印時間的兩筆,null 要收斂成 00:00:00', () => {
    const have: ExistingTxn[] = [{ post_date: '2025-01-02', bank_balance: 45_943, txn_time: null }];
    const p = planImport('a', [txn({ txnTime: null })], have);
    assert.equal(p.duplicate.length, 1);
  });

  test('★ 同日同額但餘額不同 → 是兩筆不同的交易', () => {
    // 同一天收兩筆一樣的房租(都 46,000),金額會撞,餘額不會
    const have: ExistingTxn[] = [{ post_date: '2025-03-01', bank_balance: 46_000, txn_time: '10:00:00' }];
    const p = planImport('a', [
      txn({ postDate: '2025-03-01', bankBalance: 46_000, credit: 46_000, txnTime: '10:00:00' }),
      txn({ postDate: '2025-03-01', bankBalance: 92_000, credit: 46_000, txnTime: '11:00:00' }),
    ], have);
    assert.equal(p.duplicate.length, 1);
    assert.equal(p.fresh.length, 1);
    assert.equal(p.fresh[0].bankBalance, 92_000);
  });

  test('★ 換一個帳戶,同樣的流水算新的', () => {
    const have: ExistingTxn[] = [{ post_date: '2025-01-02', bank_balance: 45_943, txn_time: '01:06:44' }];
    const p = planImport('別的帳戶', [txn()], []);
    assert.equal(p.fresh.length, 1);
    // 上面那個 have 是給 'a' 的,換帳戶就不該比對到
    assert.equal(planImport('a', [txn()], have).duplicate.length, 1);
  });

  test('★ 同一份 PDF 裡自己撞在一起要分開報', () => {
    // 正常不該發生。發生了代表解析把同一列讀了兩次 ——
    // 併進 duplicate 的話會被當成「資料庫已經有了」而查不出來
    const p = planImport('a', [txn(), txn({ seq: 2 })], []);
    assert.equal(p.fresh.length, 1);
    assert.equal(p.selfDuplicate.length, 1);
    assert.equal(p.duplicate.length, 0);
  });
});

// ── 帳戶比對 ──────────────────────────────────────

const ACC: AccountLike[] = [
  { id: '1', name: '元大 70564', account_no: '20992000170564', account_no_tail: '70564' },
  { id: '2', name: '元大 24145', account_no: '21762000024145', account_no_tail: '24145' },
  { id: '3', name: '元大 48088', account_no: '20992000148088', account_no_tail: '48088' },
];
const st = (accountNo: string | null): Statement => ({
  accountNo, branch: '元大中崙', periodFrom: '2025-01-01', periodTo: '2025-06-30',
  totalDebit: 0, totalCredit: 0, sawHeader: true, txns: [],
});

describe('帳戶比對', () => {
  test('★ 三個帳號各自對到自己', () => {
    for (const a of ACC) {
      const r = matchAccount(st(a.account_no!), ACC);
      assert.equal(r.ok, true);
      assert.equal(r.ok && r.account.id, a.id);
    }
  });

  test('★★ 沒登記的帳號要停,而且要把帳號印出來', () => {
    const r = matchAccount(st('99998888777666'), ACC);
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.reason, 'not_registered');
    // 只說「查無此帳戶」的話,人分不出是傳錯檔還是帳戶沒建
    assert.match(!r.ok ? r.message : '', /99998888777666/);
  });

  test('★★ 有完整帳號卻對不上,不可以再用末五碼救', () => {
    // 24145 是 21762 開頭、另外兩個是 20992 —— 末五碼能對上但那是巧合。
    // 退路只給「還沒填完整帳號」的帳戶用。
    const r = matchAccount(st('11111111170564'), ACC);
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.reason, 'not_registered');
  });

  test('沒填完整帳號的帳戶,才用末五碼', () => {
    const partial: AccountLike[] = [{ id: '9', name: '新帳戶', account_no: null, account_no_tail: '12345' }];
    assert.equal(matchAccount(st('99900000012345'), partial).ok, true);
    assert.equal(matchAccount(st('99900000054321'), partial).ok, false);
  });

  test('★ 解析不出帳號要停', () => {
    const r = matchAccount(st(null), ACC);
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.reason, 'no_account_no');
  });

  test('★★ 對到兩個帳戶要停,不要挑一個', () => {
    // 少匯一份看得到、補得回來；記到錯的帳上沒有人會發現
    const dup: AccountLike[] = [
      { id: 'a', name: 'A', account_no: null, account_no_tail: '70564' },
      { id: 'b', name: 'B', account_no: null, account_no_tail: '70564' },
    ];
    const r = matchAccount(st('20992000170564'), dup);
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.reason, 'ambiguous');
  });

  test('帶分隔號的帳號也要對得上', () => {
    assert.equal(matchAccount(st('2099-2000-170564'), ACC).ok, true);
  });
});

// ── 合計 ──────────────────────────────────────────

describe('三張卡片的合計', () => {
  test('★ 三份都對齊 → 一個日期,沒有落後的', () => {
    const r = totalBalance([
      { name: '70564', balance: 81_977, asOf: '2025-06-30' },
      { name: '24145', balance: 6_590, asOf: '2025-06-30' },
      { name: '48088', balance: 262_433, asOf: '2025-06-30' },
    ]);
    assert.equal(r.total, 351_000);
    assert.equal(r.asOf, '2025-06-30');
    assert.deepEqual(r.stale, []);
    assert.deepEqual(r.missing, []);
  });

  test('★★ 截止日不一致 → asOf 取最舊的,並點名落後的', () => {
    // 取最新的話,那個合計看起來像「現在的現金」而其實不是
    const r = totalBalance([
      { name: '70564', balance: 81_977, asOf: '2025-12-31' },
      { name: '24145', balance: 6_590, asOf: '2025-03-31' },
      { name: '48088', balance: 262_433, asOf: '2025-12-31' },
    ]);
    assert.equal(r.asOf, '2025-03-31');
    assert.equal(r.newestAsOf, '2025-12-31');
    assert.deepEqual(r.stale, ['24145']);
  });

  /*
   * ══════════════════════════════════════════════════════════
   * ★★★ 現金帳戶:有餘額但沒有對帳單（migration_184）
   *
   *   原本的判斷是「balance 有值 **且** asOf 有值」才計入 ——
   *   現金帳戶永遠沒有 asOf,所以會掉進 missing:
   *     · 錢不算進總額
   *     · 而且被指名「⚠ 現金 沒有對帳單，未計入」
   *   而它是**永遠不會有對帳單的**,那句話會一直掛在那裡。
   * ══════════════════════════════════════════════════════════
   */
  describe('★★★ 現金帳戶（dated: false）', () => {
    test('計入總額', () => {
      const r = totalBalance([
        { name: '70564', balance: 81_977, asOf: '2025-06-30' },
        { name: '現金', balance: 23_500, asOf: null, dated: false },
      ]);
      assert.equal(r.total, 105_477);
    });

    test('★ 不會被報成「沒有對帳單，未計入」', () => {
      const r = totalBalance([
        { name: '70564', balance: 81_977, asOf: '2025-06-30' },
        { name: '現金', balance: 23_500, asOf: null, dated: false },
      ]);
      assert.deepEqual(r.missing, []);
    });

    test('★★ 不影響日期區間 —— 標題不會因為現金而變成「區間」', () => {
      const r = totalBalance([
        { name: '70564', balance: 81_977, asOf: '2025-06-30' },
        { name: '24145', balance: 6_590, asOf: '2025-06-30' },
        { name: '現金', balance: 23_500, asOf: null, dated: false },
      ]);
      assert.equal(r.asOf, '2025-06-30');
      assert.equal(r.newestAsOf, '2025-06-30');
      assert.deepEqual(r.stale, []);
    });

    test('★ 也不會被列進 stale', () => {
      const r = totalBalance([
        { name: '70564', balance: 81_977, asOf: '2025-12-31' },
        { name: '24145', balance: 6_590, asOf: '2025-03-31' },
        { name: '現金', balance: 23_500, asOf: null, dated: false },
      ]);
      assert.deepEqual(r.stale, ['24145']);
    });

    test('餘額 0 的現金帳戶還是要計入，不是 missing', () => {
      // 0 是「花光了」,不是「不知道」—— 這兩件事不可以長得一樣
      const r = totalBalance([
        { name: '70564', balance: 81_977, asOf: '2025-06-30' },
        { name: '現金', balance: 0, asOf: null, dated: false },
      ]);
      assert.equal(r.total, 81_977);
      assert.deepEqual(r.missing, []);
    });

    test('★ 只有現金一個帳戶時，總額照給但日期是 null', () => {
      const r = totalBalance([{ name: '現金', balance: 23_500, asOf: null, dated: false }]);
      assert.equal(r.total, 23_500);
      assert.equal(r.asOf, null);
      assert.equal(r.newestAsOf, null);
      assert.deepEqual(r.missing, []);
    });

    test('★★ 銀行帳戶沒給 dated 時行為完全不變（回頭相容）', () => {
      const r = totalBalance([
        { name: '08311', balance: null, asOf: null },
        { name: '70564', balance: 81_977, asOf: '2025-06-30' },
      ]);
      assert.equal(r.total, 81_977);
      assert.deepEqual(r.missing, ['08311']);
    });
  });

  /*
   * ★★★ 只更新其中一個帳戶（2026-08-29 使用者問「對帳單日期會怎麼寫？」）。
   *
   *   剛傳完 24145 的新對帳單,另外兩個還停在舊的日期。
   *   這時候標題列**不能只印一個日期**:
   *     · 印最新的 → 合計看起來像現在的現金,而其中兩個是三個月前的
   *     · 印最舊的 → 剛上傳的人會以為自己白傳了
   *   所以兩個都要拿得到,畫面才寫得出「08/25 ~ 12/31 未對齊」。
   */
  test('★★★ 只更新一個帳戶 → 落後的是「另外兩個」,而且兩個日期都要拿得到', () => {
    const r = totalBalance([
      { name: '70564', balance: 81_977, asOf: '2025-09-30' },
      { name: '24145', balance: 6_590, asOf: '2025-12-31' },
      { name: '48088', balance: 262_433, asOf: '2025-09-30' },
    ]);
    assert.equal(r.asOf, '2025-09-30');
    assert.equal(r.newestAsOf, '2025-12-31');
    assert.deepEqual(r.stale, ['70564', '48088']);
  });

  test('★ 三份對齊時 newestAsOf 等於 asOf —— 畫面才知道不用印區間', () => {
    const r = totalBalance([
      { name: 'a', balance: 1, asOf: '2025-06-30' },
      { name: 'b', balance: 2, asOf: '2025-06-30' },
    ]);
    assert.equal(r.asOf, r.newestAsOf);
  });

  test('★★ 還沒上傳的帳戶不算進合計,但要點名', () => {
    // 悄悄當成 0 的話,合計會少一整個帳戶而看起來很正常
    const r = totalBalance([
      { name: '70564', balance: 81_977, asOf: '2025-06-30' },
      { name: '24145', balance: null, asOf: null },
    ]);
    assert.equal(r.total, 81_977);
    assert.deepEqual(r.missing, ['24145']);
  });

  test('一份都沒有 → 合計 0 且沒有日期', () => {
    const r = totalBalance([{ name: 'x', balance: null, asOf: null }]);
    assert.equal(r.total, 0);
    assert.equal(r.asOf, null);
    assert.equal(r.newestAsOf, null);
    assert.deepEqual(r.missing, ['x']);
  });
});
