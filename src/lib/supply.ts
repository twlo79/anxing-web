/**
 * 備品管理（純函式）。
 *
 * ============================================================
 * 【規則】（2026-09-07 使用者逐項確認）
 *
 *   庫存分到  **物業**（時兆的衛生紙跟正隆的衛生紙是兩筆）
 *   取用(−)   管家／房務自己填一筆，**不是**打掃一間自動扣
 *   補貨(+)   自己填，不從採購需求自動入庫
 *   盤點      每月底填「實際盤到多少」，差異由系統算
 *
 * ★ 用語（2026-09-07 使用者選 B）:**取用**（−）／**補貨**（+）。
 *   不用「領用／入庫」—— 按的人是管家跟房務，不是倉管。
 *
 * 資料庫那一半在 `migration_227`。
 */

/** 異動的四種。★ `init` 是會計設的初始庫存，一個品項只該有一筆 */
export type TxnKind = 'init' | 'in' | 'out' | 'adjust';

/**
 * 畫面上怎麼講。
 *
 * ★★ 這裡是**唯一**的字。按鈕、表格欄位、流水清單都讀這一份 ——
 *   各寫一次的話同一件事會在三個地方叫三個名字，
 *   而使用者會以為那是三件事（CLAUDE.md 的用語表那條）。
 */
export const KIND_LABEL: Record<TxnKind, string> = {
  init: '初始',
  in: '補貨',
  out: '取用',
  adjust: '盤點調整',
};

/** 按鈕上的字。★ 符號直接放進去 —— 不然看不出是加還是減 */
export const KIND_BUTTON: Record<'in' | 'out', string> = {
  out: '− 取用',
  in: '＋ 補貨',
};

export type SupplyItem = {
  id: string;
  estate_id?: string | null;
  name: string;
  spec?: string | null;
  vendor?: string | null;
  expire_on?: string | null;
  note?: string | null;
  active?: boolean;
};

/** `supply_balance` view 的一列。 */
export type Balance = {
  item_id: string;
  balance: number;
  init_qty: number;
  in_qty: number;
  /** ★ 已經取負號回正 —— 畫面上「取用」顯示正數 */
  out_qty: number;
  adjust_qty: number;
  last_move_on?: string | null;
};

export const ZERO_BALANCE: Omit<Balance, 'item_id'> = {
  balance: 0, init_qty: 0, in_qty: 0, out_qty: 0, adjust_qty: 0, last_move_on: null,
};

/**
 * 一筆異動要寫進資料庫的樣子。
 *
 * ★★★ `qty` **帶正負號**。取用一律是負的 ——
 *   畫面上讓人填正數（「用掉 3 個」），存進去才轉號。
 *   兩邊都用正數的話，`sum(qty)` 就不是餘量，
 *   而每一個要算餘量的地方都得自己寫一次 case。
 */
export function txnRow(
  kind: 'in' | 'out', itemId: string, qtyInput: number, happenedOn: string, note?: string,
): { item_id: string; kind: TxnKind; qty: number; happened_on: string; note: string | null } {
  const n = Math.abs(Number(qtyInput) || 0);
  return {
    item_id: itemId,
    kind,
    qty: kind === 'out' ? -n : n,
    happened_on: happenedOn,
    note: (note ?? '').trim() || null,
  };
}

/**
 * 送出前的檢查。`null` = 可以送。
 *
 * ★ 數量 0 擋掉 —— 記一筆「動了 0 個」沒有意義，多半是打錯。
 *   資料庫的 check 也擋，但那裡回的是一句 SQL 例外。
 */
export function txnError(kind: 'in' | 'out', qtyInput: unknown, happenedOn: string): string | null {
  const n = Number(qtyInput);
  if (!Number.isFinite(n) || n === 0) return '數量要填一個不是 0 的數字';
  if (n < 0) return `數量填正數就好 —— ${KIND_LABEL[kind]}的方向系統會處理`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test((happenedOn ?? '').trim())) return '要選日期';
  return null;
}

/**
 * 送出前先算給人看「43 → 40」。
 *
 * ★★ 餘量會變成負數時**問一次，不是擋死**。
 *   那多半是打錯，但也可能是真的（先借出去了、或補貨忘了登）——
 *   擋死的話那個人就記不了帳，而他手上的東西是真的少了。
 */
export function previewAfter(before: number, kind: 'in' | 'out', qtyInput: number): number {
  const n = Math.abs(Number(qtyInput) || 0);
  return Math.round(((Number(before) || 0) + (kind === 'out' ? -n : n)) * 100) / 100;
}

export function negativeWarn(before: number, kind: 'in' | 'out', qtyInput: number): string | null {
  const after = previewAfter(before, kind, qtyInput);
  if (after >= 0) return null;
  return `這樣餘量會變成 ${after}。\n\n`
    + '確定要記嗎？負數多半是打錯，但也可能是先借出去了、或補貨忘了登。\n'
    + '★ 記下去之後**不能刪**，只能再記一筆反向的沖銷。';
}

/**
 * 低量提醒。
 *
 * ★ 門檻先寫死一個數字（使用者還沒說每個品項的安全庫存）。
 *   衛生紙剩 5 是正常、除霉劑剩 5 可能就要買了 ——
 *   真的要用起來每個品項該有自己的門檻，等用一陣子再加。
 */
export const LOW_STOCK = 5;
export const isLow = (balance: number) => (Number(balance) || 0) <= LOW_STOCK;

/**
 * 效期快到了沒。
 *
 * ★ 只有一格效期（照使用者的 Excel），所以這只是個提醒 ——
 *   補了新的一批之後那一格要自己改。
 */
export function expiringSoon(
  expireOn: string | null | undefined, today: string, days = 60,
): boolean {
  const e = (expireOn ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(e)) return false;
  const diff = (Date.parse(e) - Date.parse(today)) / 86400000;
  return diff <= days;
}

/* ══════════════════════════════════════════════════════════
 * 盤點
 * ══════════════════════════════════════════════════════════ */

export type CountDraft = {
  item_id: string;
  /** 盤點當下系統算的餘量 */
  system_qty: number;
  /** 人填的:實際盤到多少。空字串 = 還沒盤 */
  counted: string;
  reason?: string;
};

/**
 * 差異 = 實際 − 系統。
 *
 * ★★★ 填的是「實際盤到多少」，**不是直接改餘量**。
 *   直接改的話「為什麼少了 2 瓶」就消失了 ——
 *   而那正是盤點要回答的問題。
 */
export function countDiff(d: CountDraft): number | null {
  const c = (d.counted ?? '').trim();
  if (c === '') return null;                 // 還沒盤，不是 0
  const n = Number(c);
  if (!Number.isFinite(n)) return null;
  return Math.round((n - (Number(d.system_qty) || 0)) * 100) / 100;
}

/** 有盤而且對不上的那幾筆 —— 這些才要產生調整流水 */
export function countsWithDiff(ds: CountDraft[]): CountDraft[] {
  return (ds ?? []).filter((d) => {
    const x = countDiff(d);
    return x !== null && x !== 0;
  });
}

/** 盤完之後要寫的東西:盤點紀錄 ＋ 對得上的不用調整、對不上的產生一筆 adjust */
export function countPlan(ds: CountDraft[], ym: string) {
  const counted = (ds ?? []).filter((d) => countDiff(d) !== null);
  return counted.map((d) => {
    const diff = countDiff(d)!;
    return {
      count: {
        item_id: d.item_id,
        ym,
        system_qty: Number(d.system_qty) || 0,
        counted_qty: Number(d.counted),
        diff,
        reason: (d.reason ?? '').trim() || null,
      },
      /** ★ 差異是 0 就不要產生流水 —— 那會是一筆 qty=0，資料庫的 check 會擋 */
      adjust: diff === 0 ? null : { item_id: d.item_id, kind: 'adjust' as const, qty: diff },
    };
  });
}

/**
 * 盤點的確認訊息。
 *
 * ★ 要講**會產生幾筆調整** —— 使用者以為自己只是填了幾個數字，
 *   而按下去之後庫存會真的跟著動。
 */
export function countConfirm(ds: CountDraft[], ym: string): string {
  const plan = countPlan(ds, ym);
  const adj = plan.filter((p) => p.adjust);
  if (!plan.length) return '';
  return `送出 ${ym.slice(0, 4)}-${ym.slice(4)} 的盤點？\n\n`
    + `盤了 ${plan.length} 個品項，其中 ${adj.length} 個對不上。\n`
    + (adj.length
      ? `系統會產生 ${adj.length} 筆盤點調整，讓餘量對齊你盤到的數字。\n`
      : '數字全部對得上，不會產生任何調整。\n')
    + '★ 盤點紀錄會留著:哪個月、誰盤的、差多少、原因。';
}
