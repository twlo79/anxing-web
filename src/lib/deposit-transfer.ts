/**
 * 押金移房：A 房收過的押金轉到 B 房的新訂單。
 *
 * ============================================================
 * 【這一支只回答「能不能移」，不動資料】
 *
 * 真正的移轉在 `transfer_deposit` RPC 裡（migration_146）——
 * 兩列要嘛一起改、要嘛都不動，那件事只有資料庫做得到。
 *
 * **這裡的檢查是給人看的，不是防線。**
 * 前端擋住是為了讓人在按下去之前就知道為什麼不行；
 * 真正說了算的是 RPC，它會再檢查一次一模一樣的條件。
 *
 * 兩邊都寫的原因很實際：只有前端擋，繞過去就沒人管；
 * 只有後端擋，人得按下去才知道不行，而失敗訊息又是最不被讀的東西。
 *
 * ============================================================
 * 【為什麼寫在 .ts 不是 .tsx】
 *
 * 測試環境不處理 JSX，寫在元件檔裡的判斷式一行都測不到。
 * 而這裡每一條規則錯了都**不會報錯**：
 *
 *   · 漏掉「目的已收過」→ 同一筆押金收兩次，總額憑空多一筆
 *   · 漏掉「金額相同」  → B 顯示收了 40,000，實際只有 30,000
 *   · 漏掉「來源已退」  → 已經退給房客的錢又被移到別房
 *
 * 三個都是「數字看起來很正常」，沒有人會發現。
 */

export type TransferDep = {
  id: string;
  room: string | null;
  guest_name: string | null;
  currency: string;
  amount: number;
  received_on: string | null;
  returned_on: string | null;
  orphaned: boolean;
  order_id?: string | null;
  contract_id?: string | null;
  transfer_to_id?: string | null;
  transfer_from_id?: string | null;
};

/**
 * 誰能移。**經理不在內**（2026-08-19 使用者指定：「只有會計 super_admin」）。
 *
 * 經理能改押金、能投退款票，但不能移房 —— 移轉繞過了兩票審核，
 * 開放的人越少，「為什麼這筆變成已退」越查得到人。
 * 這一份要跟 RPC 裡的 `current_role_of() not in (...)` 一致，
 * 對不上的症狀是按鈕看得到卻按不動。
 */
export const TRANSFER_ROLES = ['accountant', 'super_admin'];
export const roleCanTransfer = (role: string | null | undefined) =>
  TRANSFER_ROLES.includes(role ?? '');

const money = (n: number | null | undefined) => Math.round(Number(n) || 0).toLocaleString('en-US');

/** 這筆押金在畫面上叫什麼。房號優先，沒有就用姓名 —— 不要顯示空白。 */
export function depName(d: Pick<TransferDep, 'room' | 'guest_name'>): string {
  return (d.room ?? '').trim() || (d.guest_name ?? '').trim() || '（未填房號）';
}

export type Verdict = { ok: boolean; reason: string; hint?: string };

/** 可以當來源（A）嗎 —— 錢真的在我們手上。 */
export function canBeSource(d: TransferDep): Verdict {
  if (d.orphaned) return { ok: false, reason: '孤兒紀錄' };
  if (!d.received_on) return { ok: false, reason: '還沒收到押金' };
  if (d.returned_on) {
    return d.transfer_to_id
      ? { ok: false, reason: `已移轉出去（${d.returned_on}）` }
      : { ok: false, reason: `已退款（${d.returned_on}）` };
  }
  return { ok: true, reason: '' };
}

/** 可以當目的（B）嗎 —— 還沒收。 */
export function canBeTarget(d: TransferDep): Verdict {
  if (d.orphaned) return { ok: false, reason: '孤兒紀錄' };
  if (d.returned_on) return { ok: false, reason: `已退款（${d.returned_on}）` };
  if (d.received_on) {
    return d.transfer_from_id
      ? { ok: false, reason: `已經有移轉進來的押金（${d.received_on}）` }
      : { ok: false, reason: `已經收過押金了（${d.received_on}）` };
  }
  return { ok: true, reason: '' };
}

/**
 * 這兩筆能不能配成一次移轉。
 *
 * 訊息要把數字講完整 —— 只說「金額不同」的話，人得自己開兩個視窗
 * 對照才知道差多少、該往哪邊改。
 */
export function canTransfer(from: TransferDep, to: TransferDep): Verdict {
  if (from.id === to.id) return { ok: false, reason: '來源與目的是同一筆' };

  const s = canBeSource(from);
  if (!s.ok) return { ok: false, reason: `來源不能移轉：${s.reason}`, hint: depName(from) };
  const t = canBeTarget(to);
  if (!t.ok) return { ok: false, reason: `目的不能收：${t.reason}`, hint: depName(to) };

  const cf = (from.currency || 'TWD').toUpperCase();
  const ct = (to.currency || 'TWD').toUpperCase();
  if (cf !== ct) {
    return { ok: false, reason: `幣別不同（${cf} → ${ct}）`, hint: '換匯是另一件事，不能靠移轉帶過' };
  }

  /*
   * ★ 金額不同一律擋（2026-08-19 使用者選 (a)）。
   *
   * 因為 deposits.amount 是觸發器從 orders.deposit 同步過來的,
   * 移轉時**改不動 B 那一欄** —— 下次訂單一存檔就被蓋回去。
   * 放行的話 B 會顯示一個從來沒收到的數字,而差額不在任何地方。
   */
  const af = Math.round((Number(from.amount) || 0) * 100);
  const at = Math.round((Number(to.amount) || 0) * 100);
  if (af !== at) {
    const where = to.order_id ? '訂單' : '契約';
    return {
      ok: false,
      reason: `金額不同，差 ${money(Math.abs(at - af) / 100)}`,
      hint: `${depName(from)} 收了 ${money(from.amount)}，${depName(to)} 要 ${money(to.amount)}。`
        + `請先到${where}把押金金額改成一致，或等「押金收款多筆」做完再補收差額`,
    };
  }
  return { ok: true, reason: '' };
}

/**
 * 給定目的（B），列出可以當來源的押金。
 *
 * **不自動用房客姓名比對** —— 換房常常也換人（原本兩人住、剩一人續租），
 * 照名字猜會漏掉一半，而漏掉的那半使用者只會看到「找不到」，
 * 不會知道是被姓名條件濾掉的。所以一律列出全部暫收中的，讓人自己搜。
 *
 * 排序：能移的排前面，其次收款日新到舊 —— 剛換房的通常是最近才收的那筆。
 */
export function transferCandidates(
  rows: TransferDep[], to: TransferDep, q = '',
): { dep: TransferDep; verdict: Verdict }[] {
  const kw = q.trim().toLowerCase();
  return rows
    .filter((d) => d.id !== to.id && canBeSource(d).ok)
    .filter((d) => !kw || [d.room, d.guest_name, String(d.amount), d.received_on]
      .some((v) => (v ?? '').toString().toLowerCase().includes(kw)))
    .map((dep) => ({ dep, verdict: canTransfer(dep, to) }))
    .sort((a, b) =>
      Number(b.verdict.ok) - Number(a.verdict.ok)
      || (b.dep.received_on ?? '').localeCompare(a.dep.received_on ?? ''));
}

export const isTransferOut = (d: Pick<TransferDep, 'transfer_to_id'>) => !!d.transfer_to_id;
export const isTransferIn = (d: Pick<TransferDep, 'transfer_from_id'>) => !!d.transfer_from_id;
export const isTransfer = (d: Pick<TransferDep, 'transfer_to_id' | 'transfer_from_id'>) =>
  !!d.transfer_to_id || !!d.transfer_from_id;

/**
 * 狀態標籤的文字。
 *
 * ★ 移轉出去的那筆**不可以只顯示「已退」**。
 *   同一個 returned_on 兩種意思：一個是錢匯給房客了，一個是錢還在我們手上
 *   只是換了名目。共用一個灰標籤的話，看清單的人會以為錢退出去了。
 *
 * 回 null 代表這筆不是移轉，照原本的狀態標籤走。
 */
export function transferChip(
  d: Pick<TransferDep, 'transfer_to_id' | 'transfer_from_id'>,
  nameOf: (id: string) => string | null,
): { text: string; dir: 'out' | 'in'; otherId: string } | null {
  if (d.transfer_to_id) {
    return { text: `已移轉 → ${nameOf(d.transfer_to_id) ?? '另一筆'}`, dir: 'out', otherId: d.transfer_to_id };
  }
  if (d.transfer_from_id) {
    return { text: `移轉自 ${nameOf(d.transfer_from_id) ?? '另一筆'}`, dir: 'in', otherId: d.transfer_from_id };
  }
  return null;
}
