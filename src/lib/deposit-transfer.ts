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
  /** 押金 / 訂金（migration_174）。沒帶時當押金,既有呼叫端不會壞 */
  kind?: string | null;
};

/**
 * 移房是**押金專屬**（2026-08-25 使用者:「訂金不用 轉房」）。
 *
 * ── 為什麼擋在這裡而不是畫面 ────────────────────────
 *
 * 移房的語意是「同一筆押金換一間房」—— 它假設 A 房退租、B 房入住，
 * 錢跟著人走。訂金沒有這回事:訂金綁的是**一張還沒定案的契約**，
 * 換房就是換一張契約，那不是移轉，是重開一筆。
 *
 * ★★ 真的讓訂金移過去的話會怎樣:
 *
 *   移房會把來源那筆的 `returned_on` 填掉（那是它標示「已移出」的方式），
 *   而訂金的三條出路靠 `dep_exit_once_chk` 互斥 ——
 *   於是那筆訂金會變成「已退款」，沒收與轉押從此按不了。
 *   **而且完全不報錯**:它看起來就只是一筆退掉的訂金。
 *
 * ★ 擋在 `canBeSource` / `canBeTarget` 而不是那兩顆按鈕上 ——
 *   移轉挑選視窗（`moveCandidates`）也走這兩支，
 *   只藏按鈕的話訂金還是會出現在候選清單裡讓人挑。
 */
export const TRANSFER_IS_DEPOSIT_ONLY = '訂金不能移房 —— 換房請重開一張契約。';

const notDeposit = (d: TransferDep) => (d.kind ?? 'deposit') !== 'deposit';

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
  if (notDeposit(d)) return { ok: false, reason: TRANSFER_IS_DEPOSIT_ONLY };
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
  if (notDeposit(d)) return { ok: false, reason: TRANSFER_IS_DEPOSIT_ONLY };
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
   * ══════════ 金額不同怎麼辦（2026-09-02 改）══════════
   *
   * 【原本一律擋】（2026-08-19 使用者選 (a)）
   *   那時的理由是「差額不在任何地方」—— 而那句話當時是對的:
   *   還沒有「押金收多筆」，B 只能是全收或未收兩種狀態。
   *   原本的提示自己也寫著「**或等「押金收款多筆」做完再補收差額**」。
   *
   * 【現在放行「B 比較貴」】（2026-09-02 使用者:「移房完 如果增加押金
   *   如果沒收完 一樣顯示 收部分 全收」）
   *
   *   `deposit_payments` 做完了（migration_147），所以移轉進去的那一筆
   *   就是一筆收款 —— B 的狀態由既有的 `depPayStatus` 算出來，
   *   收不滿自然就是「收部分」。**不用多存一個欄位。**
   *
   * ★★★ 但「B 比較便宜」還是要擋。
   *   放行的話 B 會**超收**，而多出來的錢是要退給房客的 ——
   *   那是退款，不是移轉。混在一起的話，帳上會有一筆
   *   「已收 30,000 / 應收 20,000」而沒有任何地方說得出那 10,000 去哪了。
   */
  const af = Math.round((Number(from.amount) || 0) * 100);
  const at = Math.round((Number(to.amount) || 0) * 100);
  if (at < af) {
    const where = to.order_id ? '訂單' : '契約';
    return {
      ok: false,
      reason: `目的的押金比較少，會超收 ${money((af - at) / 100)}`,
      hint: `${depName(from)} 收了 ${money(from.amount)}，${depName(to)} 只要 ${money(to.amount)}。`
        + `多的那筆要退給房客 —— 那是退款不是移轉。`
        + `請先到${where}把金額改成一致，或先退款再移轉`,
    };
  }
  return { ok: true, reason: '' };
}

/**
 * 移轉之後 B 還差多少。0 = 剛好收滿。
 *
 * ★ 給移轉視窗**按下去之前**顯示用 —— 「移轉後還差 $10,000，
 *   要另外補收」比事後才發現狀態是「收部分」好。
 *
 * ★★ 這裡**不**處理超收（負數）—— 那種情況 `canTransfer` 已經擋掉了。
 *   回 0 而不是負數，因為畫面上「還差 -10,000」沒有人看得懂。
 */
export function shortfallAfterTransfer(
  from: Pick<TransferDep, 'amount'>,
  to: Pick<TransferDep, 'amount'>,
): number {
  const af = Math.round((Number(from.amount) || 0) * 100);
  const at = Math.round((Number(to.amount) || 0) * 100);
  return Math.max(0, (at - af) / 100);
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

/**
 * 給定來源（A），列出可以移過去的押金。
 *
 * ============================================================
 * 【為什麼兩個方向都要有】（2026-08-19，David 實際操作時卡住）
 *
 * 原本入口只放在目的（B，尚未收）那一筆上，理由是「人是從
 * B 房怎麼會有押金未收 開始找的」。
 *
 * 實際上不是。他手上先有的是**那筆要移走的押金** ——
 * 13A5 Roger 那筆退款被駁回，因為他其實是換房。
 * 他點進那筆押金要「移過去」，而那一頁上什麼按鈕都沒有。
 *
 * 兩邊都放入口，不用猜他從哪一邊開始。
 *
 * 排序:能移的排前面，其次房號 —— 未收的那些沒有收款日可以排。
 */
export function transferTargets(
  rows: TransferDep[], from: TransferDep, q = '',
): { dep: TransferDep; verdict: Verdict }[] {
  const kw = q.trim().toLowerCase();
  return rows
    .filter((d) => d.id !== from.id && canBeTarget(d).ok)
    .filter((d) => !kw || [d.room, d.guest_name, String(d.amount)]
      .some((v) => (v ?? '').toString().toLowerCase().includes(kw)))
    .map((dep) => ({ dep, verdict: canTransfer(from, dep) }))
    .sort((a, b) =>
      Number(b.verdict.ok) - Number(a.verdict.ok)
      || depName(a.dep).localeCompare(depName(b.dep)));
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

/* ══════════════════════════════════════════════════════════
 * 狀態標籤:押金狀態 ＋ 移房狀態（2026-09-02）
 * ══════════════════════════════════════════════════════════ */

/**
 * 這一筆押金要顯示哪幾個標籤。
 *
 * ============================================================
 * 【★★★ 原本一欄七個狀態搶著顯示，會蓋掉真正重要的那個】
 *
 * 舊的 `statusChip` 是一條優先序鏈:孤兒 → 移轉出 → 已退 → 移轉入 →
 * 收部分 → 已收 → 未收，**只回一個**。於是:
 *
 *   移轉進來又沒收滿  → 顯示「移轉自 5B2」，**「收部分」被蓋掉**
 *                        （2026-09-02 使用者移房加押金後就是這個情況）
 *   移轉進來又退掉    → 顯示「已退」，**「移轉自」被蓋掉**
 *
 * ★ 兩件事本來就是**兩個維度**:錢收到什麼程度、這筆是不是移房來的。
 *   擠成一個欄位就一定有一個要被犧牲。
 *
 * ============================================================
 * 【為什麼移轉出去的只顯示一個】
 *
 * 移轉出去的那筆 `returned_on` 有值，但**錢沒有退給房客** ——
 * 顯示「已退」會讓看清單的人以為錢出去了，而押金總額一毛都沒少。
 *
 * ★ 所以它的押金狀態直接寫「已移轉」，而且不用再多一個「已移轉 → 9A5」
 *   的重複標籤 —— 一個標籤把方向與對象都講完。
 */
export type DepBadges = {
  /** 押金狀態。`transferred` = 移轉出去（**不是**退給房客）。 */
  pay: 'orphan' | 'transferred' | 'returned' | 'paid' | 'partial' | 'unpaid';
  /** 要不要另外掛一個「移轉自 X」。移轉**出去**的不用 —— pay 已經講完了。 */
  showFrom: boolean;
};

export function depBadges(
  d: Pick<TransferDep, 'transfer_to_id' | 'transfer_from_id' | 'orphaned'
        | 'received_on' | 'returned_on'> & { received_amount?: number | null; amount?: number | null },
): DepBadges {
  // ★ 孤兒優先:來源單都不在了,其他狀態都建立在一個不存在的前提上
  if (d.orphaned) return { pay: 'orphan', showFrom: !!d.transfer_from_id };
  if (d.transfer_to_id) return { pay: 'transferred', showFrom: false };

  const showFrom = !!d.transfer_from_id;
  if (d.returned_on) return { pay: 'returned', showFrom };
  if (d.received_on) return { pay: 'paid', showFrom };
  /*
   * ★★ 收了一部分要看得出來（migration_147）。
   *   `received_on` 只有**收滿**才會被觸發器填上，所以走到這裡
   *   代表沒收滿 —— 有金額就是收部分。
   */
  if (Math.round(Number(d.received_amount) || 0) > 0) return { pay: 'partial', showFrom };
  return { pay: 'unpaid', showFrom };
}

/**
 * 押金狀態的文字。**畫面與 Excel 匯出共用同一份**。
 *
 * ★★★ 匯出原本自己寫了一條鏈（孤兒／已移轉／已退／暫收中／尚未收）——
 *   那是同一條規則的**第三份**，而且它**漏掉了「收部分」**:
 *   一筆收了一半的押金匯出去會寫「尚未收」，而金額欄是有數字的。
 *   看報表的人只會覺得那一列自相矛盾（CLAUDE.md 的坑）。
 */
export const DEP_BADGE_LABEL: Record<DepBadges['pay'], string> = {
  orphan: '孤兒',
  transferred: '已移轉',
  returned: '已退',
  paid: '全收',
  partial: '收部分',
  unpaid: '尚未收',
};
