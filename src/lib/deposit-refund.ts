/**
 * 押金退款的流程階段。**比照請款單的三段式**（2026-08-22 使用者指定）。
 *
 * ============================================================
 * 【為什麼要對齊】
 *
 * 兩種單在「請款審核」是**同一份清單**——核可的人不在意那筆錢
 * 是採購還是退押金，他只想知道「有什麼等我」。
 *
 * 但兩邊的按鈕以前不一樣:請款單有「排匯款／確認付款日／撤銷」，
 * 押金一個都沒有。結果會計核完押金之後得**換一頁**才按得到確認退款，
 * 而請款單就在同一頁按完了 —— 同一個動作兩種走法，
 * 每次都要先想一下「這筆是哪一種」。
 *
 *
 * ============================================================
 * 【三段式】
 *
 *     送審      房客收款帳戶 ＋ 退款方式          審核者要看的是「錢退給誰」
 *      ↓
 *     核可      主管 ＋ 總經理兩票
 *      ↓
 *     排匯款    預計匯款日 ＋ 安幸付款帳號        我方什麼時候、從哪個戶頭出
 *      ↓
 *     確認退款  實際退款日 ＋ 安幸付款帳號        錢真的匯出去了
 *
 * ★ 預計匯款日與安幸付款帳號**從送審移到排匯款**。
 *   送審當下常常還不知道會從哪個戶頭出、哪天出 —— 以前是必填，
 *   所以大家隨便填一個再回來改，而改動會清掉核可票、退回重審。
 *
 * ★ 實際帳號在「確認退款」還會再問一次。
 *   實務上真正匯出去的戶頭常常跟排定的不同，
 *   而排定的那個一旦錯了就再也沒有機會改（請款單踩過同一個坑）。
 *
 *
 * 【為什麼寫在 .ts 不是 .tsx】
 * 測試環境不處理 JSX。這裡決定「誰在什麼狀態看得到哪顆按鈕」——
 * 判斷錯不會報錯，只會讓某個人卡在某一步，而他只會說「按不到」。
 */

export type RefundStatus = 'none' | 'pending' | 'approved' | 'rejected';

export type RefundDep = {
  refund_status?: RefundStatus | null;
  received_on?: string | null;
  returned_on?: string | null;
  payee_name?: string | null;
  payee_account?: string | null;
  returned_method?: string | null;
  planned_refund_on?: string | null;
  returned_account?: string | null;
  manager_approved_at?: string | null;
  admin_approved_at?: string | null;
};

/** 看得到哪些動作的角色。跟請款單同一組（canSetDate）。 */
export type RefundRole = {
  isManager: boolean;
  isAdmin: boolean;
  isAccountant: boolean;
};

const st = (d: RefundDep): RefundStatus => (d.refund_status ?? 'none');
const has = (v: string | null | undefined) => !!(v ?? '').trim();

/**
 * 現金不需要帳號 —— 見 lib/pay-method。
 * 其餘方式一定要記錄錢從哪個戶頭出去，
 * 少了它，明年對元大帳戶時那筆匯出對不到任何單。
 */
export const needsAcct = (method: string | null | undefined) =>
  !!method && method !== 'cash';

/* ══════════════ 每一步缺什麼 ══════════════ */

/**
 * 送審缺的欄位。
 *
 * ★ **不含**預計匯款日與安幸付款帳號 —— 那兩個移到「排匯款」。
 *   審核者要看的是「錢退給誰」，不是「我方哪天從哪個戶頭出」。
 */
export function submitMissing(d: RefundDep): string[] {
  const out: string[] = [];
  if (!has(d.payee_name)) out.push('戶名');
  if (!has(d.payee_account)) out.push('房客收款帳號');
  if (!has(d.returned_method)) out.push('安幸付款方式');
  return out;
}

/** 排匯款缺的欄位。 */
export function planMissing(d: RefundDep, date: string, acct: string): string[] {
  const out: string[] = [];
  if (!has(date)) out.push('預計匯款日');
  if (needsAcct(d.returned_method) && !has(acct)) out.push('安幸付款帳號');
  return out;
}

/** 確認退款缺的欄位。跟排匯款同一套 —— 兩邊不一樣的話會有人卡在第二步。 */
export function settleMissing(d: RefundDep, date: string, acct: string): string[] {
  const out: string[] = [];
  if (!has(date)) out.push('實際退款日');
  if (needsAcct(d.returned_method) && !has(acct)) out.push('安幸付款帳號');
  return out;
}

/* ══════════════ 誰能按哪一顆 ══════════════ */

export type RefundPerms = {
  canRequest: boolean;
  canVoteMgr: boolean;
  canVoteAdm: boolean;
  canReject: boolean;
  canPlan: boolean;
  canSettle: boolean;
  canCancel: boolean;
};

/**
 * 這筆押金現在能做什麼。
 *
 * ★★ 紅線一律是 `returned_on` —— 錢匯出去了就什麼都不能動。
 *   不能看 refund_status:錢匯出去之後它仍然是 'approved'
 *   （那一欄記的是「審過了」，不是「還在等」）。
 *   只看它就會對一筆早就退完的押金說「等待匯款」。
 */
export function refundPerms(d: RefundDep, r: RefundRole): RefundPerms {
  const s = st(d);
  const done = !!d.returned_on;
  // 會計/主管/總經理都能推進流程。跟請款單的 canSetDate 同一組。
  const staff = r.isAccountant || r.isManager || r.isAdmin;

  return {
    /*
     * 還沒收到錢就沒有錢可以退。
     * pending 與 approved 也開放編輯 —— 存檔會清票重新送審，
     * 所以「改內容」跟「重新被審一次」永遠綁在一起，不可能繞過審核。
     */
    canRequest: staff && !!d.received_on && !done
      && ['none', 'rejected', 'pending', 'approved'].includes(s),
    canVoteMgr: r.isManager && s === 'pending' && !d.manager_approved_at,
    canVoteAdm: r.isAdmin && s === 'pending' && !d.admin_approved_at,
    canReject: (r.isManager || r.isAdmin) && s === 'pending',
    // 核可之後才排匯款。順序不強制的話可以跳過排款直接確認，
    // 結果是錢出去了卻沒有人排過、也沒有人知道該從哪個戶頭出。
    canPlan: staff && s === 'approved' && !done,
    canSettle: staff && s === 'approved' && !done,
    /*
     * 撤銷退款申請（2026-08-22 使用者指定，跟請款單一致）。
     *
     * 送錯了現在只能請人下 SQL，或放著卡在待核可裡 ——
     * 而卡著的那幾筆會一直出現在每個人的待辦清單上。
     *
     * ★ 錢匯出去之後不能撤 —— 那不是「取消申請」，是「退款沒發生過」，
     *   而錢已經在對方帳戶裡了。
     */
    canCancel: staff && !done && ['pending', 'approved'].includes(s),
  };
}

/* ══════════════ 撤銷要清掉什麼 ══════════════ */

/**
 * 撤銷退款申請時要寫回去的欄位。
 *
 * ★ 票一定要清掉。留著的話下次重新送審會**帶著舊的兩票**進來 ——
 *   看起來已經核可，而根本沒有人重新看過。
 *
 * ★ 房客帳戶與退款方式**留著不清**。那是查得到的事實
 *   （房客的帳號不會因為我們撤銷申請就變了），清掉只是讓人重打一次。
 */
export const cancelPatch = () => ({
  refund_status: 'none' as const,
  manager_approved_by: null, manager_approved_at: null,
  admin_approved_by: null, admin_approved_at: null,
  refund_requested_by: null, refund_requested_at: null,
  // 核可金額也要清 —— 留著的話下次送審前那個數字是上一輪的
  refund_amount: null,
  rejected_by: null, rejected_at: null, reject_reason: null,
});
