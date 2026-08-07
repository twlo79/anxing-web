/**
 * 收付款方式。全站共用一份。
 *
 * 【為什麼要獨立出來】
 * 這四個值原本定義在 components/RefundFields.tsx 裡（押金收退款用）。
 * 短租收款也要同一組，但 lib 去 import 一個 React 元件只為了兩個常數，
 * 相依方向是反的。所以搬到這裡，RefundFields 改成從這裡再匯出 ——
 * 既有的 import 一行都不用改。
 *
 * 【account 什麼時候有意義】
 * 只有「匯款」對得到我方的收款帳戶（元大 8088／0564／4145）。
 * 現金是當面收的、信用卡走收單行、加密貨幣走錢包 —— 那三種硬要指定
 * payment_accounts 裡的某個帳號只會讓對帳的人以為錢真的進了那個戶頭。
 */

export const METHOD_LABEL: Record<string, string> = {
  cash: '現金', transfer: '匯款', credit_card: '信用卡', crypto: '加密貨幣',
};

export const METHOD_OPTS = ['cash', 'transfer', 'credit_card', 'crypto'];

/** 只有匯款需要（也才允許）指定收款帳戶。 */
export const needsAccount = (method: string | null | undefined) => method === 'transfer';

/**
 * 存檔前把方式與帳號對齊。
 *
 * 非匯款一律把帳號清成 null —— 使用者可能先選了匯款＋帳號，再改成現金。
 * 只把欄位藏起來而不清值的話，資料庫裡會留著一個看不見的帳號，
 * 對帳時那筆現金會出現在元大 8088 的明細裡。
 */
export function normalizeMethod(method: string, account: string | null | undefined) {
  return {
    method,
    account: needsAccount(method) ? (account || null) : null,
  };
}

/** 畫面顯示用：「匯款・元大 8088」／「現金」。 */
export function methodText(
  method: string | null | undefined,
  account: string | null | undefined,
  acctName: Record<string, string> = {},
): string {
  if (!method) return '—';
  const base = METHOD_LABEL[method] ?? method;
  if (!needsAccount(method) || !account) return base;
  return `${base}・${acctName[account] ?? account}`;
}
