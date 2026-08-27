/**
 * 月租單分筆收款「收滿了沒、要不要自動結清」。
 *
 * 企劃見 docs/企劃-月租單分筆收款.md（2026-08-25）。
 *
 * ============================================================
 * 【★★ 為什麼這段判斷值得一個檔案】
 *
 * 使用者指定「收滿之後自動標記整期已收」。
 * 自動的東西一旦判斷錯，錯的方向是**整期無聲變綠** ——
 * 而那一期的錢實際上沒收齊，沒有人會再看它一眼。
 *
 * 所以「什麼叫收滿」必須寫在測得到的地方，
 * 而不是散在元件的 useEffect 裡。
 *
 *
 * ============================================================
 * 【★ 一期有好幾張單，而收款只掛在房租那一張】
 *
 * 畫面上的一期是 `periodTotal()` 算出來的合計:
 *
 *     房租 146,018 ＋ 管理費 8,982 ＝ 應收 155,000
 *
 * 但 `order_payments` 掛在**單一** order 上。所以全部掛在房租那張，
 * 而「收滿了沒」比的是**整期合計**，不是那張單自己的金額。
 *
 * ★★ 代價:那張房租單的 `orders.paid_amount` 從此不等於
 *    「房租收了多少」，而是「這一期收了多少」。
 *    直接讀那一欄的地方都會看到這個數字。
 */

export type SettleInput = {
  /** 整期應收合計（periodTotal 的 net） */
  due: number | null | undefined;
  /** 已收合計。來自 orders.paid_amount，由觸發器維護 —— 前端不自己算 */
  paid: number | null | undefined;
};

const round = (n: number | null | undefined) => Math.round(Number(n) || 0);

/** 還差多少。收滿或超收都回 0，不回負數。 */
export const restOf = (i: SettleInput) => Math.max(0, round(i.due) - round(i.paid));

/**
 * 這一期該不該自動標記已收。
 *
 * ★★ 三種情況**不自動**，每一種都有理由:
 *
 *   ① 還沒收滿          —— 顯然
 *   ② 應收 <= 0         —— 沒有「收滿」可言（整筆招待、純折讓的期別）。
 *                          自動結清的話那種期別一開畫面就變綠,
 *                          而沒有任何一筆錢進來過。
 *   ③ **超收**          —— 使用者選了自動，但超收表示金額可能填錯了
 *                          （少打一個 0 不會超收,多打一個會）。
 *                          那正是需要人看一眼的時候。
 *                          企劃 4.3 記著這是我加的一道,不是使用者要求的。
 */
export function shouldAutoSettle(i: SettleInput): boolean {
  const due = round(i.due);
  const paid = round(i.paid);
  if (due <= 0) return false;
  return paid === due;
}

/**
 * 為什麼沒有自動結清 —— 要講得出來。
 *
 * ★ 沒收滿時回 null（那不需要解釋，畫面上「尚欠」就是答案）。
 *   只有**看起來該結清卻沒有**的情況才要說話 —— 也就是超收。
 */
export function autoSettleBlockedReason(i: SettleInput): string | null {
  const due = round(i.due);
  const paid = round(i.paid);
  if (due <= 0) return null;
  if (paid > due) {
    return `已收 $${paid.toLocaleString('en-US')} 超過應收 $${due.toLocaleString('en-US')}`
      + `（多 $${(paid - due).toLocaleString('en-US')}）——`
      + `金額可能填錯了，所以沒有自動結清。確認無誤請自己按「確認收款」。`;
  }
  return null;
}

/**
 * 自動結清之後要跳的提示。
 *
 * ★★ **一定要說話**，不能無聲完成。
 *
 *   無聲的話使用者只看到整期突然變綠 —— 而他剛剛做的動作是「新增一筆收款」。
 *   下次金額打錯導致誤結清時，他也不會知道發生過這件事。
 */
export function autoSettleMessage(due: number | null | undefined, lastPaidOn: string): string {
  return `已收滿 $${round(due).toLocaleString('en-US')}，整期標記為已收（收款日 ${lastPaidOn}）`;
}

/**
 * 這一期最後一筆收款的日期 —— 自動結清時當收款日。
 *
 * ★ 取**最大的日期**，不是「陣列最後一筆」。
 *   補登一筆早幾天的收款時，那筆會排在陣列後面但日期比較早；
 *   拿它當收款日的話，整期的收款日會往回跳，
 *   而那個日期決定它算哪個月的收入。
 */
export function lastPaidOn(rows: { paid_on: string | null | undefined }[]): string | null {
  const ds = (rows ?? []).map((r) => (r.paid_on ?? '').trim()).filter(Boolean).sort();
  return ds.length ? ds[ds.length - 1] : null;
}
