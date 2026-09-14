import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  ymOf, ymLabel, prevYm, prevYmOf, lockable, isLocked, lockedMsg, lockYmOf,
  autoCloseDecision, ymOptions, closeConfirm, reopenConfirm, pendingLines,
  nextYm, nextCloseYm,
  CLOSE_DAY, type OrderLike,
} from './period-lock.ts';

/*
 * ★ `checkin` 也要有預設。月租單算的是**期別起日**（migration_251），
 *   少了它每一筆月租單都判不出月份 —— 而「判不出就不鎖」會讓測試
 *   一片綠地通過一個什麼都不鎖的實作。
 */
const O = (o: Partial<OrderLike> = {}): OrderLike =>
  ({ checkin: '2026-08-01', checkout: '2026-08-20', imported_via: 'airbnb', ...o });

describe('ym 換算（2026-09-07）', () => {
  test('日期轉六碼', () => {
    assert.equal(ymOf('2026-08-20'), '202608');
    assert.equal(ymOf('2026-08-20T00:00:00Z'), '202608');
  });

  test('空的或格式不對回空字串，不要回半截', () => {
    for (const x of ['', null, undefined, '2026-08', 'abc']) {
      assert.equal(ymOf(x as string), '');
    }
  });

  // ★ 跨年 —— 這種地方寫錯了要一年後才發現
  test('★ 上個月跨年', () => {
    assert.equal(prevYm('202601'), '202512');
    assert.equal(prevYm('202612'), '202611');
  });

  test('★ 1 月 5 號關的是去年 12 月', () => {
    assert.equal(prevYmOf('2027-01-05'), '202612');
  });

  // ★ 跨年 —— 12 月的帳是隔年 1/5 關
  test('★ 下個月跨年', () => {
    assert.equal(nextYm('202612'), '202701');
    assert.equal(nextYm('202608'), '202609');
  });

  test('★ 八月的帳九月關、十二月的帳隔年一月關', () => {
    assert.equal(nextCloseYm('202608'), '202609');
    assert.equal(nextCloseYm('202612'), '202701');
  });

  test('顯示格式', () => {
    assert.equal(ymLabel('202608'), '2026-08');
    assert.equal(ymLabel(''), '—');
  });
});

describe('哪些訂單鎖得到', () => {
  /*
   * ★★★ 月租單**也要鎖**（2026-09-14 使用者:「已關帳的不可以去改了，所有都不行」）。
   *
   *   這一條原本是相反的（2026-09-07 選的「月租單永遠不鎖」）。
   *   代價是 2026-08 關帳之後，LT_3A3_202608 被收款、取消、再取消 ——
   *   **三次都成功，而且沒有任何提示**。
   *
   * ★ 原本那個顧慮（鎖了會害「改契約」在舊月份上失敗）改在資料庫解決:
   *   `orders_period_lock_guard()` 用 pg_trigger_depth() 分辨
   *   「人直接改」與「產生器重算」，後者不寫但記進 order_lock_pending。
   */
  test('★★★ 契約月租單一樣鎖得到（migration_249 改掉了舊行為）', () => {
    assert.equal(lockable(O({ imported_via: 'contract' })), true);
    assert.equal(isLocked(O({ imported_via: 'contract' }), ['202608']), true);
    assert.match(
      lockedMsg(O({ imported_via: 'contract' }), ['202608']) ?? '',
      /已經關帳/,
      '要講得出被擋的理由');
    // ★ 開帳權限只剩會計 —— 訊息要說得出去找誰
    assert.match(
      lockedMsg(O({ imported_via: 'contract' }), ['202608']) ?? '',
      /會計/);
  });

  test('★ 沒關帳的月份照樣改得動 —— 別把所有月租單都鎖死', () => {
    assert.equal(isLocked(O({ imported_via: 'contract' }), ['202607']), false);
  });

  /*
   * ══════════════════════════════════════════════════════════
   * ★★★ 月租單算哪個月：**期別起日**，不是退房日（migration_251）
   *
   *   2026-09-14 使用者關了 2026-08，畫面上八月那一期還是能改：「沒鎖阿」。
   *   原因是守衛算的是退房日 ——
   *
   *       第 1 期　2026/8/25 ~ 2026/9/24
   *       order_key　LT_3A3_202608   ← 單號說它是八月的
   *       checkin　　2026-08-25
   *       checkout 　2026-09-25      ← 但退房日在九月
   *
   *   → 算成 202609，而關的是 202608，所以一路放行。
   * ══════════════════════════════════════════════════════════
   */
  test('★★★ 跨月的月租單歸在「期別起日」那個月', () => {
    const span = { imported_via: 'contract', checkin: '2026-08-25', checkout: '2026-09-25' };
    assert.equal(lockYmOf(span), '202608', '單號是 LT_..._202608，就該算八月');
    assert.equal(isLocked(span, ['202608']), true, '關了八月就要鎖住');
    assert.equal(isLocked(span, ['202609']), false, '關九月不影響這一期');
    assert.match(lockedMsg(span, ['202608']) ?? '', /2026-08/, '訊息要講對月份');
  });

  test('★ 短租照舊看退房日 —— 住完才算收入', () => {
    const stay = { imported_via: 'manual', checkin: '2026-08-30', checkout: '2026-09-02' };
    assert.equal(lockYmOf(stay), '202609');
    assert.equal(isLocked(stay, ['202608']), false, '八月關帳不該鎖到九月退房的短租');
    assert.equal(isLocked(stay, ['202609']), true);
  });

  test('★ 沒有期別起日的月租單不鎖 —— 判不出月份就不要用猜的', () => {
    assert.equal(lockable({ imported_via: 'contract', checkout: '2026-09-25' }), false);
  });

  test('短租訂單鎖得到', () => {
    assert.equal(lockable(O()), true);
    assert.equal(isLocked(O(), ['202608']), true);
  });

  // ★ 沒有退房日就判不出月份 —— 放行，不要用猜的鎖人
  test('★ 沒有退房日不鎖', () => {
    assert.equal(lockable(O({ checkout: null })), false);
    assert.equal(isLocked(O({ checkout: null }), ['202608']), false);
  });

  test('那個月沒關就不鎖', () => {
    assert.equal(isLocked(O(), ['202607']), false);
    assert.equal(isLocked(O(), []), false);
  });

  /*
   * ★★ 使用者的原始例子:9/5 關八月的帳。
   *   8 月退房的鎖住；9 月退房的（含 9/5、9/6）都不鎖 ——
   *   它們等 10/5 關九月的帳。
   */
  test('★★ 使用者的例子:關八月只鎖八月退房的', () => {
    const locked = ['202608'];
    assert.equal(isLocked(O({ checkout: '2026-08-31' }), locked), true);
    assert.equal(isLocked(O({ checkout: '2026-09-05' }), locked), false);
    assert.equal(isLocked(O({ checkout: '2026-09-06' }), locked), false);
  });

  test('九月關帳之後 9/6 那張才鎖', () => {
    assert.equal(isLocked(O({ checkout: '2026-09-06' }), ['202608', '202609']), true);
  });
});

describe('擋阻訊息', () => {
  test('可以改的回 null', () => {
    assert.equal(lockedMsg(O(), ['202607']), null);
  });

  // ★ 要講哪個月、也要講去哪裡開 —— 只說「已關帳」等於沒說下一步
  test('★ 訊息要有月份與怎麼解決', () => {
    const m = lockedMsg(O(), ['202608'])!;
    assert.match(m, /2026-08/);
    assert.match(m, /權限管理/);
  });
});

describe('排程該不該關（跟 close_due_periods 同一套）', () => {
  test(`★ ${CLOSE_DAY} 號之前不關`, () => {
    const d = autoCloseDecision('2026-09-04', []);
    assert.equal(d.close, false);
    assert.equal(d.ym, '202608');
  });

  test('5 號當天就關', () => {
    const d = autoCloseDecision('2026-09-05', []);
    assert.equal(d.close, true);
    assert.equal(d.ym, '202608');
  });

  test('★ 漏跑一天，隔天照樣補關（冪等）', () => {
    assert.equal(autoCloseDecision('2026-09-19', []).close, true);
  });

  test('已經關過就不再關', () => {
    const d = autoCloseDecision('2026-09-10', [{ ym: '202608', locked: true }]);
    assert.equal(d.close, false);
    assert.match(d.why, /已經關過/);
  });

  /*
   * ★★★ 被人手動打開過的**不自動關回去**。
   *   不然會計打開七月正在改，隔天清晨又被鎖起來 ——
   *   而他不會知道是排程做的，只會覺得系統壞了。
   */
  test('★★★ 手動打開過的不自動關回去', () => {
    const d = autoCloseDecision('2026-09-10',
      [{ ym: '202608', locked: false, reopened_at: '2026-09-08T10:00:00Z' }]);
    assert.equal(d.close, false);
    assert.match(d.why, /手動打開/);
  });

  // ★ 有列但沒被打開過（例如關失敗留下的半截）→ 還是要關
  test('★ 有列但沒有 reopened_at 就照關', () => {
    assert.equal(autoCloseDecision('2026-09-10', [{ ym: '202608', locked: false }]).close, true);
  });

  test('跨年:1 月 5 號關去年 12 月', () => {
    const d = autoCloseDecision('2027-01-05', []);
    assert.equal(d.ym, '202612');
    assert.equal(d.close, true);
  });
});

describe('月份清單', () => {
  // ★ 要含這個月 —— 提早結完想馬上鎖起來的話才有入口
  test('★ 第一個是這個月，不是上個月', () => {
    assert.equal(ymOptions('2026-09-07', 3)[0], '202609');
  });

  test('由新到舊、跨年正確', () => {
    assert.deepEqual(ymOptions('2026-01-15', 2), ['202601', '202512', '202511']);
  });
});

describe('確認訊息', () => {
  // ★ 要講「隨時可以再打開」—— 不講的話使用者不敢按
  test('★ 關帳的確認要說不是永久的', () => {
    const m = closeConfirm('202608', 31);
    assert.match(m, /2026-08/);
    assert.match(m, /31 張/);
    assert.match(m, /可以再打開/);
    assert.match(m, /月租單/);
  });

  // ★★ 打開的代價:數字可能已經報過稅或給過老闆
  test('★★ 打開的確認要講代價，也要提醒關回去', () => {
    const m = reopenConfirm('202608', 31);
    assert.match(m, /對不起來/);
    assert.match(m, /關回去/);
  });
});

describe('同步被擋下來的差異怎麼講', () => {
  test('欄位名翻成中文', () => {
    assert.deepEqual(pendingLines({ amount: [9600, 9120] }), ['金額　9600 → 9120']);
  });

  test('多個欄位', () => {
    const l = pendingLines({ amount: [9600, 9120], checkout: ['2026-08-20', '2026-08-19'] });
    assert.equal(l.length, 2);
    assert.match(l[1], /退房/);
  });

  // ★ 空值要印「（空）」，不然那一行看起來像資料掉了
  test('★ 空值印（空）不是空白', () => {
    assert.match(pendingLines({ guest_name: [null, 'Kevin'] })[0], /（空）/);
  });

  test('刪除單獨講', () => {
    assert.match(pendingLines({ _刪除: { id: 'x' } })[0], /刪掉/);
  });

  test('不認得的欄位用原名，不要漏掉', () => {
    assert.match(pendingLines({ weird_col: [1, 2] })[0], /weird_col/);
  });

  test('空的不會爆', () => {
    assert.deepEqual(pendingLines({}), []);
  });
});
