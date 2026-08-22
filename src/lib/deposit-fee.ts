/**
 * 從押金扣除的加費。
 *
 * ============================================================
 * 【要解決什麼】（2026-08-22 使用者指定）
 *
 * 房客退房時扣了 100 元清潔費:
 *
 *     押金        10,000
 *     加費 清潔費   −100
 *     ──────────────────
 *     應退          9,900   ← 用這個金額送退款審核
 *
 * 退款完成後押金記「已退 10,000」（全額結清），
 * 其中 9,900 退現金、100 轉成營收。兩個數字都對，
 * 只是回答不同問題:押金結清了沒（10,000）、實際匯出多少（9,900）。
 *
 *
 * ============================================================
 * 【一筆資料，兩邊都看得到】
 *
 * 加費就是 orders 的子單（source='oneoff'），多一個 deposit_id。
 * 押金頁列 `deposit_id = 這筆押金` 當扣款明細，訂單頁本來就看得到，
 * 營收報表也不用改 —— oneoff 本來就進營收。
 *
 * 做成兩張表的話兩邊各記一次，總有一天對不起來，
 * 而那天你只會看到「押金明細加起來跟營收不一樣」。
 *
 *
 * ============================================================
 * 【為什麼寫在 .ts 不是 .tsx】
 * 測試環境不處理 JSX。這裡每一條算式都直接決定要退多少錢出去，
 * 算錯不會有錯誤訊息 —— 只會少退或多退，而且對方不會來說。
 */

const round = (n: unknown) => Math.round(Number(n) || 0);

/** 一筆從押金扣的加費（orders 的 oneoff 子單）。 */
export type DepFee = {
  id?: string;
  /** 費用日期。營收按這天認列 —— 預設帶預計匯款日，見 defaultFeeDate()。 */
  date: string | null;
  amount: number;
  fee_type?: string | null;
  item_name?: string | null;
  note?: string | null;
};

/** 算應退時要看的押金欄位。 */
export type DepForFee = {
  id: string;
  amount: number | null;
  returned_on?: string | null;
  planned_refund_on?: string | null;
  /** 送審當下核可的金額。null = 還沒送審。 */
  approved_amount?: number | null;
};

/* ══════════════ 金額 ══════════════ */

/** 加費合計。 */
export const feesTotal = (fees: DepFee[]) =>
  (fees ?? []).reduce((a, f) => a + round(f.amount), 0);

/**
 * 應退 = 押金 − 加費合計。
 *
 * ★ 不夾在 0 以上。負數要**看得見** ——
 *   夾成 0 的話畫面顯示「應退 0」，看起來像已經處理完，
 *   而實際上是加費填超過押金了。錯誤要浮出來，不要被算式吸收掉。
 */
export const refundable = (dep: DepForFee, fees: DepFee[]) =>
  round(dep.amount) - feesTotal(fees);

/* ══════════════ 能不能扣 ══════════════ */

export type FeeCheck = { ok: true } | { ok: false; error: string };

/**
 * 這筆加費存不存得進去。
 *
 * 跟資料庫的 order_fee_deposit_guard 同一套規則 ——
 * 兩邊都要有:資料庫是最後一道，前端負責在按下去之前就講清楚。
 * 只留資料庫的話，使用者會看到一句 SQL 錯誤訊息。
 */
export function checkFee(dep: DepForFee, fees: DepFee[], draft: DepFee): FeeCheck {
  const amt = round(draft.amount);
  if (!draft.date) return { ok: false, error: '請填費用日期' };
  if (amt === 0) return { ok: false, error: '請填金額' };
  if (amt < 0) return { ok: false, error: '金額要填正數 —— 扣除的方向系統會處理' };
  if (dep.returned_on) {
    return { ok: false, error: `這筆押金已於 ${dep.returned_on} 退還，不能再從它扣款。` };
  }
  // 排除自己那一列（編輯時），不然舊值會被算兩次
  const others = (fees ?? []).filter((f) => !draft.id || f.id !== draft.id);
  const after = feesTotal(others) + amt;
  if (after > round(dep.amount)) {
    return {
      ok: false,
      error: `加費合計 ${after.toLocaleString('en-US')} 超過押金 `
        + `${round(dep.amount).toLocaleString('en-US')}。應退不能是負數。`,
    };
  }
  return { ok: true };
}

/**
 * 費用日期的預設值。
 *
 * 使用者指定「看輸入的加費日期，預設是退押金日」。
 * 退押金日這時候未必填了，所以往下找:
 *
 *     實際退款日 → 預計匯款日 → 今天
 *
 * ★ 這個日期決定**營收認列在哪個月**。預設帶錯不會報錯，
 *   只會讓那 100 元落在別的月份 —— 所以畫面上一定要是可以改的欄位。
 */
export function defaultFeeDate(dep: DepForFee, today: string): string {
  return dep.returned_on || dep.planned_refund_on || today;
}

/* ══════════════ 候選押金 ══════════════ */

/** 訂單頁要問的:這張加費能掛到哪筆押金。 */
export type DepCandidate = {
  id: string;
  amount: number | null;
  returned_on?: string | null;
  order_id?: string | null;
  contract_id?: string | null;
  room?: string | null;
  guest_name?: string | null;
};

export type PickResult =
  | { kind: 'one'; dep: DepCandidate }
  | { kind: 'none' }
  | { kind: 'many'; n: number };

/**
 * 找出這張訂單對應的押金。
 *
 * ★★ **只走 id，不比房號**（2026-08-22 使用者指定「一定要確認是同單，用 unique ID 搜」）。
 *
 *   deposits.order_id / contract_id 是既有欄位，本來就是硬連結。
 *   用房號比對的話，同一個房號跨房客、跨期都會中 ——
 *   而扣錯人的押金，畫面上完全看不出來:金額對、房號對、
 *   只有「是誰的錢」錯了。
 *
 * ★ 只採計唯一解。找到兩筆以上一律不給選 ——
 *   「對不上的不猜。少填一個看得到、補得回來;填錯一個沒有人會發現。」
 *
 * ★ 已退的押金不算候選 —— 錢匯出去了，扣不到。
 */
export function pickDeposit(
  deps: DepCandidate[],
  order: { id: string; parent_order_id?: string | null; contract_id?: string | null },
): PickResult {
  const orderIds = [order.id, order.parent_order_id].filter(Boolean) as string[];
  const hit = (deps ?? []).filter((d) =>
    !d.returned_on
    && ((d.order_id && orderIds.includes(d.order_id))
      || (!!order.contract_id && d.contract_id === order.contract_id)));
  if (hit.length === 1) return { kind: 'one', dep: hit[0] };
  if (hit.length === 0) return { kind: 'none' };
  return { kind: 'many', n: hit.length };
}

/* ══════════════ 核可金額對不對得上 ══════════════ */

/**
 * 送審之後加費被改動的提醒。
 *
 * 使用者選了「確認退款前都能改」（2026-08-22）。副作用是:
 * 主管核的是 9,900，核完之後有人把加費改成 200，實退變 9,800 ——
 * **核可紀錄上的金額不再是實際退的金額**。
 *
 * ★ 這支**不擋**，只回一句話。系統負責看見，人負責決定。
 * ★ 回 null 表示沒問題（沒送審過，或金額沒變）。
 */
export function approvalDrift(dep: DepForFee, fees: DepFee[]): string | null {
  if (dep.approved_amount == null) return null;
  const now = refundable(dep, fees);
  const was = round(dep.approved_amount);
  if (now === was) return null;
  return `核可金額 ${was.toLocaleString('en-US')} ≠ 目前應退 ${now.toLocaleString('en-US')}`;
}

/* ══════════════ 鎖定 ══════════════ */

/**
 * 這張訂單為什麼不能改。回 null 表示沒鎖。
 *
 * 跟資料庫的 order_locked_reason() 同一套規則。
 *
 * ★ 前端擋不是安全機制，觸發器才是。這裡存在的理由是**講出原因** ——
 *   只把欄位變灰的話，使用者只會看到畫面沒反應，然後說「壞了」
 *   （2026-08-19「主管按確認沒反應」查了一整天，就是擋阻不講話）。
 */
export function orderLockReason(
  dep: { returned_on?: string | null } | null | undefined,
  role: string | null | undefined,
): string | null {
  if (!dep?.returned_on) return null;
  // 會計與總管理員可以改 —— 打錯一個字不該只能請人下 SQL
  if (role === 'accountant' || role === 'super_admin') return null;
  return `押金已於 ${dep.returned_on} 退還，此單已結清。要修改請洽會計或總管理員。`;
}
