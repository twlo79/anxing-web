/**
 * 短租訂單的收款狀態。
 *
 * 【跟契約收租的差別】
 * 契約那邊是「一期一個勾」—— orders.paid 一個布林,收了就打勾,沒有中間狀態。
 * 月租金額固定,一次收一整期,那樣就夠了。
 *
 * 短租不行:一筆訂單常常分兩三次收（訂金 → 尾款），
 * 只有布林的話「收了訂金」跟「完全沒收」在畫面上長得一模一樣。
 *
 * 所以短租走 order_payments 一筆一列，orders 上用 paid_amount 存合計
 * （由 migration_84 的觸發器維護）。狀態是算出來的，不是另外存一個欄位 ——
 * 存了就會有「合計改了但狀態沒跟上」的那種 bug。
 *
 * 【為什麼 paid_amount 要存在 orders 上】
 * 列表一頁 50 筆，每筆都去查 order_payments 就是 50 次往返。
 * 觸發器維護的合計欄位讓列表一次查詢就拿得到，而且可以排序。
 */

/**
 * 平台代收的來源不需要記收款 —— Airbnb 與 Agoda 的錢是平台結算給我們的，
 * 不是我們一筆一筆去跟客人收的。硬要記只會多出一堆永遠「未收款」的假欠款。
 *
 * airbnb_cancelled 是 Airbnb 的變形（取消但有收費），同樣走平台，一併免填。
 *
 * 搭檔收款（partner）**不在**免填之列 —— 錢在搭檔手上，我們還是要跟搭檔收回來，
 * 那正是需要追的。若實務上不需要，把 'partner' 加進這個陣列就好。
 */
export const EXEMPT_SOURCES = ['airbnb', 'agoda', 'airbnb_cancelled'] as const;

export type PayStatus = 'exempt' | 'unpaid' | 'partial' | 'paid';

export type PayableOrder = {
  source: string;
  amount: number | null;
  paid_amount?: number | null;
};

export const isExempt = (source: string) => (EXEMPT_SOURCES as readonly string[]).includes(source);

/** 四捨五入到整數再比較。金額是台幣,小數點只會製造「差 0.001 所以永遠收不完」。 */
const round = (n: number | null | undefined) => Math.round(Number(n) || 0);

/**
 * 還差多少才收得完。已收滿或超收回 0 —— 負數會讓畫面出現「還差 -500」。
 */
export function remaining(o: PayableOrder): number {
  const due = round(o.amount);
  const got = round(o.paid_amount);
  return Math.max(0, due - got);
}

/**
 * 收款狀態。
 *
 * 【0 元與負數訂單】
 * 折讓走的是負數的一次性收入,金額 0 的訂單也存在（例如整筆招待）。
 * 這兩種沒有「要收的錢」,一律視為已收款 —— 標成未收款會讓它們永遠掛在待收清單上,
 * 而實際上沒有人欠任何錢。
 */
export function payStatus(o: PayableOrder): PayStatus {
  if (isExempt(o.source)) return 'exempt';
  const due = round(o.amount);
  const got = round(o.paid_amount);
  if (due <= 0) return 'paid';
  if (got <= 0) return 'unpaid';
  return got >= due ? 'paid' : 'partial';
}

export const STATUS_LABEL: Record<PayStatus, string> = {
  exempt: '平台代收',
  unpaid: '未收款',
  partial: '部分收款',
  paid: '已收款',
};

export const STATUS_CLASS: Record<PayStatus, string> = {
  exempt: 'bg-gray-100 text-gray-400',
  unpaid: 'bg-red-50 text-red-600',
  partial: 'bg-amber-50 text-amber-700',
  paid: 'bg-mor-greenlight text-mor-green',
};

/** 篩選下拉用。exempt 不放進去 —— 那不是使用者要追的狀態。 */
export const STATUS_FILTER: { value: PayStatus; label: string }[] = [
  { value: 'unpaid', label: '未收款' },
  { value: 'partial', label: '部分收款' },
  { value: 'paid', label: '已收款' },
];

export type PaymentCheck =
  | { ok: false; error: string }
  | { ok: true; confirm?: string };

/**
 * 新增一筆收款前的檢查。
 *
 * 超收不擋，只問一聲 —— 實務上真的會有多收（客人多匯、湊整數），
 * 擋死的話使用者只能去改訂單金額，那反而把營收改壞了。
 */
export function checkPayment(amount: number, rest: number, due: number): PaymentCheck {
  const a = round(amount);
  if (!a) return { ok: false, error: '請輸入收款金額' };
  if (a < 0) return { ok: false, error: '收款金額不能是負數（要沖銷請刪除該筆收款）' };
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

export type PaymentRow = {
  id: string; paid_on: string; amount: number | null;
  /** cash | transfer | credit_card | crypto —— 見 lib/pay-method。 */
  method: string | null;
  /** 安幸收款帳號。只有 method='transfer' 會有值（migration_85 的 op_account_chk）。 */
  account: string | null;
  note: string | null;
};

/** 收款合計。畫面上要跟 orders.paid_amount 對得起來,所以取整方式必須一致。 */
export function sumPayments(rows: PaymentRow[]): number {
  return rows.reduce((a, r) => a + round(r.amount), 0);
}

/** 最後一次收款日 —— 全部收齊時這就是 orders.paid_at。 */
export function lastPaidOn(rows: PaymentRow[]): string | null {
  return rows.reduce<string | null>((mx, r) => (r.paid_on && (!mx || r.paid_on > mx) ? r.paid_on : mx), null);
}
