import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  submitMissing, planMissing, settleMissing, refundPerms, cancelPatch, needsAcct,
  type RefundDep,
} from './deposit-refund.ts';

/**
 * 這裡決定「誰在什麼狀態看得到哪顆按鈕」。
 * 判斷錯不會報錯 —— 只會讓某個人卡在某一步，而他只會說「按不到」。
 */

const ACC = { isAccountant: true, isManager: false, isAdmin: false };
const MGR = { isAccountant: false, isManager: true, isAdmin: false };
const ADM = { isAccountant: false, isManager: false, isAdmin: true };
const HK = { isAccountant: false, isManager: false, isAdmin: false };

const dep = (o: Partial<RefundDep> = {}): RefundDep => ({
  refund_status: 'none', received_on: '2026-06-29', returned_on: null,
  payee_name: '楊翠元', payee_account: '152540096231', returned_method: 'transfer',
  ...o,
});

describe('送審缺什麼', () => {
  test('★★ 預計匯款日與付款帳號**不算**送審必填', () => {
    /*
     * 那兩個移到「排匯款」（2026-08-22）。
     * 送審當下常常還不知道會從哪個戶頭出、哪天出 —— 以前是必填，
     * 所以大家隨便填一個再回來改，而改動會清掉核可票、退回重審。
     */
    assert.deepEqual(submitMissing(dep({ planned_refund_on: null, returned_account: null })), []);
  });

  test('房客帳戶與退款方式還是必填 —— 審核者要看的是「錢退給誰」', () => {
    assert.deepEqual(submitMissing(dep({ payee_account: '  ' })), ['房客收款帳號']);
    assert.deepEqual(submitMissing(dep({ returned_method: null })), ['安幸付款方式']);
  });

  test('缺很多就全部列出來，不是只講第一個', () => {
    const m = submitMissing(dep({ payee_name: '', payee_account: '', returned_method: '' }));
    assert.equal(m.length, 3);
  });
});

describe('排匯款與確認退款缺什麼', () => {
  test('★★ 匯款一定要有安幸付款帳號', () => {
    // 少了它，明年對元大帳戶時那筆匯出對不到任何單
    assert.deepEqual(planMissing(dep(), '2026-08-20', ''), ['安幸付款帳號']);
  });

  test('★ 現金不用帳號', () => {
    assert.equal(needsAcct('cash'), false);
    assert.deepEqual(planMissing(dep({ returned_method: 'cash' }), '2026-08-20', ''), []);
  });

  test('沒填日期要擋', () => {
    assert.deepEqual(planMissing(dep({ returned_method: 'cash' }), '', ''), ['預計匯款日']);
    assert.deepEqual(settleMissing(dep({ returned_method: 'cash' }), '', ''), ['實際退款日']);
  });

  test('★ 兩步的規則要一樣 —— 不一樣的話會有人卡在第二步', () => {
    const d = dep();
    assert.deepEqual(planMissing(d, '2026-08-20', ''), ['安幸付款帳號'].concat([]));
    assert.deepEqual(settleMissing(d, '2026-08-20', '').slice(-1), ['安幸付款帳號']);
  });
});

describe('誰能按哪一顆', () => {
  test('★★ 錢匯出去之後全部關閉', () => {
    /*
     * 紅線是 returned_on，不是 refund_status ——
     * 錢匯出去之後 refund_status 仍然是 'approved'
     * （那一欄記的是「審過了」，不是「還在等」）。
     */
    const p = refundPerms(dep({ refund_status: 'approved', returned_on: '2026-08-20' }), ACC);
    assert.equal(p.canSettle, false);
    assert.equal(p.canPlan, false);
    assert.equal(p.canCancel, false);
    assert.equal(p.canRequest, false);
  });

  test('★★ 沒收到錢就不能送退款', () => {
    // 沒收到的錢退不了
    assert.equal(refundPerms(dep({ received_on: null }), ACC).canRequest, false);
  });

  test('核可後才排匯款與確認退款', () => {
    assert.equal(refundPerms(dep({ refund_status: 'pending' }), ACC).canPlan, false);
    assert.equal(refundPerms(dep({ refund_status: 'approved' }), ACC).canPlan, true);
    assert.equal(refundPerms(dep({ refund_status: 'approved' }), ACC).canSettle, true);
  });

  test('★ 三種角色都推得動流程 —— 跟請款單的 canSetDate 一致', () => {
    for (const r of [ACC, MGR, ADM]) {
      assert.equal(refundPerms(dep({ refund_status: 'approved' }), r).canPlan, true, JSON.stringify(r));
    }
    assert.equal(refundPerms(dep({ refund_status: 'approved' }), HK).canPlan, false);
  });

  test('投票:各投各的，投過就不再出現', () => {
    const d = dep({ refund_status: 'pending' });
    assert.equal(refundPerms(d, MGR).canVoteMgr, true);
    assert.equal(refundPerms(d, ADM).canVoteAdm, true);
    assert.equal(refundPerms({ ...d, manager_approved_at: 'x' }, MGR).canVoteMgr, false);
    // 主管不能投總經理那一票
    assert.equal(refundPerms(d, MGR).canVoteAdm, false);
  });

  test('★ 撤銷:送審中與已核可都能撤，未送審的沒東西可撤', () => {
    assert.equal(refundPerms(dep({ refund_status: 'pending' }), ACC).canCancel, true);
    assert.equal(refundPerms(dep({ refund_status: 'approved' }), ACC).canCancel, true);
    assert.equal(refundPerms(dep({ refund_status: 'none' }), ACC).canCancel, false);
    assert.equal(refundPerms(dep({ refund_status: 'rejected' }), ACC).canCancel, false);
  });

  test('管家什麼都不能按', () => {
    const p = refundPerms(dep({ refund_status: 'approved' }), HK);
    assert.deepEqual(
      [p.canRequest, p.canPlan, p.canSettle, p.canCancel, p.canReject],
      [false, false, false, false, false]);
  });
});

describe('撤銷要清掉什麼', () => {
  test('★★ 兩票一定要清', () => {
    /*
     * 留著的話下次重新送審會**帶著舊的兩票**進來 ——
     * 看起來已經核可，而根本沒有人重新看過。
     */
    const p = cancelPatch();
    assert.equal(p.manager_approved_at, null);
    assert.equal(p.admin_approved_at, null);
    assert.equal(p.manager_approved_by, null);
    assert.equal(p.admin_approved_by, null);
  });

  test('★ 核可金額也要清 —— 留著的話下次送審前那個數字是上一輪的', () => {
    assert.equal(cancelPatch().refund_amount, null);
  });

  test('★★ 房客帳戶與退款方式不在清單裡 —— 那是查得到的事實', () => {
    // 清掉只是讓人重打一次。房客的帳號不會因為我們撤銷申請就變了。
    const keys = Object.keys(cancelPatch());
    for (const k of ['payee_name', 'payee_account', 'payee_bank_code', 'returned_method']) {
      assert.equal(keys.includes(k), false, `不該清 ${k}`);
    }
  });

  test('狀態回到未送審', () => {
    assert.equal(cancelPatch().refund_status, 'none');
  });
});
