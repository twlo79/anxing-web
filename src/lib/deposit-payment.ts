/**
 * 押金收款的狀態與合計。**只算數字，不管版面。**
 *
 * ============================================================
 * 【為什麼跟 order-payment 分開一支】
 *
 * 兩者的判斷幾乎一樣，但**輸入不一樣**：
 *
 *   訂單  有 source（平台代收的免收款）、有 fee_type（取消收入也免）
 *   押金  沒有那些，但有 orphaned（來源單已刪）與 returned_on（退掉了）
 *
 * 硬共用一支的話，函式簽章要同時容納兩組不相干的欄位，
 * 而每次改其中一邊都要重新確認另一邊沒被弄壞。
 *
 * 共用的是**規則**不是程式碼：四捨五入到整數再比、超收不擋只問一聲、
 * 狀態是算出來的不另外存欄位。那幾條在兩支裡各寫一次，並各自被測試釘住。
 *
 * ============================================================
 * 【為什麼狀態不存成欄位】
 *
 * 存了就會有「合計改了但狀態沒跟上」的那種 bug ——
 * 而畫面上那筆押金會顯示「已收款」配一個收了一半的數字，
 * 兩個都很正常，只有放在一起才看得出不對。
 */

export type DepPayStatus = 'unpaid' | 'partial' | 'paid' | 'returned';

export type PayableDeposit = {
  /** 應收（台幣）。來源是訂單／契約，這裡不能改。 */
  amount: number | null;
  /** 實收合計。由 deposit_payments 的觸發器維護（migration_147）。 */
  received_amount?: number | null;
  /** 收滿的那一天。沒收滿就是 null。 */
  received_on?: string | null;
  returned_on?: string | null;
};

export type DepPaymentRow = {
  id: string;
  paid_on: string;
  amount: number;
  method: string | null;
  account: string | null;
  note: string | null;
};

/** 四捨五入到整數再比。台幣沒有小數，留著只會製造「差 0.001 所以永遠收不完」。 */
const round = (n: number | null | undefined) => Math.round(Number(n) || 0);

/** 還差多少。收滿或超收回 0 —— 負數會讓畫面出現「還差 -500」。 */
export function remainingDep(d: PayableDeposit): number {
  return Math.max(0, round(d.amount) - round(d.received_amount));
}

/**
 * 收款狀態。
 *
 * 【順序有意義】退掉的優先 —— 一筆已經退還給房客的押金，
 * 說它「已收款」在畫面上是對的（錢確實收過），但那不是人現在要看的事。
 *
 * 【應收 0 或負數】押金不會是負的，但 0 有可能（免押金）。
 * 那種一律當已收 —— 標成未收款會讓它永遠掛在待收清單上，而沒有人欠任何錢。
 */
export function depPayStatus(d: PayableDeposit): DepPayStatus {
  if (d.returned_on) return 'returned';
  const due = round(d.amount);
  const got = round(d.received_amount);
  if (due <= 0) return 'paid';
  if (got <= 0) return 'unpaid';
  return got >= due ? 'paid' : 'partial';
}

export const DEP_STATUS_LABEL: Record<DepPayStatus, string> = {
  unpaid: '尚未收',
  partial: '部分收款',
  paid: '暫收中',
  returned: '已退',
};

/** 沿用訂單那份的配色 —— 同一種狀態在兩頁不該是不同顏色。 */
export const DEP_STATUS_CLASS: Record<DepPayStatus, string> = {
  unpaid: 'bg-amber-50 text-amber-600',
  partial: 'bg-amber-50 text-amber-700',
  paid: 'bg-mor-bluelight text-mor-slate',
  returned: 'bg-gray-100 text-gray-500',
};

export type DepPaymentCheck =
  | { ok: false; error: string }
  | { ok: true; confirm?: string };

/**
 * 新增一筆收款前的檢查。
 *
 * 【超收不擋，只問一聲】
 * 實務上真的會多收（客人多匯、湊整數）。擋死的話使用者只能去改押金金額 ——
 * 而押金金額是契約條件的一部分，改了就把來源弄壞了。
 *
 * 【負數擋死】
 * 要沖銷就把那一筆刪掉。允許負數的話，明細會變成一堆正負相消的列，
 * 而「這筆押金到底收了多少」得靠人心算。
 */
export function checkDepPayment(amount: number, rest: number, due: number): DepPaymentCheck {
  const a = round(amount);
  if (!a) return { ok: false, error: '請輸入收款金額' };
  if (a < 0) return { ok: false, error: '收款金額不能是負數（要沖銷請刪除那一筆收款）' };
  if (due <= 0) return { ok: true };
  if (a > rest) {
    return {
      ok: true,
      confirm: `這筆收 $${a.toLocaleString('en-US')}，超過尚欠的 $${rest.toLocaleString('en-US')}`
        + `（多 $${(a - rest).toLocaleString('en-US')}）。\n\n確定要記這個金額嗎？`,
    };
  }
  return { ok: true };
}

/**
 * 收款方式的顯示文字。
 *
 * ★ 多筆時回「多筆」而不是挑其中一個 ——
 *   一筆現金＋一筆匯款，挑哪一個都會讓另一半的錢看起來走錯管道。
 *   而那正是跟銀行對帳時會被相信的欄位。
 */
export function methodSummary(
  rows: Pick<DepPaymentRow, 'method' | 'account'>[],
  label: (m: string) => string,
  acctName: (a: string) => string,
): string {
  if (rows.length === 0) return '—';
  if (rows.length > 1) return `多筆（${rows.length}）`;
  const r = rows[0];
  if (!r.method) return '—';
  const base = label(r.method);
  return r.account ? `${base}・${acctName(r.account)}` : base;
}

/** 明細合計。畫面上「已收」那一格用資料庫的值，這支只給對帳用。 */
export const sumPayments = (rows: Pick<DepPaymentRow, 'amount'>[]) =>
  rows.reduce((a, r) => a + (Number(r.amount) || 0), 0);

/**
 * 明細加起來跟資料庫的合計對不對得上。
 *
 * 【為什麼要有這個】
 * 合計是觸發器維護的，明細是前端載回來的 —— 兩邊本來就該一樣。
 * 不一樣就代表其中一邊有問題（觸發器沒跑、或前端漏載了幾筆），
 * 而**兩個數字各自看都很正常**，只有放在一起才看得出來。
 *
 * 回 null 表示對得上。有值就是要顯示給人看的警告。
 */
export function reconcile(rows: Pick<DepPaymentRow, 'amount'>[], received: number | null | undefined): string | null {
  const a = round(sumPayments(rows));
  const b = round(received);
  if (a === b) return null;
  return `明細加起來是 $${a.toLocaleString('en-US')}，但系統記的實收是 $${b.toLocaleString('en-US')}`
    + `（差 $${Math.abs(a - b).toLocaleString('en-US')}）。重新整理看看，還是不一樣就要查。`;
}
