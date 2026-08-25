/**
 * 訂金：狀態、三條出路、轉押與沒收的計算。
 *
 * ============================================================
 * 【訂金與押金是同一張表的兩種 kind】（migration_174）
 *
 * `deposits.kind` = `'deposit'`（押金）或 `'earnest'`（訂金）。
 * 生命週期一樣（未收 → 已收 → 退款兩票），所以共用同一套流程 ——
 * 開新表等於把退款、審核、分筆收款、憑證上傳整套複製一份，
 * 而複製出來的那份會慢慢跟原本的不一樣。
 *
 *
 * ============================================================
 * 【訂金比押金多兩條出路】
 *
 *     押金：已收 → 退款
 *     訂金：已收 → 退款 ／ 沒收 ／ 轉押金
 *
 * 三條互斥，走過一條就不能再走 —— 資料庫的 `dep_exit_once_chk` 擋著。
 * 這支的責任是**在使用者按下去之前就講出原因**，
 * 而不是讓他撞上一句看不懂的 SQL 例外。
 *
 *
 * 【為什麼寫在 .ts 不是 .tsx】
 * 測試環境不處理 JSX。而這裡每一條判斷錯了都會讓錢算錯，
 * 又都不會報錯 —— 那正是最需要測試的那種程式碼。
 */

export type EarnestKind = 'deposit' | 'earnest';

export type EarnestDep = {
  kind?: EarnestKind | null;
  amount?: number | null;
  received_on?: string | null;
  returned_on?: string | null;
  forfeited_on?: string | null;
  converted_to_deposit_id?: string | null;
  /** 兩票退款走到哪 —— 跟押金共用（deposit-refund.ts） */
  refund_status?: string | null;
};

/** 走過的那一條出路。null = 還沒走 */
export type ExitTaken = 'refund' | 'forfeit' | 'convert' | null;

export function exitTaken(d: EarnestDep): ExitTaken {
  if (d.returned_on) return 'refund';
  if (d.forfeited_on) return 'forfeit';
  if (d.converted_to_deposit_id) return 'convert';
  return null;
}

export type EarnestStatus =
  | '未付訂金' | '已收訂金' | '退款審核中' | '已退訂金' | '已沒收' | '已退｜轉押';

/**
 * 訂金現在是什麼狀態。
 *
 * ★ 順序有意義:**先看出路，再看收款**。
 *   反過來的話「已收訂金」會蓋掉「已沒收」——
 *   而沒收過的訂金 `received_on` 一定有值（要先收到才能沒收）。
 */
export function earnestStatus(d: EarnestDep): EarnestStatus {
  const exit = exitTaken(d);
  if (exit === 'forfeit') return '已沒收';
  if (exit === 'convert') return '已退｜轉押';
  if (exit === 'refund') return '已退訂金';
  if (!d.received_on) return '未付訂金';
  // 已收，但退款流程跑到一半
  if (d.refund_status === 'pending' || d.refund_status === 'approved') return '退款審核中';
  return '已收訂金';
}

/**
 * 這條出路現在走不走得了。回 null 表示可以，回字串是**要顯示給人看的原因**。
 *
 * ★ 回原因而不是 boolean:直接把按鈕藏掉的話，
 *   使用者會問「沒收鈕去哪了」，而答案（已經退款了）畫面上一個字都沒有。
 *   三顆按鈕都留著、走過之後變灰、hover 看得到原因 ——
 *   跟押金那邊「鎖住不是拿掉」同一個做法。
 */
export function exitBlockedReason(d: EarnestDep, want: 'refund' | 'forfeit' | 'convert'): string | null {
  if ((d.kind ?? 'deposit') !== 'earnest') return '這一列是押金，不是訂金。';
  if (!d.received_on) return '訂金還沒收到，不能' + LABEL[want] + '。';

  const taken = exitTaken(d);
  if (taken === want) return '已經' + LABEL[want] + '過了。';
  if (taken) return `已經${LABEL[taken]}了，不能再${LABEL[want]}。`;

  /*
   * ★ 退款流程跑到一半時，另外兩條要擋住。
   *   不擋的話會出現「送審中又被沒收」—— 審核那邊還在跑，
   *   而錢已經變成收入了。請款審核頁會多出一張核不掉的單。
   */
  if (want !== 'refund' && (d.refund_status === 'pending' || d.refund_status === 'approved')) {
    return '退款正在審核中，要先撤銷才能' + LABEL[want] + '。';
  }
  return null;
}

const LABEL: Record<'refund' | 'forfeit' | 'convert', string> = {
  refund: '退款', forfeit: '沒收', convert: '轉押金',
};

/**
 * 訂金轉押金要轉多少、押金還差多少。
 *
 * ============================================================
 * 【為什麼不是「金額相等才能轉」】
 *
 * 押金移房（migration_146）是金額不同就擋掉 —— 那是對的，
 * 因為移房前後是**同一筆押金**。
 *
 * 訂金轉押金不一樣:訂金 10,000、押金 30,000 是常態。
 * 照移房那樣擋的話，這個功能幾乎永遠用不了。
 *
 * 所以轉過去當「**已收一部分**」（2026-08-24 使用者指定），
 * 差額用押金既有的分筆收款（`deposit_payments`）再收。
 *
 * ★★ **不能把押金的 `amount` 改成訂金的數字** ——
 *    那一欄是 `sync_contract_deposits` 從 `contracts.deposit` 同步過來的，
 *    下次契約一存檔就被蓋回去（migration_146 的教訓）。
 */
export type ConvertPlan = {
  /** 轉過去的金額 = 訂金金額 */
  transfer: number;
  /** 押金應收 */
  depositAmount: number;
  /** 轉完之後押金還差多少。0 = 收齊了 */
  remaining: number;
  /** 轉完之後押金算不算已收齊 */
  settled: boolean;
  /** 訂金比押金還多的部分。> 0 要退還給房客，這輪不自動處理 */
  excess: number;
};

export function convertPlan(
  earnestAmount: number | null | undefined,
  depositAmount: number | null | undefined,
  alreadyPaid: number = 0,
): ConvertPlan {
  const transfer = Math.max(0, Number(earnestAmount) || 0);
  const dep = Math.max(0, Number(depositAmount) || 0);
  const paid = Math.max(0, Number(alreadyPaid) || 0);

  /*
   * ★ 已收的部分要算進去 —— 押金可能已經先收過一筆了。
   *   不算的話「還差多少」會算多，然後有人去跟房客多收一次。
   */
  const covered = paid + transfer;
  return {
    transfer,
    depositAmount: dep,
    remaining: Math.max(0, dep - covered),
    settled: covered >= dep && dep > 0,
    excess: Math.max(0, covered - dep),
  };
}

/**
 * 沒收訂金要產生的那筆一次性收入。
 *
 * ★ 會計科目用**「其他」**，不是新開一個「違約金」。
 *   `fee-types.ts` 的檔頭寫著取消相關的收入本來就歸在「其他」
 *   （Airbnb 取消收入 73 筆、約 150 萬都是這樣處理的）——
 *   那是既有的業務決定，沒收訂金歸同一處才一致。
 *
 * ★ 起訖同一天:一次性收入沒有住宿天數。
 *   填成一段期間的話，營收認列會把它拆到好幾個月。
 */
export type ForfeitOrder = {
  source: 'oneoff';
  fee_type: '其他';
  item_name: string;
  amount: number;
  checkin: string;
  checkout: string;
  deposit_id: string;
  estate_id: string | null;
  property_id: string | null;
  property_raw: string | null;
  guest_name: string | null;
  note: string;
};

export function forfeitOrder(
  dep: { id: string; amount?: number | null; estate_id?: string | null;
         property_id?: string | null; room?: string | null; guest_name?: string | null },
  onDate: string,
): ForfeitOrder {
  return {
    source: 'oneoff',
    fee_type: '其他',
    item_name: '取消入住',
    amount: Math.max(0, Number(dep.amount) || 0),
    checkin: onDate,
    checkout: onDate,
    deposit_id: dep.id,
    estate_id: dep.estate_id ?? null,
    property_id: dep.property_id ?? null,
    property_raw: dep.room ?? null,
    guest_name: dep.guest_name ?? null,
    // 備註要講出來源 —— 營收報表的「其他」混著好幾種收入，
    // 光看科目分不出這筆是什麼
    note: `沒收訂金（${onDate}）`,
  };
}

/**
 * 取消勾選「只收訂金」之前，還缺哪幾個欄位。
 *
 * ★ 使用者指定「沒填完不能取消」（2026-08-24）。
 *
 *   取消勾選 = 這張契約要開始長月租單了。租期或租金是空的話，
 *   長出來的單會是「日期 null、金額 null」——
 *   而那種單**不會報錯**，只會在營收報表上變成一個看不懂的空格。
 *
 * ★ 回的是**缺哪一個**，不是 boolean。
 *   只說「請填完必填欄位」的話，使用者得自己一格一格找，
 *   而那一頁有十幾個欄位。
 */
export function earnestOnlyMissing(c: {
  start_date?: string | null;
  end_date?: string | null;
  amount_per_period?: number | null;
}): string[] {
  const out: string[] = [];
  if (!(c.start_date ?? '').trim()) out.push('租期起');
  if (!(c.end_date ?? '').trim()) out.push('租期迄');
  // ★ 0 也算沒填 —— 月租 0 元的契約不存在，那一定是還沒填
  if (!(Number(c.amount_per_period) > 0)) out.push('每月租金');
  return out;
}

/**
 * 存契約時 `monthly_rent` 該存什麼。
 *
 * ★ 訂金階段要存 **null**，不是 0（階段 0 查證的結果）。
 *
 *   `contracts/page.tsx` 原本寫 `Math.round((amount_per_period || 0) / step)`，
 *   所以訂金階段會存成 `monthly_rent = 0`。
 *   功能上安全（`gen_contract_recognitions` 對 `<= 0` 一樣 return），
 *   但語意上「0 元租金」跟「還沒填」不是同一件事 ——
 *   而三個月後看資料的人只看得到那個 0。
 */
export function monthlyRentToSave(
  amountPerPeriod: number | null | undefined, step: number,
): number | null {
  const amt = Number(amountPerPeriod);
  if (!(amt > 0) || !(step > 0)) return null;
  return Math.round(amt / step);
}
