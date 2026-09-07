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

// ── 應退金額怎麼顯示 ──────────────────────────────

/**
 * 清單上那個金額該印多少。
 *
 * ============================================================
 * 【★★★ 為什麼不能印 `amount`】（2026-09-07 使用者:「這筆應該顯示 9100」）
 *
 * 加費從押金扣（migration_157）之後，**應退不再等於押金**:
 *
 *     押金            10,000
 *     其他－寵物費      −400
 *     其他－寵物費      −500
 *     ─────────────────────
 *     應退             9,100   ← 真正要匯出去的錢
 *
 * 而請款審核清單印的是 `amount`（押金原額 10,000）——
 * 核可的人看到 10,000 就按核可，實際匯出去的卻是 9,100。
 *
 * ★★ 這個錯**不會報錯**。抽屜裡早就印對了（它讀 refund_amount），
 *   所以只有「點開抽屜的人」才會發現清單跟明細對不上，
 *   而按核可的人多半不會點開。
 *
 * ★ 兩邊各寫一份判斷是這個錯的來源。所以規則寫在這裡，兩邊都叫它。
 *
 *
 * ============================================================
 * 【`refund_amount` 是 null 的時候要當成全額】
 *
 * null 代表「舊資料，或還沒走過送審」—— 那時候沒有加費可扣，
 * 應退就是押金本身。當成 0 的話，一整批舊押金會在清單上顯示 $0，
 * 而那看起來像「這筆不用退」。
 */
export type RefundView = {
  /** 清單、核可、分享都用這個 —— **應退，不是押金原額**。 */
  amount: number;
  /** 押金原額。只有扣過才需要印出來。 */
  original: number;
  /**
   * 加費扣掉多少。
   *
   * ★ 0 就是沒扣，畫面**不要多印那一行** ——
   *   每一筆都印「扣加費 0」的話，這個訊號就沒有意義了,
   *   而真正扣過的那幾筆會混在裡面看不出來。
   */
  deducted: number;
};

function num(v: number | string | null | undefined): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

export function refundView(
  d: { amount: number | string | null; refund_amount?: number | string | null },
): RefundView {
  const original = num(d.amount);
  // ★ null / undefined = 還沒送審或舊資料 → 全額退，不是 0
  const amount = d.refund_amount == null ? original : num(d.refund_amount);
  return { amount, original, deducted: original - amount };
}

/**
 * 金額底下那一行小字。**沒扣過就回 null**，那一列就不會多一行。
 *
 * ★★ 印的是**算式**不是結論。核可的人要判斷的正是「9,100 對不對」，
 *   而判斷需要看到 10,000 跟 900 —— 只寫「已扣加費」的話，
 *   他還是得點開抽屜才知道扣了多少。
 *
 * ★ 應退比押金大是不該發生的（加費不會是負的）。真的發生時**照樣印出來** ——
 *   當成沒扣而不印的話，那筆異常會安靜地消失在清單裡。
 */
export function refundNote(v: RefundView, fmt: (n: number) => string): string | null {
  if (v.deducted === 0) return null;
  return v.deducted > 0
    ? `押金 ${fmt(v.original)}・扣加費 ${fmt(v.deducted)}`
    : `押金 ${fmt(v.original)}・應退多出 ${fmt(-v.deducted)}`;
}
