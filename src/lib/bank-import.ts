/**
 * 對帳單匯入的判斷。**不碰資料庫,不碰 PDF** —— 只是純粹的比對。
 *
 * ============================================================
 * 【為什麼跟 bank-statement.ts 分開】
 *
 * 那一支管「PDF 上寫了什麼」,這一支管「這些跟資料庫裡已經有的
 * 是什麼關係」。兩件事會分別出錯,也分別要測。
 *
 * 而這裡每一條錯了都不會報錯:
 *
 *   · 去重判太寬 → 重傳同一份會變兩倍流水,而餘額欄看起來都對
 *   · 去重判太嚴 → 新的那幾筆被當成重複跳過,靜靜地少
 *   · 帳戶對錯   → 整份記到別的帳上
 */

import { txnKey, type Statement, type Txn } from './bank-statement.ts';

/** 資料庫裡已經有的一筆(只需要組鑰匙的欄位)。 */
export type ExistingTxn = {
  post_date: string;
  balance: number | string;
  txn_time: string | null;
};

export type ImportPlan = {
  /** 要寫進去的。 */
  fresh: Txn[];
  /** 資料庫裡已經有的。**要看得見,不能靜靜跳過。** */
  duplicate: Txn[];
  /** 同一份 PDF 裡自己撞在一起的 —— 正常不該發生,發生了代表解析重複讀了。 */
  selfDuplicate: Txn[];
};

/**
 * 資料庫回來的時間可能是 `13:07:00` 也可能是 `13:07:00+08`。
 * 只取前八碼 —— 不切齊的話每一筆都會被當成新的。
 */
function normTime(t: string | null): string {
  if (!t) return '00:00:00';
  return t.slice(0, 8);
}

function existingKey(accountId: string, r: ExistingTxn): string {
  return `${accountId}|${r.post_date.slice(0, 10)}|${Number(r.balance)}|${normTime(r.txn_time)}`;
}

/**
 * 這份對帳單裡，哪幾筆是新的。
 *
 * 去重鑰匙是 `帳號 + 帳務日 + 餘額 + 交易時間`（見 `txnKey`）——
 * **不是序號**,那是本次查詢的流水號,換期間就從 1 重來。
 */
export function planImport(
  accountId: string,
  txns: Txn[],
  existing: ExistingTxn[],
): ImportPlan {
  const have = new Set(existing.map((r) => existingKey(accountId, r)));
  const seen = new Set<string>();
  const plan: ImportPlan = { fresh: [], duplicate: [], selfDuplicate: [] };

  for (const t of txns) {
    const k = txnKey(accountId, t);
    if (seen.has(k)) {
      plan.selfDuplicate.push(t);
      continue;
    }
    seen.add(k);
    if (have.has(k)) plan.duplicate.push(t);
    else plan.fresh.push(t);
  }
  return plan;
}

/**
 * 這份 PDF 是哪個帳戶的。
 *
 * **對不上就回 null,不要挑一個最像的。**
 * 少匯一份看得到、補得回來；記到錯的帳上沒有人會發現。
 */
export type AccountLike = {
  id: string;
  name: string;
  account_no?: string | null;
  account_no_tail?: string | null;
};

export type MatchResult =
  | { ok: true; account: AccountLike }
  | { ok: false; reason: 'no_account_no' | 'not_registered' | 'ambiguous'; message: string };

export function matchAccount(
  st: Statement,
  accounts: AccountLike[],
): MatchResult {
  if (!st.accountNo) {
    return {
      ok: false,
      reason: 'no_account_no',
      message: '這份 PDF 裡找不到帳號 —— 是元大的交易明細嗎？',
    };
  }
  const digits = st.accountNo.replace(/\D/g, '');
  const full = accounts.filter((a) => (a.account_no ?? '').replace(/\D/g, '') === digits);
  /*
   * 完整帳號優先。比不到才退回末五碼 ——
   * 而末五碼比的是「解析出來的帳號」,不是整份 PDF 的文字:
   * 票據號碼(012-0000341168247682)裡隨時會出現一樣的五碼。
   */
  const hits =
    full.length > 0
      ? full
      : accounts.filter((a) => {
          const tail = (a.account_no_tail ?? '').replace(/\D/g, '');
          // 有完整帳號卻對不上的,不可以再用末五碼救 —— 那是明確的「不是它」
          return tail.length > 0 && !a.account_no && digits.endsWith(tail);
        });

  if (hits.length === 1) return { ok: true, account: hits[0] };
  if (hits.length === 0) {
    return {
      ok: false,
      reason: 'not_registered',
      // **把帳號印出來** —— 只說「查無此帳戶」的話,
      // 人分不出是自己傳錯檔還是帳戶還沒建
      message: `帳號 ${st.accountNo} 不在系統裡 —— 請先到權限管理建立這個帳戶。`,
    };
  }
  return {
    ok: false,
    reason: 'ambiguous',
    message: `帳號 ${st.accountNo} 同時對到 ${hits.length} 個帳戶（${hits
      .map((a) => a.name)
      .join('、')}）—— 請先把完整帳號填齊。`,
  };
}

/**
 * 三張卡片的合計。
 *
 * ============================================================
 * 【為什麼要回傳 asOf 而不是只回一個數字】
 *
 * 三份對帳單的截止日可能不一樣。只傳了兩份新的就顯示合計,
 * 那個數字是「兩個新的 ＋ 一個舊的」——
 * **看起來像現在的現金,其實不是。**
 *
 * 所以回傳最舊的那個日期,畫面上標出來:
 *   「總計 $351,000（其中 24145 只到 03/31）」
 */
export type AccountBalance = { name: string; balance: number | null; asOf: string | null };

export function totalBalance(rows: AccountBalance[]): {
  total: number;
  asOf: string | null;
  /** 截止日落後的帳戶名稱。空陣列表示三份都對齊。 */
  stale: string[];
  /** 還沒上傳過對帳單的帳戶。它們沒有算進 total。 */
  missing: string[];
} {
  const withData = rows.filter((r) => r.balance != null && r.asOf);
  const missing = rows.filter((r) => r.balance == null || !r.asOf).map((r) => r.name);
  const total = withData.reduce((a, r) => a + (r.balance as number), 0);
  if (withData.length === 0) return { total: 0, asOf: null, stale: [], missing };

  const dates = withData.map((r) => r.asOf as string);
  const oldest = dates.reduce((a, b) => (a < b ? a : b));
  const newest = dates.reduce((a, b) => (a > b ? a : b));
  return {
    total,
    asOf: oldest,
    stale: oldest === newest ? [] : withData.filter((r) => r.asOf !== newest).map((r) => r.name),
    missing,
  };
}
