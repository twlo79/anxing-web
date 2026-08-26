/**
 * 請款單的支付方式。
 *
 * ============================================================
 * 【為什麼要抽出來】（2026-08-25，加「臨櫃」與「自動繳款」時）
 *
 * 原本 `PAY_LABEL` / `PAY_OPTS` 定義在 purchases/page.tsx 裡，而
 * 「這種付款方式要不要選安幸帳號」這件事**沒有名字** ——
 * 它以字串比較的形式散在頁面各處:
 *
 *     payment_method === 'transfer' || payment_method === 'credit_card'
 *
 * 這一行在待排付款、待支付、存檔清帳號、確認出款日…出現了五、六次。
 * 多一種付款方式的時候，**漏改任何一處都不會報錯**:
 * 那張單只是安靜地不出現在待排付款清單裡，
 * 或者存檔時把剛選好的帳號清成 null。
 *
 * 所以先把「這種方式有什麼性質」變成有名字的函式，再加新的值。
 *
 *
 * ============================================================
 * 【兩種新方式】（2026-08-25 使用者:「模式仿造匯款，一樣可以選帳本」）
 *
 *   counter  臨櫃    拿現金／支票去銀行櫃檯繳（水電、稅、規費）
 *   autopay  自動繳款 銀行按期自動扣款
 *
 * 共同點是**錢從安幸某一個帳戶出去**，所以跟匯款一樣要指定
 * 安幸付款帳號 —— 不指定的話那筆錢不屬於任何帳戶，對帳時找不到。
 *
 * ★★ 但**不強制廠商收款帳號**（匯款要）。
 *    臨櫃拿的是繳費單、自動繳款是銀行對銀行 ——
 *    那兩種沒有「要匯到哪個帳號」這件事。
 *    硬性必填的話使用者只會隨便填一個，那比空著更糟:
 *    空的看得出來是沒有，填錯的看起來像真的。
 */

export const PAY_LABEL: Record<string, string> = {
  cash: '現金',
  transfer: '匯款',
  credit_card: '信用卡',
  counter: '臨櫃',
  autopay: '自動繳款',
};

/** 下拉的順序＝常用程度。臨櫃與自動繳款排在信用卡後面。 */
export const PAY_OPTS = ['cash', 'transfer', 'credit_card', 'counter', 'autopay'];

/**
 * 要不要指定「安幸付款帳號」（錢從哪個戶頭出去）。
 *
 * ★ 現金**不用** —— 現金是從手上出去的，指定一個銀行帳號
 *   會讓對帳的人以為那筆錢真的從元大 8088 匯出去了。
 */
export const needsPayout = (m: string | null | undefined) =>
  m === 'transfer' || m === 'credit_card' || m === 'counter' || m === 'autopay';

/**
 * 要不要**必填**廠商收款帳號。
 *
 * ★ 只有匯款 —— 見檔頭。臨櫃與自動繳款沒有匯款對象。
 */
export const needsPayeeAccount = (m: string | null | undefined) => m === 'transfer';

/**
 * 核可之後要先「排付款」才付得出去。
 *
 * 現金核可完就能付，其餘四種都要排 ——
 * 排付款那一步決定的是「哪一天、從哪個戶頭出」，
 * 那正是這四種共同缺的資訊。
 */
export const needsPlan = (m: string | null | undefined) => m !== 'cash' && !!m;

/**
 * 會產生匯款手續費的方式。
 *
 * ★ **只有匯款**（維持原狀，2026-08-25 沒有跟著放寬）。
 *   臨櫃可能也有手續費，但那是另一個決定 ——
 *   在這裡順手打開的話，既有的單會突然多出一筆沒有人核可過的費用。
 */
export const hasTransferFee = (m: string | null | undefined) => m === 'transfer';

/**
 * 信用卡是「刷」不是「匯」，同一個欄位在不同付款方式下要用不同說法。
 *
 * ★ 臨櫃與自動繳款都用「付款日 / 安幸付款帳號」——
 *   它們確實是從帳戶付出去的，跟匯款同一種語意。
 */
export const dateWord = (m?: string | null) => (m === 'credit_card' ? '刷卡日' : '付款日');
export const acctWord = (m?: string | null) => (m === 'credit_card' ? '刷卡卡片' : '安幸付款帳號');

/** 顯示用。認不出來就回原始值 —— 至少看得出是什麼，不會是空白。 */
export const payLabel = (m: string | null | undefined) => (m ? PAY_LABEL[m] ?? m : '—');
